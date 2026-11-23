import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { wrappers } from './browser.js';
import { mediaTool } from './media/files.js';
import { numberSetting } from './common.js';
const require = createRequire(import.meta.url);
const cue = '1\n00:00:00,250 --> 00:00:01,200\nExample dialogue\n';
const vtt = 'WEBVTT\n\n00:00:00.250 --> 00:00:01.200\nExample dialogue\n';
async function generate(dir: string) {
  await writeFile(join(dir, 'english.srt'), cue);
  await writeFile(join(dir, 'english.vtt'), vtt);
  await mediaTool('ffmpeg', [
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '3',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '24',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    join(dir, 'plain.mp4'),
  ]);
  await mediaTool('ffmpeg', [
    '-nostdin',
    '-i',
    join(dir, 'plain.mp4'),
    '-i',
    join(dir, 'english.srt'),
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    '-c:s',
    'mov_text',
    '-metadata:s:s:0',
    'language=eng',
    '-movflags',
    '+faststart',
    join(dir, 'embedded.mp4'),
  ]);
  await mediaTool('ffmpeg', [
    '-nostdin',
    '-i',
    join(dir, 'plain.mp4'),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c',
    'copy',
    '-f',
    'dash',
    '-seg_duration',
    '1',
    join(dir, 'master.mpd'),
  ]);
  for (const [prefix, map] of [
    ['v', '0:v:0'],
    ['a', '0:a:0'],
  ]) {
    await mediaTool('ffmpeg', [
      '-nostdin',
      '-i',
      join(dir, 'plain.mp4'),
      '-map',
      map,
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_list_size',
      '0',
      '-hls_segment_filename',
      join(dir, prefix + '%d.ts'),
      join(dir, prefix + '.m3u8'),
    ]);
  }
  await writeFile(
    join(dir, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,URI="a.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="subs.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.64000b,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"',
      'v.m3u8',
      '',
    ].join('\n'),
  );
  // Read the generated transport clock so the fixture works across FFmpeg builds.
  const clock = JSON.parse(
    await mediaTool('ffprobe', ['-show_streams', '-of', 'json', join(dir, 'v0.ts')]),
  );
  const pts = Math.round(Number(clock.streams[0].start_time) * 90000);
  await writeFile(
    join(dir, 'subs.m3u8'),
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nsub0.vtt\n#EXTINF:2,\nsub1.vtt\n#EXT-X-ENDLIST\n',
  );
  for (const i of [0, 1])
    await writeFile(
      join(dir, 'sub' + i + '.vtt'),
      vtt.replace('WEBVTT', 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:' + pts),
    );
}
const known = new Set(
  ['01', '02', '03', '04', '10', '11', '12', '13', '14', '15'].map((n) => 'tt99000' + n),
);
const escape = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export async function startPlayerHost() {
  const dir = await mkdtemp(join(tmpdir(), 'vod-fixture-'));
  let generated: Promise<void> | undefined;
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, 'http://localhost').pathname;
      const target = wrappers.get(path);
      if (target) {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><iframe allow="autoplay; fullscreen" src="' + escape(target) + '"></iframe>',
        );
        return;
      }
      if (path === '/healthz') {
        res.end('ok');
        return;
      }
      if (path === '/fixture/hls.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(await readFile(require.resolve('hls.js/dist/hls.min.js')));
        return;
      }
      if (path === '/fixture/dash.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(await readFile(require.resolve('dashjs')));
        return;
      }
      const match = path.match(/^\/fixture\/(player|media)\/(tt\d+)(?:\/([A-Za-z0-9.-]+))?$/);
      if (!match || !known.has(match[2])) {
        res.writeHead(404).end();
        return;
      }
      const [, route, id, file] = match;
      if (route === 'player') {
        generated ??= generate(dir);
        await generated;
        const base = '/fixture/media/' + id + '/';
        const dash = id.endsWith('14'),
          hls = id.endsWith('11'),
          onlyFrench = id.endsWith('12'),
          broken = id.endsWith('13');
        const tracks = onlyFrench
          ? '<track srclang="fr" src="' + base + 'english.vtt">'
          : broken
            ? '<track srclang="en" src="' + base + 'missing.vtt">'
            : hls
              ? ''
              : '<track srclang="en-US" kind="captions" label="English SDH" src="' +
                base +
                'english.vtt">';
        const src =
          base +
          (dash ? 'master.mpd' : hls ? 'master.m3u8' : id.endsWith('01') ? 'feature' : 'plain.mp4');
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><body data-imdb="${id}"><video muted>${tracks}</video><button>Play</button>
          ${dash ? '<script src="/fixture/dash.js"></script>' : hls ? '<script src="/fixture/hls.js"></script>' : ''}<script>
          window.fixtureTracks=${JSON.stringify(hls || onlyFrench || broken ? [] : [{ url: base + 'english.srt', language: 'eng', label: 'English forced' }])};
          for(const track of window.fixtureTracks)track.url=new URL(track.url,location.href).href;
          const video=document.querySelector('video'); document.querySelector('button').onclick=()=>{
            if(${hls} && self===top)return;
            if(${dash}){dashjs.MediaPlayer().create().initialize(video,'${src}',true);return;}
            if(${hls} && Hls.isSupported()){const h=new Hls();h.loadSource('${src}');h.attachMedia(video);}
            else video.src='${src}'; video.play().catch(()=>{});
          };</script>`);
        return;
      }
      if (!file || file.startsWith('.')) {
        res.writeHead(404).end();
        return;
      }
      generated ??= generate(dir);
      await generated;
      const local = join(dir, file === 'feature' ? 'embedded.mp4' : file),
        size = (await stat(local)).size;
      const ext = file.split('.').pop()!;
      const types: Record<string, string> = {
        mp4: 'video/mp4',
        mpd: 'application/dash+xml',
        m4s: 'application/octet-stream',
        m3u8: 'application/vnd.apple.mpegurl',
        ts: 'video/mp2t',
        vtt: 'text/vtt',
        srt: 'application/x-subrip',
      };
      res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream');
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0,
        end = range?.[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start > end) {
        res.writeHead(416).end();
        return;
      }
      if (range) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader('Accept-Ranges', 'bytes');
      const stream = createReadStream(local, { start, end });
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      res.writeHead((e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end();
    }
  });
  server.listen(numberSetting('PLAYER_PORT', 8091), process.env.PLAYER_BIND ?? '127.0.0.1');
  await once(server, 'listening');
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  };
}
