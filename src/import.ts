import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { pool, transaction } from './common.js';

const headers = {
  basics: 'tconst titleType primaryTitle originalTitle isAdult startYear endYear runtimeMinutes genres',
  akas: 'titleId ordering title region language types attributes isOriginalTitle',
  episode: 'tconst parentTconst seasonNumber episodeNumber',
  ratings: 'tconst averageRating numVotes',
};
// Validate the header before forwarding any data. COPY CSV with an unused quote
// character preserves IMDb backslashes literally, including the explicit null marker.
function checkHeader(expected: string) {
  let prefix = Buffer.alloc(0);
  let checked = false;
  return new Transform({
    transform(chunk: Buffer, _, cb) {
      if (checked) return cb(null, chunk);
      prefix = Buffer.concat([prefix, chunk]);
      const end = prefix.indexOf(10);
      if (end < 0 && prefix.length < 2048) return cb();
      if (end < 0 || prefix.subarray(0, end).toString().trimEnd() !== expected.split(' ').join('\t'))
        return cb(new Error('Unexpected IMDb TSV header'));
      checked = true;
      cb(null, prefix.subarray(end + 1));
      prefix = Buffer.alloc(0);
    },
    flush(cb) {
      cb(checked ? undefined : new Error('Missing IMDb TSV header'));
    },
  });
}

export async function importCatalog(directory?: string) {
  const db = await pool.connect();
  try {
    await transaction(db, async () => {
      await db.query('SELECT pg_advisory_xact_lock(702352)');
      await db.query('CREATE SCHEMA catalog_import');
      for (const [table, header] of Object.entries(headers)) {
        const file = 'title.' + table + '.tsv';
        let source: Readable;
        if (directory) {
          const plain = join(directory, file);
          source = existsSync(plain)
            ? createReadStream(plain)
            : createReadStream(plain + '.gz').compose(createGunzip());
        } else {
          const response = await fetch('https://datasets.imdbws.com/' + file + '.gz', {
            redirect: 'error',
          });
          if (!response.ok || !response.body) throw new Error('IMDb dataset unavailable: ' + table);
          source = Readable.fromWeb(
            response.body as import('node:stream/web').ReadableStream<Uint8Array>,
          ).compose(createGunzip());
        }
        await db.query(
          'CREATE TEMP TABLE raw_' +
            table +
            ' (' +
            header
              .split(' ')
              .map((k) => k + ' text')
              .join(',') +
            ') ON COMMIT DROP',
        );
        const target = db.query(
          copyFrom(
            `COPY raw_${table} FROM STDIN WITH (FORMAT csv, DELIMITER E'\\t', QUOTE E'\\b', NULL '\\N')`,
          ),
        );
        await pipeline(source, checkHeader(header), target);
        if (!(await db.query('SELECT 1 FROM raw_' + table + ' LIMIT 1')).rowCount)
          throw new Error('Empty IMDb file: ' + table);
      }
      await db.query(await readFile('sql/publish-catalog.sql', 'utf8'));
    });
  } finally {
    db.release();
  }
}
if (import.meta.main) {
  try {
    await importCatalog(process.argv[2]);
  } finally {
    await pool.end();
  }
}
