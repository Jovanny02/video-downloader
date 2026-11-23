import { DataExchangeClient, SendApiAssetCommand } from '@aws-sdk/client-dataexchange';
import { type Catalog, type Match, typesFor } from './catalog.js';
import { type Title, type Episode, Outcome } from './common.js';

const fields =
  'id titleText { text } originalTitleText { text } titleType { id } releaseYear { year } runtime { seconds } titleGenres { genres { genre { text } } } ratingsSummary { aggregateRating voteCount }';
interface Node {
  id: string;
  titleText?: { text: string };
  originalTitleText?: { text: string };
  titleType: { id: string };
  releaseYear?: { year: number };
  runtime?: { seconds: number };
  titleGenres?: { genres: { genre: { text: string } }[] };
  ratingsSummary?: { aggregateRating: number; voteCount: number };
  series?: { episodeNumber?: { seasonNumber: number; episodeNumber: number } };
}
interface Page<T> {
  edges: { node: T }[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}
function title(n: Node): Title {
  return {
    imdbId: n.id,
    title: n.titleText?.text ?? null,
    type: n.titleType.id,
    year: n.releaseYear?.year ?? null,
    runtime: n.runtime ? Math.round(n.runtime.seconds / 60) : null,
    genres: n.titleGenres?.genres.map((g) => g.genre.text) ?? null,
    rating: n.ratingsSummary?.aggregateRating ?? null,
    votes: n.ratingsSummary?.voteCount ?? null,
    imdbUrl: 'https://www.imdb.com/title/' + n.id + '/',
  };
}
const dataExchange = new DataExchangeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const normalized = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function graphCatalog(client = dataExchange): Catalog {
  async function query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await client.send(
      new SendApiAssetCommand({
        DataSetId: process.env.IMDB_DATASET_ID,
        RevisionId: process.env.IMDB_REVISION_ID,
        AssetId: process.env.IMDB_ASSET_ID,
        Path: '/v1',
        Method: 'POST',
        RequestHeaders: { 'x-api-key': process.env.IMDB_API_KEY ?? '' },
        Body: JSON.stringify({ query, variables }),
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    const result = JSON.parse(r.Body ?? '{}');
    if (result.errors || !result.data) throw new Outcome('METADATA_UPSTREAM_ERROR', {}, true);
    return result.data;
  }
  return {
    async search(input) {
      const matches = new Map<string, Match>();
      const term = normalized(input.title);
      for (const exact of [true, false]) {
        let cursor: string | null = null;
        do {
          const { mainSearch }: { mainSearch: Page<{ entity: Node }> } = await query(
            `query($term:String!,$after:String,$exact:Boolean!){mainSearch(first:50,after:$after,options:{searchTerm:$term,isExactMatch:$exact,type:TITLE}){pageInfo{endCursor hasNextPage} edges{node{entity{... on Title{${fields}}}}}}}`,
            { term: input.title, after: cursor, exact },
          );
          for (const edge of mainSearch.edges) {
            const entity = edge.node.entity;
            const t = title(entity);
            if (typesFor(input).includes(t.type) && (input.year === undefined || input.year === t.year))
              matches.set(t.imdbId, {
                ...t,
                exact:
                  exact ||
                  [t.title, entity.originalTitleText?.text].some((v) => v && normalized(v) === term),
              });
          }
          cursor = mainSearch.pageInfo.hasNextPage ? mainSearch.pageInfo.endCursor : null;
        } while (cursor && matches.size < 10);
        if (matches.size) {
          // A truncated fuzzy search cannot establish that an exact title is unique.
          if (cursor && !exact)
            return [...matches.values()].slice(0, 10).map((t) => ({ ...t, exact: false }));
          const exactMatches = [...matches.values()].filter((t) => t.exact);
          if (exactMatches.length) return exactMatches.slice(0, 10);
          break;
        }
      }
      return [...matches.values()].slice(0, 10);
    },
    async details(id) {
      const d = await query<{ title: Node | null }>(`query($id:ID!){title(id:$id){${fields}}}`, { id });
      return d.title ? title(d.title) : undefined;
    },
    async episodes(id, seasons) {
      const result: Episode[] = [];
      let cursor: string | null = null;
      do {
        const d: { title: { episodes: { episodes: Page<Node> } } } = await query(
          `query($id:ID!,$after:String){title(id:$id){episodes{episodes(first:100,after:$after){pageInfo{endCursor hasNextPage} edges{node{${fields} series{episodeNumber{seasonNumber episodeNumber}}}}}}}}`,
          { id, after: cursor },
        );
        const page: Page<Node> = d.title.episodes.episodes;
        for (const { node } of page.edges) {
          const n = node.series?.episodeNumber;
          if (n && seasons.includes(n.seasonNumber) && Number.isInteger(n.episodeNumber))
            result.push({ ...title(node), season: n.seasonNumber, episode: n.episodeNumber });
        }
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (cursor);
      return result;
    },
  };
}
