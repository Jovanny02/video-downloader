import type { PoolClient } from 'pg';
import type { JobHelpers, TaskList } from 'graphile-worker';
import {
  pool,
  transaction,
  Outcome,
  type Input,
  type Item,
  type Manifest,
  type Episode,
  numberSetting,
} from './common.js';
import { expand, localCatalog, typesFor } from './catalog.js';
import { graphCatalog } from './graphql.js';
import { publish } from './storage.js';

async function locked(id: string, fn: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,742))', [id]);
    await fn(db);
  } finally {
    try {
      await db.query('SELECT pg_advisory_unlock(hashtextextended($1,742))', [id]);
    } finally {
      db.release();
    }
  }
}
function failure(e: unknown, fallback: string) {
  return e instanceof Outcome ? e : new Outcome(fallback, {}, true);
}
function retry(e: Outcome, h: JobHelpers) {
  return e.retryable && h.job.attempts < h.job.max_attempts;
}
async function resolveTitle(id: string, h: JobHelpers) {
  await locked(id, async (db) => {
    const {
      rows: [r],
    } = await db.query(
      "UPDATE requests SET status='resolving',error=NULL WHERE id=$1 AND status IN ('queued','resolving') RETURNING *",
      [id],
    );
    if (!r) return;
    try {
      await transaction(
        db,
        async () => {
          const catalog = process.env.METADATA_BACKEND === 'graphql' ? graphCatalog() : localCatalog(db);
          const input: Input = r.input;
          let titleId: string | undefined = r.selected_id;
          if (!titleId) {
            const matches = await catalog.search(input);
            if (!matches.length) throw new Outcome('TITLE_NOT_FOUND');
            if (matches.length !== 1 || !matches[0].exact) {
              const candidates = matches.map(({ imdbId, title, type, year }) => ({
                imdbId,
                title,
                type,
                year,
              }));
              await db.query("UPDATE requests SET status='needs_selection',candidates=$2 WHERE id=$1", [
                id,
                JSON.stringify(candidates),
              ]);
              return;
            }
            titleId = matches[0].imdbId;
          }
          const title = await catalog.details(titleId);
          if (
            !title ||
            !typesFor(input).includes(title.type) ||
            (input.year !== undefined && input.year !== title.year)
          )
            throw new Outcome('TITLE_NOT_FOUND');
          await db.query('UPDATE requests SET metadata=$2 WHERE id=$1', [id, title]);
          let items;
          try {
            items = input.seasons
              ? expand(
                  input,
                  await catalog.episodes(
                    titleId,
                    input.seasons.map((s) => s.season),
                  ),
                  r.item_cap,
                )
              : [title];
          } catch (e) {
            if (!(e instanceof Outcome)) throw e;
            await db.query("UPDATE requests SET status='failed',error=$2 WHERE id=$1", [id, e.toJSON()]);
            return;
          }
          for (const item of items) {
            const { season, episode } = item as Episode;
            const result = await db.query(
              'INSERT INTO download_items(request_id,imdb_title_id,metadata,season,episode) VALUES($1,$2,$3,$4,$5) RETURNING id',
              [id, item.imdbId, item, season ?? null, episode ?? null],
            );
            await db.query("SELECT graphile_worker.add_job('download_item',$1::json,max_attempts:=$2)", [
              result.rows[0],
              r.max_attempts,
            ]);
          }
          await db.query("UPDATE requests SET status='processing',candidates='[]' WHERE id=$1", [id]);
        },
        'ISOLATION LEVEL REPEATABLE READ',
      );
    } catch (error) {
      const e = failure(error, 'METADATA_UNAVAILABLE'),
        again = retry(e, h);
      await db.query('UPDATE requests SET status=$2,error=$3 WHERE id=$1', [
        id,
        again ? 'queued' : 'failed',
        e.toJSON(),
      ]);
      if (again) throw new Error(e.code);
    }
  });
}
async function summarize(db: PoolClient, id: string) {
  // Serialize sibling finalizations, then take a fresh READ COMMITTED snapshot.
  await db.query('SELECT id FROM requests WHERE id=$1 FOR UPDATE', [id]);
  await db.query(
    `UPDATE requests SET status=(SELECT CASE WHEN bool_or(status NOT IN ('failed','completed')) THEN 'processing'
    WHEN bool_and(status='completed') THEN 'completed' WHEN bool_and(status='failed') THEN 'failed' ELSE 'partial' END
    FROM download_items WHERE request_id=$1) WHERE id=$1`,
    [id],
  );
}
async function finalize(db: PoolClient, item: Item, m: Manifest) {
  await transaction(db, async () => {
    for (const a of m.artifacts)
      await db.query(
        'INSERT INTO artifacts(item_id,path,type,format,language,kind) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [item.id, a.path, a.type, a.format, a.language, a.kind],
      );
    await db.query(
      "UPDATE download_items SET status='completed',subtitles=$2,warnings=$3,error=NULL WHERE id=$1",
      [item.id, m.subtitles, JSON.stringify(m.warnings)],
    );
    await db.query(
      "UPDATE item_attempts SET status='completed',finished_at=now() WHERE item_id=$1 AND status='processing'",
      [item.id],
    );
    await summarize(db, item.requestId);
  });
}
export function tasks(publisher = publish): TaskList {
  return {
    resolve_title: async (payload, h) => resolveTitle((payload as { id: string }).id, h),
    download_item: async (payload, h) => {
      const { id } = payload as { id: string };
      await locked(id, async (db) => {
        const item = await transaction(db, async () => {
          const {
            rows: [item],
          } = await db.query<Item & { attempts: number }>(
            `UPDATE download_items d SET status='processing',progress=NULL,error=NULL,attempts=d.attempts+1 FROM requests r
          WHERE d.id=$1 AND r.id=d.request_id AND d.status NOT IN ('failed','completed')
          RETURNING d.id,d.attempts,r.id AS "requestId",r.provider,r.metadata parent,d.metadata title,d.season,d.episode`,
            [id],
          );
          if (item) {
            await db.query(
              "UPDATE item_attempts SET status='interrupted',finished_at=now() WHERE item_id=$1 AND status='processing'",
              [id],
            );
            await db.query(
              "INSERT INTO item_attempts(item_id,number,status) VALUES($1,$2,'processing')",
              [id, item.attempts],
            );
          }
          return item;
        });
        if (!item) return;
        const signal = AbortSignal.any([
          h.abortSignal,
          AbortSignal.timeout(numberSetting('ATTEMPT_TIMEOUT_MS', 7200000)),
        ]);
        let manifest;
        try {
          manifest = await publisher(item, signal, async (done, total, unit) => {
            await db.query('UPDATE download_items SET progress=$2 WHERE id=$1', [
              id,
              { done, total, unit },
            ]);
          });
        } catch (error) {
          const e = failure(error, 'DOWNLOAD_FAILED'),
            again = retry(e, h);
          await transaction(db, async () => {
            await db.query('UPDATE download_items SET status=$2,error=$3 WHERE id=$1', [
              id,
              again ? 'retrying' : 'failed',
              e.toJSON(),
            ]);
            await db.query(
              "UPDATE item_attempts SET status=$2,error=$3,finished_at=now() WHERE item_id=$1 AND status='processing'",
              [id, again ? 'retrying' : 'failed', e.toJSON()],
            );
            if (!again) await summarize(db, item.requestId);
          });
          if (again) throw new Error(e.code);
          return;
        }
        await finalize(db, item, manifest);
      });
    },
  };
}
