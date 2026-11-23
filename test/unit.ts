import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleVtt, english } from '../src/media/subtitles.js';
import { parse, validateVod } from '../src/media/hls.js';
import { providers } from '../src/providers/index.js';
import type { Item, Episode } from '../src/common.js';
import { expand } from '../src/catalog.js';
import { Network } from '../src/media/network.js';

test('provider routes use canonical series ID and real coordinates', () => {
  const i = { title: { imdbId: 'tt2' }, parent: { imdbId: 'tt1' }, season: 0, episode: 3 } as Item;
  for (const [key, path, param] of [
    ['vidsrc', '/embed/tv/tt1/0/3', 'ds_lang'],
    ['vidfast', '/tv/tt1/0/3', 'sub'],
  ]) {
    const p = providers.get(key)!;
    assert.equal(p.url(i).pathname, path);
    assert.equal(p.url(i).searchParams.get(param), 'en');
    assert.equal(
      p.url({ ...i, season: null, episode: null }).pathname,
      path.replace('tv/tt1/0/3', 'movie/tt1'),
    );
    const src = p.origin + '/movie.mp4',
      seen = [
        { url: src, mime: 'video/mp4' },
        { url: p.origin + '/ad.mp4', mime: 'video/mp4' },
      ];
    assert.deepEqual(p.identify(i, seen, src), [{ url: src, kind: 'mp4' }]);
    assert.deepEqual(p.identify(i, seen, ''), []);
  }
});
test('discontinuities and adjacent duplicate mapped cues', () => {
  const part = (text: string, mpeg: number, timeline: number, elapsed: number) => ({
    text:
      'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:' +
      mpeg +
      '\n\n00:00:00.000 --> 00:00:01.200\n' +
      text,
    timeline,
    elapsed,
  });
  const text = assembleVtt(
    [part('One', 90000, 0, 0), part('One', 90000, 0, 1), part('Two', 900000, 1, 2)],
    new Map([
      [0, { elapsed: 0, pts: 1 }],
      [1, { elapsed: 2, pts: 10 }],
    ]),
  );
  assert.equal(text.match(/-->/g)?.length, 2);
  assert.match(text, /00:00:02.000 --> 00:00:03.200\nTwo/);
  assert.ok(english({ url: '', label: 'English CC' }));
  assert.ok(!english({ url: '', language: 'fr', label: 'English' }));
});
test('unsigned and encrypted destinations and non-VOD playlists are rejected', () => {
  const net = new Network(new Set(['https://media.example']), new AbortController().signal);
  for (const url of [
    'http://media.example',
    'https://media.example.evil',
    'file:///etc/passwd',
    'https://u:p@media.example',
  ])
    assert.throws(() => net.check(url));
  assert.throws(() => parse('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"'));
  assert.throws(() => validateVod(parse('#EXTM3U\n#EXTINF:1,\ns.ts')));
});
test('catalog numbering includes zero, whole seasons and conflicting records', () => {
  const row = { season: 0, episode: 0, imdbId: 'tt1' } as Episode;
  const input = { title: 'A', seasons: [{ season: 0 }] };
  assert.deepEqual(expand(input, [row], 1), [row]);
  assert.throws(() => expand(input, [row, row], 10), /CONFLICTING_EPISODES/);
});

test('subscribed catalog search filters by year, normalizes names and follows episode cursors', async (t) => {
  const { DataExchangeClient } = await import('@aws-sdk/client-dataexchange');
  const { graphCatalog } = await import('../src/graphql.js');
  const client = new DataExchangeClient({ region: 'us-east-1' });
  const entity = {
    id: 'tt1',
    titleText: { text: 'An Example' },
    titleType: { id: 'movie' },
    releaseYear: { year: 2024 },
  };
  t.mock.method(
    client,
    'send',
    async (command: { input: { Body: string; Path: string; Method: string } }) => {
      assert.equal(command.input.Path, '/v1');
      assert.equal(command.input.Method, 'POST');
      const { variables, query } = JSON.parse(command.input.Body);
      const page = (edges: unknown[], more = false) => ({
        edges,
        pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null },
      });
      let data;
      if (query.includes('mainSearch'))
        data = {
          mainSearch: page(
            variables.exact
              ? []
              : [
                  { node: { entity } },
                  { node: { entity: { ...entity, id: 'tt2', releaseYear: { year: 2020 } } } },
                ],
          ),
        };
      else if (query.includes('episodes(first:'))
        data = {
          title: {
            episodes: {
              episodes: page(
                [
                  {
                    node: {
                      ...entity,
                      id: variables.after ? 'tt3' : 'tt2',
                      series: {
                        episodeNumber: { seasonNumber: 1, episodeNumber: variables.after ? 2 : 1 },
                      },
                    },
                  },
                ],
                !variables.after,
              ),
            },
          },
        };
      else data = { title: entity };
      return { Body: JSON.stringify({ data }) };
    },
  );
  const catalog = graphCatalog(client);
  assert.deepEqual(
    (await catalog.search({ title: 'An.Example', year: 2024 })).map((x) => [x.imdbId, x.exact]),
    [['tt1', true]],
  );
  assert.equal((await catalog.details('tt1'))?.year, 2024);
  assert.deepEqual(
    (await catalog.episodes('tt1', [1])).map((e) => e.episode),
    [1, 2],
  );
  client.destroy();
});
