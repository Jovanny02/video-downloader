import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, rm, writeFile, cp, mkdir, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { createServer, type AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { run } from 'graphile-worker';

test(
  'REST and SQL through two queue consumers to validated media and recovered artifacts',
  { timeout: 180000 },
  async (t) => {
    assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL to a PostgreSQL login with CREATEDB');
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const name = 'vod_test_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE ' + name);
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/' + name;
    process.env.DATABASE_URL = url.href;
    const tmp = await mkdtemp(join(tmpdir(), 'vod-test-'));
    process.env.OUTPUT_ROOT = tmp;
    process.env.PROVIDER_KEY = 'fixture';
    process.env.METADATA_BACKEND = 'dataset';
    process.env.FIXTURE_CATALOG = 'true';
    process.env.MAX_ITEMS = '4';
    process.env.DISCOVERY_MS = '900';
    const freePort = createServer().listen(0, '127.0.0.1');
    await once(freePort, 'listening');
    process.env.PLAYER_PORT = String((freePort.address() as AddressInfo).port);
    await new Promise<void>((done) => freePort.close(() => done()));
    process.env.API_TOKENS = JSON.stringify({ first: 'first-test-token', second: 'second-test-token' });
    process.env.WRAPPER_ORIGIN = 'http://127.0.0.1:' + (process.env.PLAYER_PORT ?? '8091');
    process.env.FIXTURE_ORIGIN = process.env.WRAPPER_ORIGIN;
    process.env.FIXTURE_MODE = 'iframe';
    const { pool, Outcome } = await import('../src/common.js');
    t.after(async () => {
      await pool.end();
      await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
      await admin.end();
      await rm(tmp, { recursive: true, force: true });
    });
    const { migrate } = await import('../src/migrate.js');
    await migrate();
    await migrate();
    const { tasks } = await import('../src/jobs.js');
    const { publish } = await import('../src/storage.js');
    const { startPlayerHost } = await import('../src/fixture.js');
    const close = await startPlayerHost();
    const { providers } = await import('../src/providers/index.js');
    const { buildApi } = await import('../src/api.js');
    const app = buildApi();
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const post = (path: string, body: object, key?: string) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          authorization: 'Bearer first-test-token',
          'content-type': 'application/json',
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: JSON.stringify(body),
      });
    async function status(id: string, wanted: string[]) {
      let last;
      for (let i = 0; i < 400; i++) {
        const r = await fetch(base + '/jobs/' + id, {
          headers: { authorization: 'Bearer first-test-token' },
        });
        last = await r.json();
        if (wanted.includes(last.status)) return last;
        if (['completed', 'failed', 'partial', 'needs_selection'].includes(last.status)) break;
        await sleep(100);
      }
      assert.fail('Unexpected job state ' + JSON.stringify(last));
    }
    async function submit(body: object, key?: string) {
      const r = await post('/jobs', body, key);
      assert.equal(r.status, 202, await r.clone().text());
      const { jobId } = await r.json();
      assert.equal(r.headers.get('location'), '/jobs/' + jobId);
      return jobId as string;
    }
    // Inject failures at the network boundary and immediately after rename.
    const visits = new Map<string, number>();
    const list = tasks(async (item, signal, progress) => {
      if (item.season === 0) throw new Outcome('MEDIA_UNAVAILABLE');
      const n = visits.get(item.id) ?? 0;
      visits.set(item.id, n + 1);
      if (item.provider === 'fixture' && item.title.imdbId === 'tt9900001' && n === 0)
        throw new Outcome('TEMPORARY_UPSTREAM', {}, true);
      const m = await publish(item, signal, progress);
      if (item.provider === 'fixture' && item.title.imdbId === 'tt9900001' && n === 1)
        throw new Outcome('INTERRUPTED_AFTER_RENAME', {}, true);
      return m;
    });
    const runners = await Promise.all(
      [1, 2].map(() =>
        run({
          connectionString: url.href,
          taskList: list,
          concurrency: 1,
          pollInterval: 100,
          noHandleSignals: true,
        }),
      ),
    );
    try {
      for (const invalid of [
        { title: 'X', seasons: [] },
        { title: 'X', seasons: [{ season: 1, episodes: [] }] },
        { title: 'X', extra: 1 },
        { title: '   ' },
      ]) {
        assert.equal((await post('/jobs', invalid)).status, 400);
        await assert.rejects(pool.query('SELECT submit_download($1)', [invalid]));
      }
      const fixture = providers.get('fixture')!;
      fixture.mode = 'direct';
      const ids = await Promise.all([
        submit({ title: 'Example Movie' }, 'a'),
        submit({ title: 'example movie' }, 'a'),
      ]);
      assert.equal(ids[0], ids[1]);
      assert.equal((await post('/jobs', { title: 'Another' }, 'a')).status, 409);
      const movie = await status(ids[0], ['completed']);
      const video = movie.items[0];
      assert.equal(movie.metadata.imdbId, 'tt9900001');
      assert.equal(video.attempts, 3);
      assert.equal(video.subtitles.status, 'completed');
      assert.deepEqual(
        video.artifacts
          .filter((a: { type: string }) => a.type === 'subtitle')
          .map((a: { kind: string }) => a.kind)
          .sort(),
        ['forced', 'normal', 'sdh'],
      );
      for (const a of video.artifacts) assert.ok((await stat(join(tmp, a.path))).size);
      assert.deepEqual(
        video.history.map((h: { status: string }) => h.status),
        ['retrying', 'retrying', 'completed'],
      );
      assert.equal((await fetch(base + '/jobs/' + ids[0])).status, 401);
      const second = await fetch(base + '/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer second-test-token',
          'content-type': 'application/json',
          'idempotency-key': 'a',
        },
        body: JSON.stringify({ title: 'qzxqzxqzx' }),
      });
      assert.equal(second.status, 202);
      assert.notEqual((await second.json()).jobId, ids[0]);
      fixture.mode = 'iframe';
      const batch = (
        await pool.query('SELECT submit_download($1) id', [
          {
            title: 'Example Series',
            seasons: [
              { season: 1, episodes: [3, 1, 1] },
              { season: 1, episodes: [2] },
            ],
          },
        ])
      ).rows[0].id;
      const series = await status(batch, ['completed']);
      assert.equal(series.counts.completed, 3);
      assert.deepEqual(
        series.items.map((i: { episode: number }) => i.episode),
        [1, 2, 3],
      );
      assert.deepEqual(
        series.items.map((i: { subtitles: { status: string } }) => i.subtitles.status),
        ['completed', 'not_available', 'failed'],
        JSON.stringify(series.items.map((i: { subtitles: unknown }) => i.subtitles)),
      );
      const side = series.items[0].artifacts.find((a: { type: string }) => a.type === 'subtitle');
      const cues = await readFile(join(tmp, side.path), 'utf8');
      assert.equal(cues.match(/-->/g)?.length, 1);
      assert.match(cues, /00:00:00.250 --> 00:00:01.200/);
      const whole = await status(await submit({ title: 'Example Series', seasons: [{ season: 2 }] }), [
        'completed',
      ]);
      assert.deepEqual(
        whole.items.map((i: { imdbId: string }) => i.imdbId),
        ['tt9900014', 'tt9900015'],
      );
      const mixed = await status(
        await submit({
          title: 'Example Series',
          seasons: [{ season: 0 }, { season: 1, episodes: [2] }],
        }),
        ['partial'],
      );
      assert.deepEqual(mixed.counts, { total: 2, completed: 1, failed: 1, pending: 0 });
      const missing = await status(
        await submit({ title: 'Example Series', seasons: [{ season: 1, episodes: [1, 9] }] }),
        ['failed'],
      );
      assert.deepEqual(missing.error.missing, [{ season: 1, episode: 9 }]);
      assert.equal(missing.counts.total, 0);
      const limit = await status(
        await submit({ title: 'Example Series', seasons: [{ season: 1 }, { season: 2 }] }),
        ['failed'],
      );
      assert.equal(limit.error.cap, 4);
      const ambiguous = await submit({ title: 'Shared Name' });
      const choices = await status(ambiguous, ['needs_selection']);
      assert.equal(choices.candidates.length, 2);
      assert.equal(choices.counts.total, 0);
      await assert.rejects(pool.query('SELECT select_download($1,$2)', [ambiguous, 'tt0000000']));
      assert.equal(
        (await post('/jobs/' + ambiguous + '/selection', { imdbId: 'tt0000000' })).status,
        409,
      );
      const selected = choices.candidates[0].imdbId;
      await pool.query('SELECT select_download($1,$2)', [ambiguous, selected]);
      assert.equal((await post('/jobs/' + ambiguous + '/selection', { imdbId: selected })).status, 202);
      assert.equal((await status(ambiguous, ['completed'])).metadata.imdbId, selected);
      assert.equal(
        (await status(await submit({ title: 'qzxqzxqzx' }), ['failed'])).error.code,
        'TITLE_NOT_FOUND',
      );
      // New submissions snapshot the active provider. A queued selection keeps its original one.
      const pinned = await submit({ title: 'Shared Name' });
      await status(pinned, ['needs_selection']);
      let altStarts = 0;
      providers.set('fixture-alternate', {
        ...fixture,
        key: 'fixture-alternate',
        start: async (f) => {
          altStarts++;
          await fixture.start(f);
        },
      });
      process.env.PROVIDER_KEY = 'fixture-alternate';
      await migrate();
      const alternate = await status(await submit({ title: 'The Example' }), ['completed']);
      assert.equal(alternate.provider, 'fixture-alternate');
      assert.equal(altStarts, 1);
      await pool.query('SELECT select_download($1,$2)', [pinned, selected]);
      assert.equal((await status(pinned, ['completed'])).provider, 'fixture');

      const deniedRequests: (string | undefined)[] = [];
      const ray = '0123456789abcdef-IAD';
      const deniedHost = createHttpServer((req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/denied?signed=fixture-secret' }).end();
          return;
        }
        deniedRequests.push(req.headers['sec-fetch-dest']);
        res
          .writeHead(403, {
            'content-type': 'text/html',
            'cf-ray': req.url?.startsWith('/denied?') ? 'fixture-secret' : ray,
            'set-cookie': 'session=fixture-secret',
          })
          .end('<title>Attention Required! | Cloudflare</title><body hidden>Access denied</body>');
      }).listen(0, '127.0.0.1');
      await once(deniedHost, 'listening');
      const deniedOrigin = 'http://127.0.0.1:' + (deniedHost.address() as AddressInfo).port;
      try {
        for (const mode of ['direct', 'iframe'] as const) {
          await t.test(mode + ' player document denial is terminal before playback', async () => {
            let starts = 0;
            const key = 'fixture-denied-' + mode;
            providers.set(key, {
              ...fixture,
              key,
              mode,
              origin: deniedOrigin,
              playerOrigins: [deniedOrigin],
              mediaOrigins: [deniedOrigin],
              url: () => new URL(mode === 'direct' ? '/denied' : '/redirect', deniedOrigin),
              start: async () => {
                starts++;
              },
            });
            process.env.PROVIDER_KEY = key;
            await migrate();
            const job = await status(await submit({ title: 'Example Movie' }), ['failed']);
            assert.deepEqual(job.counts, { total: 1, pending: 0, completed: 0, failed: 1 });
            const [item] = job.items;
            assert.equal(item.status, 'failed');
            assert.equal(item.attempts, 1);
            assert.equal(item.history.length, 1);
            assert.equal(item.history[0].status, 'failed');
            assert.deepEqual(item.history[0].error, item.error);
            const { observedAt, ...diagnostics } = item.error;
            assert.equal(new Date(observedAt).toISOString(), observedAt);
            assert.deepEqual(diagnostics, {
              code: 'UNSUPPORTED_PLAYBACK',
              stage: 'player_navigation',
              httpStatus: 403,
              mode,
              origin: deniedOrigin,
              ...(mode === 'direct' ? { cfRay: ray } : {}),
            });
            assert.equal(starts, 0);
            assert.equal(item.progress, null);
            assert.deepEqual(item.artifacts, []);
            await assert.rejects(stat(join(tmp, job.jobId, item.id)), { code: 'ENOENT' });
          });
        }
        assert.deepEqual(deniedRequests, ['document', 'iframe']);
      } finally {
        deniedHost.closeAllConnections();
        await new Promise<void>((done) => deniedHost.close(() => done()));
      }
      // A failed refresh rolls back without losing the last published catalog.
      const { importCatalog } = await import('../src/import.js');
      const compressed = join(tmp, 'compressed');
      await mkdir(compressed);
      for (const file of await readdir('fixtures/catalog')) {
        await writeFile(
          join(compressed, file + '.gz'),
          gzipSync(await readFile(join('fixtures/catalog', file))),
        );
      }
      await importCatalog(compressed);
      const bad = join(tmp, 'bad');
      await cp('fixtures/catalog', bad, { recursive: true });
      await writeFile(join(bad, 'title.ratings.tsv'), 'invalid');
      await assert.rejects(importCatalog(bad));
      assert.equal((await pool.query('SELECT count(*) n FROM catalog.titles')).rows[0].n, '10');
    } finally {
      await Promise.all(runners.map((r) => r.stop()));
      await app.close();
      await close();
    }
  },
);

