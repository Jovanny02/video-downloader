import { readFile } from 'node:fs/promises';
import { runMigrations } from 'graphile-worker';
import { numberSetting, pool, transaction } from './common.js';
import { importCatalog } from './import.js';
import { providers } from './providers/index.js';

export async function migrate() {
  const db = await pool.connect();
  try {
    await db.query('SELECT pg_advisory_lock(702351)');
    await runMigrations({ pgPool: pool });
    await transaction(db, async () => {
      await db.query(
        'CREATE TABLE IF NOT EXISTS public.service_migrations(version integer PRIMARY KEY)',
      );
      if (!(await db.query('SELECT 1 FROM public.service_migrations WHERE version=1')).rowCount) {
        await db.query(await readFile('sql/001-service.sql', 'utf8'));
        await db.query('INSERT INTO public.service_migrations VALUES(1)');
      }
      const key = process.env.PROVIDER_KEY ?? 'fixture';
      if (!providers.has(key)) throw new Error('Unknown PROVIDER_KEY');
      await db.query(
        'INSERT INTO public.download_settings VALUES(true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET provider=excluded.provider,item_cap=excluded.item_cap,max_attempts=excluded.max_attempts',
        [key, numberSetting('MAX_ITEMS', 100), numberSetting('MAX_ATTEMPTS', 4)],
      );
    });
    if (
      process.env.FIXTURE_CATALOG !== 'false' &&
      !(await db.query("SELECT to_regnamespace('catalog') AS catalog")).rows[0].catalog
    ) {
      await importCatalog('fixtures/catalog');
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(702351)');
    db.release();
  }
}
if (import.meta.main) {
  try {
    await migrate();
  } finally {
    await pool.end();
  }
}
