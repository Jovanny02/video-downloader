import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type Item, type Manifest, Outcome } from './common.js';
import { providers } from './providers/index.js';
import { withPlayer } from './browser.js';
import { saveVideo } from './media/save.js';
import type { Progress } from './media/files.js';

export async function publish(item: Item, signal: AbortSignal, progress: Progress): Promise<Manifest> {
  const root = resolve(process.env.OUTPUT_ROOT ?? 'output');
  const relative = join(item.requestId, item.id),
    final = join(root, relative);
  let saved: string | undefined;
  try {
    saved = await readFile(join(final, 'manifest.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (saved) {
    const m: Manifest = JSON.parse(saved);
    if (m.itemId !== item.id || !m.artifacts.some((a) => a.type === 'video'))
      throw new Outcome('INVALID_PUBLISHED_MANIFEST');
    for (const a of m.artifacts) {
      if (a.path !== join(relative, basename(a.path)) || !(await stat(join(root, a.path))).isFile())
        throw new Outcome('INVALID_PUBLISHED_MANIFEST');
    }
    return m;
  }
  const adapter = providers.get(item.provider);
  if (!adapter) throw new Outcome('UNKNOWN_PROVIDER');
  await mkdir(join(root, '.staging'), { recursive: true });
  const attempt = await mkdtemp(join(root, '.staging', item.id + '-'));
  try {
    const files = join(attempt, 'files'),
      work = join(attempt, 'work');
    await mkdir(files);
    await mkdir(work);
    const m = await withPlayer(adapter, item, signal, (net, sources, tracks) =>
      saveVideo(item, net, sources, tracks, files, work, progress),
    );
    for (const a of m.artifacts) a.path = join(relative, a.path);
    await writeFile(join(files, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    await mkdir(join(root, item.requestId), { recursive: true });
    await rename(files, final);
    return m;
  } finally {
    await rm(attempt, { recursive: true, force: true });
  }
}
