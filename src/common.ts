import pg from 'pg';
import type { PoolClient } from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: numberSetting('DB_POOL_SIZE', 16),
});
pool.on('error', () => console.error('Idle PostgreSQL connection lost'));
pool.on('connect', (client) =>
  client.on('error', () => console.error('PostgreSQL client disconnected')),
);
export function numberSetting(key: string, fallback: number) {
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid setting ' + key);
  return n;
}
export async function transaction<T>(
  client: PoolClient,
  fn: () => Promise<T>,
  isolation = '',
): Promise<T> {
  await client.query('BEGIN ' + isolation);
  try {
    const value = await fn();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
export class Outcome extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(code);
  }
  toJSON() {
    return { code: this.code, ...this.details };
  }
}
export interface Input {
  title: string;
  year?: number;
  seasons?: { season: number; episodes?: number[] }[];
}
export interface Title {
  imdbId: string;
  title: string | null;
  type: string;
  year: number | null;
  runtime: number | null;
  genres: string[] | null;
  rating: number | null;
  votes: number | null;
  imdbUrl: string;
}
export interface Episode extends Title {
  season: number;
  episode: number;
}
export interface Item {
  id: string;
  requestId: string;
  provider: string;
  parent: Title;
  title: Title;
  season: number | null;
  episode: number | null;
}
export interface Track {
  url: string;
  unsupported?: boolean;
  language?: string;
  label?: string;
  kind?: string;
}
export interface Artifact {
  path: string;
  type: 'video' | 'subtitle';
  format: string;
  language?: string;
  kind?: string;
}
export interface Manifest {
  itemId: string;
  artifacts: Artifact[];
  subtitles: { status: string; warnings: string[] };
  warnings: string[];
}
