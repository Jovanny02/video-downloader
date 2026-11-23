import { Parser } from 'm3u8-parser';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Outcome, type Track } from '../common.js';
import { download, probe, type ByteRange, type Progress } from './files.js';
import type { Network } from './network.js';
export interface Resource {
  uri: string;
  resolvedUri?: string;
  byterange?: ByteRange;
}
export interface Segment extends Resource {
  duration: number;
  timeline: number;
  discontinuity?: boolean;
  map?: Resource;
  key?: unknown;
}
interface Rendition {
  uri?: string;
  language?: string;
  default?: boolean;
  forced?: boolean;
  characteristics?: string;
  playlists?: Playlist[];
}
export interface Playlist {
  uri?: string;
  attributes?: Record<string, string | number>;
  segments: Segment[];
  playlists?: Playlist[];
  endList?: boolean;
  mediaSequence?: number;
  contentProtection?: unknown;
  sidx?: unknown;
  mediaGroups?: Record<string, Record<string, Record<string, Rendition>>>;
}
export function parse(text: string) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Outcome('INVALID_MANIFEST');
  if (
    /^#EXT-X-(?:SESSION-)?KEY:(?!METHOD=NONE(?:,|$))/m.test(text) ||
    /^#EXT-X-(?:PART|SKIP|I-FRAMES-ONLY):?/m.test(text)
  )
    throw new Outcome('UNSUPPORTED_PLAYBACK');
  const parser = new Parser();
  parser.push(text);
  parser.end();
  return parser.manifest;
}
export interface Renditions {
  video: Playlist;
  audio?: Playlist;
  tracks: Track[];
  base: string;
  audioBase?: string;
}
export async function hls(net: Network, url: string): Promise<Renditions> {
  const manifest = await net.text(url);
  const top = parse(manifest.text);
  if (!top.playlists?.length) return { video: top, base: manifest.url, tracks: [] };
  const variants = top.playlists.filter(
    (v) => v.uri && !/^mp4a[^,]*$/.test(String(v.attributes?.CODECS)),
  );
  const best = variants.sort(
    (a, b) => Number(b.attributes?.BANDWIDTH ?? 0) - Number(a.attributes?.BANDWIDTH ?? 0),
  )[0];
  if (!best) throw new Outcome('MEDIA_UNAVAILABLE');
  const load = async (uri: string) => {
    const child = await net.text(new URL(uri, manifest.url).href);
    return { list: parse(child.text), url: child.url };
  };
  const video = await load(best.uri!);
  const group = (kind: string) =>
    Object.entries(top.mediaGroups?.[kind]?.[String(best.attributes?.[kind])] ?? {});
  const audioEntries = group('AUDIO').map(([, r]) => r);
  const main = audioEntries.find((r) => r.default) ?? audioEntries[0];
  const audio = main?.uri ? await load(main.uri) : undefined;
  const tracks = group('SUBTITLES')
    .filter(([, r]) => r.uri)
    .map(([label, r]) => ({
      url: new URL(r.uri!, manifest.url).href,
      label,
      language: r.language,
      kind: r.forced
        ? 'forced'
        : /transcribes-spoken-dialog|describes-music-and-sound/.test(r.characteristics ?? '')
          ? 'sdh'
          : undefined,
    }));
  return { video: video.list, base: video.url, audio: audio?.list, audioBase: audio?.url, tracks };
}
export interface Epoch {
  elapsed: number;
  pts: number;
}
export function validateVod(list: Playlist) {
  if (
    !list.endList ||
    list.contentProtection ||
    list.sidx ||
    !list.segments?.length ||
    list.segments.some((s) => s.key || !s.uri || !Number.isFinite(s.duration) || s.duration <= 0)
  )
    throw new Outcome('UNSUPPORTED_PLAYBACK');
}
export async function localPlaylist(
  net: Network,
  list: Playlist,
  base: string,
  work: string,
  prefix: string,
  progress?: Progress,
) {
  validateVod(list);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:' + Math.ceil(list.segments.reduce((max, s) => Math.max(max, s.duration), 0)),
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  const epochs = new Map<number, Epoch>();
  let elapsed = 0;
  let lastMap = '';
  for (const [i, s] of list.segments.entries()) {
    const name = prefix + i + (s.map ? '.m4s' : s.uri.split('?')[0].endsWith('.aac') ? '.aac' : '.ts');
    if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (s.map && JSON.stringify(s.map) !== lastMap) {
      const init = prefix + i + '-init.mp4';
      await download(
        net,
        new URL(s.map.resolvedUri ?? s.map.uri, base).href,
        join(work, init),
        undefined,
        s.map.byterange,
      );
      lines.push('#EXT-X-MAP:URI="' + init + '"');
      lastMap = JSON.stringify(s.map);
    }
    await download(
      net,
      new URL(s.resolvedUri ?? s.uri, base).href,
      join(work, name),
      undefined,
      s.byterange,
    );
    lines.push('#EXTINF:' + s.duration + ',', name);
    if (prefix === 'video' && !epochs.has(s.timeline)) {
      // Probe the segment in its initialization context to recover the MPEG
      // presentation clock at the beginning of each discontinuity period.
      const sample = join(work, 'epoch-' + i + '.m3u8');
      await writeFile(
        sample,
        [
          ...lines.slice(0, 4),
          ...lines.filter((l) => l.startsWith('#EXT-X-MAP')).slice(-1),
          '#EXTINF:' + s.duration + ',',
          name,
          '#EXT-X-ENDLIST',
        ].join('\n') + '\n',
      );
      const sampleInfo = await probe(sample, net.signal);
      epochs.set(s.timeline, {
        elapsed,
        pts: Number(
          sampleInfo.streams.find((v) => v.codec_type === 'video')?.start_time ??
            sampleInfo.format.start_time ??
            0,
        ),
      });
    }
    elapsed += s.duration;
    await progress?.(i + 1, list.segments.length, 'segments');
  }
  const path = join(work, prefix + '.m3u8');
  await writeFile(path, [...lines, '#EXT-X-ENDLIST', ''].join('\n'));
  return { path, duration: elapsed, epochs };
}
