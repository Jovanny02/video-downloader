import type { PoolClient } from 'pg';
import { Outcome, type Episode, type Input, type Title } from './common.js';
export interface Match extends Title {
  exact: boolean;
}
export interface Catalog {
  search(input: Input): Promise<Match[]>;
  details(id: string): Promise<Title | undefined>;
  episodes(id: string, seasons: number[]): Promise<Episode[]>;
}
export const typesFor = (input: Input) =>
  input.seasons ? ['tvSeries', 'tvMiniSeries'] : ['movie', 'tvMovie'];
const columns = `t.id AS "imdbId", t.title,t.type,t.year,t.runtime,t.genres,t.rating,t.votes,
  'https://www.imdb.com/title/' || t.id || '/' AS "imdbUrl"`;
export function localCatalog(db: PoolClient): Catalog {
  return {
    async search(input) {
      const args = [input.title, typesFor(input), input.year ?? null];
      const base = `FROM catalog.names n JOIN catalog.titles t ON t.id=n.id
        WHERE t.type=ANY($2) AND ($3::int IS NULL OR t.year=$3) AND `;
      const exact = await db.query(
        `SELECT DISTINCT ${columns}, true AS exact ${base} n.name=public.match_title($1) ORDER BY "imdbId" LIMIT 10`,
        args,
      );
      if (exact.rowCount) return exact.rows;
      return (
        await db.query(
          `SELECT ${columns},false AS exact ${base} n.name % public.match_title($1)
        GROUP BY t.id ORDER BY max(similarity(n.name,public.match_title($1))) DESC,t.id LIMIT 10`,
          args,
        )
      ).rows;
    },
    async details(id) {
      return (await db.query(`SELECT ${columns} FROM catalog.titles t WHERE t.id=$1`, [id])).rows[0];
    },
    async episodes(id, seasons) {
      return (
        await db.query(
          `SELECT ${columns},e.season,e.episode FROM catalog.episodes e
      JOIN catalog.titles t ON t.id=e.id WHERE e.parent=$1 AND e.season=ANY($2) AND e.episode IS NOT NULL ORDER BY e.season,e.episode,t.id`,
          [id, seasons],
        )
      ).rows;
    },
  };
}
export function expand(input: Input, rows: Episode[], cap: number) {
  const result: Episode[] = [];
  const missing: { season: number; episode?: number }[] = [];
  const conflicts: { season: number; episode: number }[] = [];
  for (const { season, episodes } of input.seasons ?? []) {
    const indexed = new Map<number, Episode[]>();
    for (const row of rows.filter((row) => row.season === season)) {
      const values = indexed.get(row.episode) ?? [];
      values.push(row);
      indexed.set(row.episode, values);
    }
    const numbers = episodes ?? [...indexed.keys()].sort((a, b) => a - b);
    if (!numbers.length) missing.push({ season });
    for (const episode of numbers) {
      const found = indexed.get(episode);
      if (!found) missing.push({ season, episode });
      else if (found.length !== 1) conflicts.push({ season, episode });
      else result.push(found[0]);
    }
  }
  if (missing.length || conflicts.length)
    throw new Outcome(missing.length ? 'INVALID_EPISODE_SELECTION' : 'CONFLICTING_EPISODES', {
      missing,
      conflicts,
    });
  if (result.length > cap) throw new Outcome('ITEM_LIMIT_EXCEEDED', { cap, requested: result.length });
  return result;
}
