import { parse } from 'mpd-parser';
import { Outcome, type Track } from '../common.js';
import { type Renditions, validateVod } from './hls.js';
import type { Network } from './network.js';

export async function dash(net: Network, url: string): Promise<Renditions> {
  const manifest = await net.text(url);
  if (
    !/<MPD\b/.test(manifest.text) ||
    /<(?:[\w.-]+:)?ContentProtection\b|<!DOCTYPE|\btype\s*=\s*["']dynamic["']/i.test(manifest.text)
  )
    throw new Outcome('UNSUPPORTED_PLAYBACK');
  const parsed = parse(manifest.text, { manifestUri: manifest.url });
  const video = parsed.playlists?.sort(
    (a, b) => Number(b.attributes?.BANDWIDTH ?? 0) - Number(a.attributes?.BANDWIDTH ?? 0),
  )[0];
  if (!video) throw new Outcome('MEDIA_UNAVAILABLE');
  validateVod(video);
  const group = (type: string) =>
    Object.entries(parsed.mediaGroups?.[type]?.[String(video.attributes?.[type])] ?? {});
  const audioTracks = group('AUDIO').map(([, r]) => r);
  const audio = (audioTracks.find((r) => r.default) ?? audioTracks[0])?.playlists?.[0];
  const tracks: Track[] = group('SUBTITLES').map(([label, r]) => {
    const segments = r.playlists?.[0]?.segments;
    const segment = segments?.length === 1 ? segments[0] : undefined;
    return {
      label,
      language: r.language,
      kind: r.forced ? 'forced' : undefined,
      url: segment?.resolvedUri ?? r.uri ?? '',
      unsupported: !segment || !!segment.map,
    };
  });
  return { video, audio, tracks, base: manifest.url, audioBase: manifest.url };
}
