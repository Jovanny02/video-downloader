import { chromium } from 'playwright-core';
import type { Frame, Page, Response } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type Item, numberSetting, Outcome, type Track } from './common.js';
import { type Candidate, type Observation, type Player, wrapperOrigin } from './providers/contract.js';
import { browserProxy, Network } from './media/network.js';

export const wrappers = new Map<string, string>();

function checkDocument(
  response: Response | null,
  stage: 'wrapper_navigation' | 'player_navigation',
  mode: Player['mode'],
) {
  if (!response || response.status() < 400) return;
  const httpStatus = response.status();
  const cfRay = response.headers()['cf-ray'];
  const details = {
    stage,
    mode,
    httpStatus,
    origin: new URL(response.url()).origin,
    observedAt: new Date().toISOString(),
    ...(cfRay && /^[a-f0-9]{16,32}(?:-[a-z]{3})?$/i.test(cfRay) ? { cfRay } : {}),
  };
  if ([401, 403, 451].includes(httpStatus)) throw new Outcome('UNSUPPORTED_PLAYBACK', details);
  throw new Outcome('MEDIA_UNAVAILABLE', details, httpStatus >= 500);
}

async function navigateToPlayer(page: Page, target: URL, wrapper?: URL) {
  const options = { waitUntil: 'commit' as const, timeout: 20000 };
  if (!wrapper) {
    checkDocument(await page.goto(target.href, options), 'player_navigation', 'direct');
    await page.waitForLoadState('domcontentloaded', { timeout: options.timeout });
    return;
  }
  // The child can respond before goto resolves. Follow its initial request across
  // redirects, ignoring script, media and unrelated frame responses.
  const [playerDocument] = await Promise.all([
    page.waitForResponse(
      (response) => {
        let request = response.request();
        if (!request.isNavigationRequest() || response.frame().parentFrame() !== page.mainFrame())
          return false;
        if ([301, 302, 303, 307, 308].includes(response.status())) return false;
        for (let previous = request.redirectedFrom(); previous; previous = request.redirectedFrom())
          request = previous;
        return request.url() === target.href;
      },
      { timeout: options.timeout },
    ),
    page
      .goto(wrapper.href, options)
      .then((response) => checkDocument(response, 'wrapper_navigation', 'iframe')),
  ]);
  checkDocument(playerDocument, 'player_navigation', 'iframe');
  await page.frameLocator('iframe').locator('body').waitFor({ timeout: 15000 });
}

export async function withPlayer<T>(
  adapter: Player,
  item: Item,
  signal: AbortSignal,
  use: (net: Network, sources: Candidate[], tracks: Track[]) => Promise<T>,
) {
  const target = adapter.url(item);
  const wrapper = new URL('/wrap/' + randomUUID(), wrapperOrigin());
  const wrapped = adapter.mode === 'iframe';
  const origins = new Set([
    adapter.origin,
    ...adapter.playerOrigins,
    ...adapter.mediaOrigins,
    ...(wrapped ? [wrapper.origin] : []),
  ]);
  const proxy = await browserProxy(origins);
  const browser = await chromium
    .launch({
      headless: true,
      chromiumSandbox: true,
      proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      executablePath: process.env.CHROMIUM_PATH,
    })
    .catch((e) => {
      proxy.close();
      throw e;
    });
  const abort = () => {
    void browser.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    context.on('page', (p) => {
      if (p !== page) void p.close();
    });
    const observed = new Map<Frame, Observation[]>();
    page.on('response', (r) => {
      if (!r.ok()) return;
      const f = r.frame(),
        list = observed.get(f) ?? [];
      if (list.length < 4000) list.push({ url: r.url(), mime: r.headers()['content-type'] ?? '' });
      observed.set(f, list);
    });
    await context.addInitScript(
      ({ origin }) => {
        const state = window as Window & {
          encryptedPlayback?: boolean;
          identity?: { imdb?: string; season?: number; episode?: number };
        };
        document.addEventListener(
          'encrypted',
          () => {
            state.encryptedPlayback = true;
          },
          true,
        );
        window.addEventListener('message', (event) => {
          if (
            event.origin === origin &&
            (event.source === window ||
              event.source === document.querySelector('iframe')?.contentWindow) &&
            event.data?.type === 'PLAYER_EVENT'
          )
            state.identity = event.data.data?.player_info;
        });
      },
      { origin: target.origin },
    );
    if (wrapped) wrappers.set(wrapper.pathname, target.href);
    await navigateToPlayer(page, target, wrapped ? wrapper : undefined);
    const frame = page.frames().find((f) => {
      try {
        const u = new URL(f.url());
        return u.origin === target.origin && u.pathname === target.pathname;
      } catch {
        return false;
      }
    });
    if (!frame) throw new Outcome('PLAYER_IDENTITY_UNVERIFIED');
    await adapter.start(frame);
    const deadline = Date.now() + numberSetting('DISCOVERY_MS', 6000);
    let candidates: Candidate[] = [];
    let tracks: Track[] = [];
    do {
      const state = await frame.evaluate(() => {
        const v = document.querySelector('video');
        return {
          src: v?.currentSrc ?? '',
          duration: v && Number.isFinite(v.duration) ? v.duration : undefined,
          height: v?.videoHeight,
          encrypted:
            !!v?.mediaKeys || !!(window as Window & { encryptedPlayback?: boolean }).encryptedPlayback,
          id: document.body.dataset.imdb,
          season: document.body.dataset.season,
          episode: document.body.dataset.episode,
          tracks: Array.from(
            v?.querySelectorAll<HTMLTrackElement>('track[src]:not([src=""])') ?? [],
            (t) => ({ url: t.src, language: t.srclang, label: t.label, kind: t.kind }),
          ).filter((t) => t.url !== 'data:,WEBVTT'),
        };
      });
      const identity = await page.evaluate(
        () =>
          (window as Window & { identity?: { imdb?: string; season?: number; episode?: number } })
            .identity,
      );
      if (state.encrypted) throw new Outcome('UNSUPPORTED_PLAYBACK');
      if (
        (state.id && state.id !== item.title.imdbId && state.id !== item.parent.imdbId) ||
        (state.season !== undefined && Number(state.season) !== item.season) ||
        (state.episode !== undefined && Number(state.episode) !== item.episode) ||
        (identity?.imdb &&
          identity.imdb !== item.parent.imdbId &&
          identity.imdb !== item.title.imdbId) ||
        (identity?.season != null && Number(identity.season) !== item.season) ||
        (identity?.episode != null && Number(identity.episode) !== item.episode)
      )
        throw new Outcome('PLAYER_IDENTITY_MISMATCH');
      candidates = adapter.identify(item, observed.get(frame) ?? [], state.src);
      for (const source of candidates)
        if (source.url === state.src) {
          source.duration = state.duration;
          source.height = state.height;
        }
      tracks = state.tracks;
      if (Date.now() < deadline) await delay(150, undefined, { signal });
    } while (Date.now() < deadline);
    if (!candidates.length) throw new Outcome('NO_TRUSTED_MEDIA', {}, true);
    const net = new Network(new Set(adapter.mediaOrigins), signal, async (url) => {
      const cookies = await context.cookies(url);
      return { Referer: target.href, Cookie: cookies.map((c) => c.name + '=' + c.value).join('; ') };
    });
    return await use(net, candidates, [...tracks, ...((await adapter.tracks?.(frame)) ?? [])]);
  } finally {
    wrappers.delete(wrapper.pathname);
    signal.removeEventListener('abort', abort);
    try {
      await browser.close();
    } finally {
      proxy.close();
    }
  }
}
