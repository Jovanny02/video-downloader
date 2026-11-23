import { run } from 'graphile-worker';
import { numberSetting, pool } from './common.js';
import { tasks } from './jobs.js';
import { startPlayerHost } from './fixture.js';

if (!['dataset', 'graphql'].includes(process.env.METADATA_BACKEND ?? 'dataset'))
  throw new Error('Unknown METADATA_BACKEND');
const close = await startPlayerHost();
try {
  const runner = await run({
    connectionString: process.env.DATABASE_URL,
    concurrency: numberSetting('WORKER_CONCURRENCY', 1),
    gracefulShutdownAbortTimeout: 45000,
    taskList: tasks(),
  });
  await runner.promise;
} finally {
  await close();
  await pool.end();
}
