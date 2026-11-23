import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { numberSetting, Outcome } from '../common.js';
import type { Network } from './network.js';

export async function mediaTool(name: 'ffmpeg' | 'ffprobe', args: string[], signal?: AbortSignal) {
  try {
    const result = await promisify(execFile)(
      process.env[name.toUpperCase() + '_PATH'] ?? name,
      ['-v', 'error', ...args],
      { signal, timeout: numberSetting('MEDIA_TIMEOUT_MS', 3_600_000), maxBuffer: 8 * 1024 * 1024 },
    );
    return result.stdout;
  } catch {
    throw new Outcome('MEDIA_TOOL_FAILED', {}, true);
  }
}
export interface Stream {
  index: number;
  codec_type: string;
  codec_name: string;
  codec_tag_string?: string;
  side_data_list?: { side_data_type: string }[];
  start_time?: string;
  duration?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}
export async function probe(
  path: string,
  signal: AbortSignal,
  format?: string,
): Promise<{
  streams: Stream[];
  format: { duration?: string; start_time?: string; format_name: string };
}> {
  return JSON.parse(
    await mediaTool(
      'ffprobe',
      [
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mov,mpegts,matroska,hls,aac',
        ...(format ? ['-f', format] : []),
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ],
      signal,
    ),
  );
}
export type Progress = (done: number, total: number | null, unit: 'bytes' | 'segments') => Promise<void>;
export interface ByteRange {
  length: number;
  offset: number;
}
export async function download(
  net: Network,
  url: string,
  path: string,
  progress?: Progress,
  range?: ByteRange,
) {
  const response = await net.get(
    url,
    range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {},
  );
  const body = response.body;
  const total = Number(body.headers['content-length']) || null;
  if (
    range &&
    (body.statusCode !== 206 ||
      !body.headers['content-range']?.startsWith(
        `bytes ${range.offset}-${range.offset + range.length - 1}/`,
      ))
  ) {
    body.destroy();
    throw new Outcome('INVALID_BYTE_RANGE');
  }
  let bytes = 0,
    last = 0;
  const meter = new Transform({
    transform(chunk, _, cb) {
      bytes += chunk.length;
      if (progress && Date.now() - last > 1000) {
        last = Date.now();
        progress(bytes, total, 'bytes').then(() => cb(null, chunk), cb);
      } else cb(null, chunk);
    },
  });
  await pipeline(body, meter, createWriteStream(path, { flags: 'wx' }), { signal: net.signal });
  if (!bytes || (total !== null && total !== bytes) || (range && bytes !== range.length))
    throw new Outcome('TRUNCATED_DOWNLOAD', {}, true);
  await progress?.(bytes, total, 'bytes');
}
