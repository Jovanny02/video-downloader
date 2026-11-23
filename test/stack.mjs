import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.API_URL ?? 'http://127.0.0.1:3000';
const output = process.env.OUTPUT_DIR ?? 'output';
const headers = { 'content-type': 'application/json' };
if (process.env.API_TOKEN) headers.authorization = 'Bearer ' + process.env.API_TOKEN;
async function complete(input) {
  const r = await fetch(base + '/jobs', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(r.status, 202, await r.clone().text());
  const { jobId } = await r.json();
  const deadline = Date.now() + 120000;
  let job;
  while (Date.now() < deadline) {
    job = await (await fetch(base + '/jobs/' + jobId, { headers })).json();
    assert.equal(job.provider, 'fixture', 'Run this smoke test with PROVIDER_KEY=fixture');
    if (job.status === 'completed') break;
    assert.ok(['queued', 'resolving', 'processing'].includes(job.status), JSON.stringify(job));
    await delay(250);
  }
  assert.equal(job.status, 'completed', JSON.stringify(job));
  for (const item of job.items) {
    assert.equal(item.status, 'completed');
    const m = JSON.parse(await readFile(join(output, jobId, item.id, 'manifest.json'), 'utf8'));
    assert.equal(m.itemId, item.id);
    assert.deepEqual(m.artifacts.map((a) => a.path).sort(), item.artifacts.map((a) => a.path).sort());
    for (const a of item.artifacts) assert.ok((await stat(join(output, a.path))).size > 0);
  }
  return job;
}
const movie = await complete({ title: 'Example Movie' });
assert.equal(movie.counts.total, 1);
assert.equal(movie.items[0].artifacts.filter((a) => a.type === 'subtitle').length, 3);
const series = await complete({
  title: 'Example Series',
  seasons: [
    { season: 1, episodes: [1] },
    { season: 2, episodes: [1] },
  ],
});
assert.deepEqual(
  series.items.map((i) => i.imdbId),
  ['tt9900011', 'tt9900014'],
);
console.log('Verified MP4, HLS and DASH artifacts for fixture jobs', movie.jobId, series.jobId);
