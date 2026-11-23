import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Outcome, type Track, type Artifact } from '../common.js';
import { mediaTool, type Stream } from './files.js';
import { parse, validateVod, type Epoch } from './hls.js';
import type { Network } from './network.js';

export function english(t: Track) {
  return t.language && t.language !== 'und'
    ? /^(en|eng)(-|$)/i.test(t.language)
    : /\benglish\b/i.test(t.label ?? '');
}
function kind(t: Track) {
  const name = [t.kind, t.label].join(' ');
  return /\bforced\b/i.test(name)
    ? 'forced'
    : /\b(sdh|cc|captions|hearing.impaired)\b/i.test(name)
      ? 'sdh'
      : 'normal';
}
const stamp = '(?:\\d{2,}:)?\\d{2}:\\d{2}\\.\\d{3}';
const time = (s: string) => s.split(':').reduce((n, v) => n * 60 + Number(v), 0);
function format(seconds: number) {
  const n = Math.max(0, Math.round(seconds * 1000));
  return (
    [Math.floor(n / 3600000), Math.floor(n / 60000) % 60, Math.floor(n / 1000) % 60]
      .map((x) => String(x).padStart(2, '0'))
      .join(':') +
    '.' +
    String(n % 1000).padStart(3, '0')
  );
}
export function assembleVtt(
  segments: { text: string; timeline: number; elapsed: number }[],
  epochs: Map<number, Epoch>,
) {
  const cues = new Map<string, { at: number; text: string }>();
  for (const part of segments) {
    const blocks = part.text
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .trim()
      .split(/\n[ \t]*\n/);
    const header = blocks.shift() ?? '';
    if (!/^WEBVTT\b/.test(header)) throw new Outcome('INVALID_SUBTITLE');
    const mapping = header.split('\n').find((l) => l.startsWith('X-TIMESTAMP-MAP='));
    const local = mapping?.match(new RegExp('LOCAL:(' + stamp + ')'))?.[1],
      mpeg = mapping?.match(/MPEGTS:(\d+)/)?.[1];
    if (mapping && (!local || !mpeg)) throw new Outcome('INVALID_TIMESTAMP_MAP');
    const epoch = epochs.get(part.timeline);
    if (!epoch) throw new Outcome('SUBTITLE_TIMELINE_UNKNOWN');
    const wrap = 2 ** 33 / 90000;
    let offset = epoch.elapsed - epoch.pts + Number(mpeg ?? 0) / 90000 - time(local ?? '0');
    offset += Math.round((part.elapsed - offset) / wrap) * wrap;
    for (const block of blocks) {
      if (/^(NOTE|STYLE|REGION)\b/.test(block)) continue;
      const match = block.match(
        new RegExp('^(?:([^\\n]*)\\n)?(' + stamp + ') --> (' + stamp + ')([^\\n]*)\\n([\\s\\S]+)$'),
      );
      if (!match) throw new Outcome('INVALID_SUBTITLE');
      const at = time(match[2]) + offset,
        end = time(match[3]) + offset;
      if (end <= 0) continue;
      const cue = format(at) + ' --> ' + format(end) + match[4] + '\n' + match[5];
      cues.set(cue, { at, text: (match[1] ? match[1] + '\n' : '') + cue });
    }
  }
  return (
    'WEBVTT\n\n' +
    [...cues.values()]
      .sort((a, b) => a.at - b.at)
      .map((c) => c.text)
      .join('\n\n') +
    '\n'
  );
}
export async function subtitles(
  net: Network,
  tracks: Track[],
  streams: Stream[],
  input: string,
  epochs: Map<number, Epoch>,
  dir: string,
  stem: string,
) {
  const artifacts: Artifact[] = [],
    warnings: string[] = [],
    names = new Map<string, number>();
  const filename = (t: Track, format: string) => {
    const k = kind(t),
      key = stem + '.en' + (k === 'normal' ? '' : '.' + k),
      n = (names.get(key) ?? 0) + 1;
    names.set(key, n);
    return {
      path: key + (n > 1 ? '.' + n : '') + '.' + format,
      format,
      type: 'subtitle' as const,
      language: t.language || 'en',
      kind: k,
    };
  };
  const warn = (e: unknown) => {
    net.signal.throwIfAborted();
    warnings.push(e instanceof Outcome ? e.code : 'SUBTITLE_FETCH_FAILED');
  };
  const seen = new Set<string>();
  for (const t of tracks.filter(english).sort((a, b) => a.url.localeCompare(b.url))) {
    const identity = JSON.stringify([t.url, kind(t)]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      if (t.unsupported) throw new Outcome('UNSUPPORTED_SUBTITLE_FORMAT');
      const response = await net.text(t.url);
      let data = response.text.replace(/^\uFEFF/, '');
      if (data.startsWith('#EXTM3U')) {
        const list = parse(data);
        validateVod(list);
        const segments = [];
        let elapsed = 0;
        for (const s of list.segments) {
          if (s.byterange || s.map) throw new Outcome('UNSUPPORTED_SUBTITLE_FORMAT');
          segments.push({
            text: (await net.text(new URL(s.uri, response.url).href)).text,
            timeline: s.timeline,
            elapsed,
          });
          elapsed += s.duration;
        }
        data = assembleVtt(segments, epochs);
      }
      const format = /^WEBVTT\b/.test(data)
        ? 'vtt'
        : /^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3} --> /m.test(data)
          ? 'srt'
          : undefined;
      if (!format) throw new Outcome('UNSUPPORTED_SUBTITLE_FORMAT');
      const a = filename(t, format);
      await writeFile(join(dir, a.path), data);
      artifacts.push(a);
    } catch (e) {
      warn(e);
    }
  }
  for (const s of streams.filter((s) => s.codec_type === 'subtitle')) {
    const t: Track = {
      url: '',
      language: s.tags?.language,
      label: s.tags?.title,
      kind: s.disposition?.forced ? 'forced' : s.disposition?.hearing_impaired ? 'sdh' : undefined,
    };
    if (!english(t)) continue;
    const a = filename(t, 'srt');
    const path = join(dir, a.path);
    try {
      if (!['mov_text', 'subrip', 'webvtt', 'ass', 'ssa', 'text'].includes(s.codec_name))
        throw new Outcome('UNSUPPORTED_SUBTITLE_FORMAT');
      await mediaTool(
        'ffmpeg',
        [
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-i',
          input,
          '-map',
          '0:' + s.index,
          '-c:s',
          'srt',
          path,
        ],
        net.signal,
      );
      artifacts.push(a);
    } catch (e) {
      await rm(path, { force: true });
      warn(e);
    }
  }
  return {
    artifacts,
    subtitles: {
      warnings,
      status: warnings.length
        ? artifacts.length
          ? 'partial'
          : 'failed'
        : artifacts.length
          ? 'completed'
          : 'not_available',
    },
  };
}
