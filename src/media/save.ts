import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { Outcome, type Item, type Track, type Manifest } from '../common.js';
import type { Candidate } from '../providers/contract.js';
import type { Network } from './network.js';
import { download, probe, mediaTool, type Progress } from './files.js';
import { hls, localPlaylist, type Epoch, type Renditions } from './hls.js';
import { dash } from './dash.js';
import { subtitles } from './subtitles.js';

async function choose(net: Network, sources: Candidate[]) {
  if (sources.length === 1) return sources[0];
  const masters = [];
  for (const candidate of sources.filter((c) => c.kind === 'hls')) {
    if ((await net.text(candidate.url)).text.includes('#EXT-X-STREAM-INF:')) masters.push(candidate);
  }
  const manifests = [...masters, ...sources.filter((c) => c.kind === 'dash')];
  if (manifests.length === 1) return manifests[0];
  throw new Outcome('AMBIGUOUS_MEDIA');
}
export async function saveVideo(
  item: Item,
  net: Network,
  sources: Candidate[],
  tracks: Track[],
  dir: string,
  work: string,
  progress: Progress,
): Promise<Manifest> {
  const source = await choose(net, sources);
  if (source.kind === 'probe') {
    const { body } = await net.get(source.url, { Range: 'bytes=0-2047' });
    const parts: Buffer[] = [];
    let length = 0;
    for await (const chunk of body) {
      const part = chunk.subarray(0, 2048 - length);
      parts.push(part);
      length += part.length;
      if (length === 2048) break;
    }
    const magic = Buffer.concat(parts);
    if (magic.toString('ascii', 4, 8) === 'ftyp') source.kind = 'mp4';
    else if (magic.toString().trimStart().startsWith('#EXTM3U')) source.kind = 'hls';
    else if (/<MPD\b/.test(magic.toString())) source.kind = 'dash';
    else throw new Outcome('NO_TRUSTED_MEDIA');
  }
  const name =
    Array.from(
      (item.parent.title ?? item.parent.imdbId)
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}]+/gu, '.')
        .replace(/^\.|\.$/g, ''),
    )
      .slice(0, 48)
      .join('') || item.parent.imdbId;
  const season = (n: number | null) => String(n).padStart(2, '0');
  const stem =
    name + (item.season === null ? '' : '.S' + season(item.season) + 'E' + season(item.episode));
  let ext = 'mp4',
    expected = source.duration,
    input = join(dir, stem + '.mp4');
  let subtitleInput: string | undefined;
  let epochs = new Map<number, Epoch>();
  if (source.kind === 'mp4') {
    await download(net, source.url, input, progress);
  } else {
    let rendered: Renditions;
    if (source.kind === 'hls') rendered = await hls(net, source.url);
    else rendered = await dash(net, source.url);
    const video = await localPlaylist(net, rendered.video, rendered.base, work, 'video', progress);
    const args = ['-nostdin', '-protocol_whitelist', 'file', '-f', 'hls', '-i', video.path];
    let audioPath = video.path;
    if (rendered.audio) {
      const audio = await localPlaylist(net, rendered.audio, rendered.audioBase!, work, 'audio');
      audioPath = audio.path;
      args.push('-protocol_whitelist', 'file', '-f', 'hls', '-i', audio.path);
    }
    subtitleInput = video.path;
    const original = await probe(video.path, net.signal);
    const videoCodec = original.streams.find((s) => s.codec_type === 'video')?.codec_name;
    const audioInfo = audioPath === video.path ? original : await probe(audioPath, net.signal);
    const audioCodec = audioInfo.streams.find((s) => s.codec_type === 'audio')?.codec_name;
    ext =
      ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus'].includes(audioCodec ?? '') &&
      ['h264', 'hevc', 'av1', 'mpeg4', 'vp9'].includes(videoCodec ?? '')
        ? 'mp4'
        : 'mkv';
    input = join(dir, stem + '.' + ext);
    await mediaTool(
      'ffmpeg',
      [...args, '-map', '0:v:0', '-map', rendered.audio ? '1:a:0' : '0:a:0', '-c', 'copy', input],
      net.signal,
    );
    expected = video.duration;
    epochs = video.epochs;
    tracks = [...tracks, ...rendered.tracks];
  }
  const info = await probe(input, net.signal, ext === 'mp4' ? 'mov' : 'matroska');
  if (
    info.streams.some(
      (s) =>
        ['encv', 'enca'].includes(s.codec_tag_string ?? '') ||
        s.side_data_list?.some((d) => /encrypt/i.test(d.side_data_type)),
    )
  )
    throw new Outcome('UNSUPPORTED_PLAYBACK');
  if (source.kind === 'mp4') {
    const packetInfo = await mediaTool(
      'ffprobe',
      [
        '-protocol_whitelist',
        'file',
        '-f',
        'mov',
        '-read_intervals',
        '%+#32',
        '-show_packets',
        '-show_entries',
        'packet_side_data=side_data_type',
        '-of',
        'json',
        input,
      ],
      net.signal,
    );
    if (/Encryption (info|initialization)/i.test(packetInfo)) throw new Outcome('UNSUPPORTED_PLAYBACK');
  }
  const duration = Number(info.format.duration);
  if (
    !info.streams.some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) ||
    !info.streams.some((s) => s.codec_type === 'audio') ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    (expected && Math.abs(duration - expected) > Math.max(0.5, expected * 0.02))
  )
    throw new Outcome('INVALID_VIDEO', {}, true);
  // Verify packets through EOF. Container headers alone survive many truncated MP4 downloads.
  await mediaTool(
    'ffmpeg',
    [
      '-nostdin',
      '-xerror',
      '-protocol_whitelist',
      'file',
      '-f',
      ext === 'mp4' ? 'mov' : 'matroska',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c',
      'copy',
      '-f',
      'null',
      '-',
    ],
    net.signal,
  );
  const size = (await stat(input)).size;
  if (!size) throw new Outcome('INVALID_VIDEO');
  const subStreams = subtitleInput ? (await probe(subtitleInput, net.signal)).streams : info.streams;
  const subs = await subtitles(net, tracks, subStreams, subtitleInput ?? input, epochs, dir, stem);
  const runtime = item.title.runtime;
  const warnings =
    runtime && Math.abs(duration - runtime * 60) > Math.max(180, runtime * 12)
      ? ['IMDB_RUNTIME_DIFFERS']
      : [];
  return {
    itemId: item.id,
    artifacts: [{ type: 'video', path: stem + '.' + ext, format: ext }, ...subs.artifacts],
    subtitles: subs.subtitles,
    warnings,
  };
}