test('browser redirects and nested HLS segment URLs obey the exact-origin policy', async (t) => {
  const http = await import('node:http');
  const { chromium } = await import('playwright-core');
  const { Network, browserProxy } = await import('../src/media/network.js');
  const { hls, localPlaylist } = await import('../src/media/hls.js');
  let blockedHits = 0;
  async function listen(handler: import('node:http').RequestListener) {
    const server = http.createServer(handler).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  }
  const blocked = await listen((_, res) => {
    blockedHits++;
    res.end('off-origin');
  });
  const allowed = await listen((req, res) => {
    if (req.url === '/playlist')
      res.end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n' + blocked + '/segment.ts\n#EXT-X-ENDLIST\n',
      );
    else res.writeHead(302, { location: blocked + '/redirected' }).end();
  });
  const origins = new Set([allowed]),
    net = new Network(origins, AbortSignal.timeout(15000));
  await assert.rejects(net.get(allowed), /DESTINATION_DENIED/);
  const list = await hls(net, allowed + '/playlist');
  const dir = await mkdtemp(join(tmpdir(), 'vod-policy-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(localPlaylist(net, list.video, list.base, dir, 'video'), /DESTINATION_DENIED/);
  const proxy = await browserProxy(origins);
  try {
    const browser = await chromium.launch({
      chromiumSandbox: true,
      proxy: { server: proxy.url, bypass: '<-loopback>' },
    });
    try {
      const page = await browser.newPage();
      const response = await page.goto(allowed);
      assert.equal(response?.status(), 403);
    } finally {
      await browser.close();
    }
  } finally {
    proxy.close();
  }
  assert.equal(blockedHits, 0);
});
