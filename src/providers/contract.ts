import type { Frame } from 'playwright-core';
import type { Item, Track } from '../common.js';
import { Outcome } from '../common.js';

export interface Candidate {
  kind: 'mp4' | 'hls' | 'dash' | 'probe';
  url: string;
  duration?: number;
  height?: number;
}
export interface Observation {
  url: string;
  mime: string;
}
export interface Player {
  key: string;
  origin: string;
  playerOrigins: string[];
  mediaOrigins: string[];
  mode: 'direct' | 'iframe';
  url(item: Item): URL;
  start(frame: Frame): Promise<void>;
  identify(item: Item, observations: Observation[], currentSrc: string): Candidate[];
  tracks?(frame: Frame): Promise<Track[]>;
}
export function wrapperOrigin() {
  return process.env.WRAPPER_ORIGIN ?? 'http://127.0.0.1:8091';
}
export function routePath(item: Item) {
  const id = item.parent.imdbId;
  if (!/^tt\d+$/.test(id)) throw new Outcome('INVALID_IMDB_ID');
  return item.season === null ? '/movie/' + id : '/tv/' + id + '/' + item.season + '/' + item.episode;
}
export async function clickPlay(frame: Frame) {
  const button = frame.getByRole('button', { name: /^(play|play video|start playback)$/i }).first();
  await button.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  if (await button.isVisible()) await button.click({ timeout: 3000 });
}
export function player(
  key: string,
  defaultOrigin: string,
  build: (item: Item) => string,
  start = clickPlay,
): Player {
  const prefix = key.toUpperCase();
  const origin = new URL(process.env[prefix + '_ORIGIN'] ?? defaultOrigin).origin;
  const mediaOrigins = (process.env[prefix + '_MEDIA_ORIGINS'] ?? origin)
    .split(',')
    .map((x) => new URL(x.trim()).origin);
  const playerOrigins = (process.env[prefix + '_PLAYER_ORIGINS'] || origin)
    .split(',')
    .map((x) => new URL(x.trim()).origin);
  const mode = process.env[prefix + '_MODE'] ?? 'iframe';
  if (mode !== 'direct' && mode !== 'iframe') throw new Error('Invalid navigation mode');
  if (
    key !== 'fixture' &&
    [origin, ...mediaOrigins, ...playerOrigins].some((x) => !x.startsWith('https://'))
  )
    throw new Error('Provider origins require HTTPS');
  return {
    key,
    origin,
    playerOrigins,
    mediaOrigins,
    mode,
    url: (item) => new URL(build(item), origin),
    start,
    identify(item, observations, currentSrc) {
      // A blob player needs a deployment-specific title-bound CDN path.
      // Unrelated resources from an otherwise trusted CDN are insufficient.
      const template = process.env[prefix + '_MEDIA_PREFIX'];
      const path = template
        ?.replaceAll('{id}', item.title.imdbId)
        .replaceAll('{series}', item.parent.imdbId)
        .replaceAll('{season}', String(item.season))
        .replaceAll('{episode}', String(item.episode));
      const bound =
        template?.includes('{id}') ||
        (template?.includes('{series}') &&
          (item.season === null || (template.includes('{season}') && template.includes('{episode}'))));
      const seen = new Set<string>();
      const candidates: Candidate[] = [];
      for (const { url, mime } of observations) {
        const u = new URL(url);
        if (
          !mediaOrigins.includes(u.origin) ||
          /(^|[/. _-])(ad[s]?|preview|trailer)([/. _-]|$)/i.test(u.pathname)
        )
          continue;
        const fixturePath = '/fixture/media/' + item.title.imdbId + '/';
        if (
          url !== currentSrc &&
          !(key === 'fixture' && u.pathname.startsWith(fixturePath)) &&
          !(bound && path?.endsWith('/') && u.pathname.startsWith(path))
        )
          continue;
        const kind =
          /mpegurl/i.test(mime) || /\.m3u8$/i.test(u.pathname)
            ? 'hls'
            : /dash\+xml/i.test(mime) || /\.mpd$/i.test(u.pathname)
              ? 'dash'
              : /video\/mp4/i.test(mime) || /\.mp4$/i.test(u.pathname)
                ? 'mp4'
                : url === currentSrc
                  ? 'probe'
                  : null;
        if (kind && !seen.has(url)) {
          seen.add(url);
          candidates.push({ kind, url });
        }
      }
      return candidates;
    },
  };
}
