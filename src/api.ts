import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { pool, numberSetting, type Input } from './common.js';
const text = { type: 'string' },
  nullableText = { type: ['string', 'null'] },
  integer = { type: 'integer' },
  nullableInt = { type: ['integer', 'null'] };
const coord = { type: 'integer', minimum: 0, maximum: 2147483647 };
const array = (items: object) => ({ type: 'array', items });
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const input = object(
  {
    title: { type: 'string', minLength: 1, maxLength: 512 },
    year: { type: 'integer', minimum: 1, maximum: 9999 },
    seasons: {
      ...array(
        object({ season: coord, episodes: { ...array(coord), minItems: 1, maxItems: 10000 } }, [
          'season',
        ]),
      ),
      minItems: 1,
      maxItems: 1000,
    },
  },
  ['title'],
);
const uuid = { type: 'string', format: 'uuid' },
  params = object({ jobId: uuid });
const accepted = object({ jobId: uuid, status: text });
const titleFields = { imdbId: text, title: nullableText, type: text, year: nullableInt };
const metadata = object({
  ...titleFields,
  runtime: nullableInt,
  genres: { type: ['array', 'null'], items: text },
  rating: { type: ['number', 'null'] },
  votes: nullableInt,
  imdbUrl: text,
});
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const error = nullable({
  type: 'object',
  required: ['code'],
  properties: { code: text },
  additionalProperties: true,
});
const artifact = object({
  type: text,
  path: text,
  format: text,
  language: nullableText,
  kind: nullableText,
});
const item = object({
  id: uuid,
  imdbId: text,
  metadata,
  season: nullableInt,
  episode: nullableInt,
  status: text,
  attempts: integer,
  warnings: array(text),
  history: array(
    object({ number: integer, status: text, startedAt: text, finishedAt: nullableText, error }),
  ),
  progress: nullable(object({ done: integer, total: nullableInt, unit: text })),
  error,
  subtitles: nullable(object({ status: text, warnings: array(text) })),
  artifacts: array(artifact),
});
const status = object({
  jobId: uuid,
  status: text,
  input,
  provider: text,
  metadata: nullable(metadata),
  candidates: array(object(titleFields)),
  error,
  counts: object({ total: integer, pending: integer, completed: integer, failed: integer }),
  items: array(item),
});
export function buildApi() {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const tokens: Record<string, string> = JSON.parse(process.env.API_TOKENS || '{}');
  if (
    Object.values(tokens).some((token) => typeof token !== 'string' || !token.length) ||
    new Set(Object.values(tokens)).size !== Object.keys(tokens).length
  )
    throw new Error('API_TOKENS must contain distinct nonempty tokens');
  const callers = new Map(Object.entries(tokens).map(([caller, token]) => [token, caller]));
  app.addHook('onRequest', async (req, reply) => {
    if (
      callers.size &&
      req.url !== '/healthz' &&
      !(
        req.headers.authorization?.startsWith('Bearer ') &&
        callers.has(req.headers.authorization.slice(7))
      )
    )
      return reply.code(401).send({ code: 'UNAUTHORIZED' });
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as { code?: string; validation?: unknown; statusCode?: number };
    const code =
      e.code === 'P0409'
        ? 409
        : e.code === 'P0404'
          ? 404
          : e.code === '22023' || e.validation
            ? 400
            : (e.statusCode ?? 503);
    reply.code(code).send({
      code:
        code === 409
          ? req.url.endsWith('/selection')
            ? 'INVALID_SELECTION'
            : 'IDEMPOTENCY_CONFLICT'
          : code === 404
            ? 'JOB_NOT_FOUND'
            : code < 500
              ? 'INVALID_REQUEST'
              : 'SERVICE_UNAVAILABLE',
    });
  });
  app.get('/healthz', async () => {
    await pool.query('SELECT 1 FROM public.job_status LIMIT 0');
    return { status: 'ok' };
  });
  app.post<{ Body: Input }>(
    '/jobs',
    {
      schema: {
        body: input,
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 200 } },
        },
        response: { 202: accepted },
      },
    },
    async (req, reply) => {
      const key = req.headers['idempotency-key'];
      const caller = callers.get((req.headers.authorization ?? '').replace(/^Bearer /, '')) ?? 'local';
      const scoped = key
        ? createHash('sha256')
            .update(JSON.stringify([caller, key]))
            .digest('hex')
        : null;
      const {
        rows: [{ id }],
      } = await pool.query('SELECT public.submit_download($1,$2) id', [req.body, scoped]);
      const {
        rows: [job],
      } = await pool.query('SELECT "jobId",status FROM public.job_status WHERE "jobId"=$1', [id]);
      return reply
        .code(202)
        .header('Location', '/jobs/' + id)
        .send(job);
    },
  );
  app.get<{ Params: { jobId: string } }>(
    '/jobs/:jobId',
    { schema: { params, response: { 200: status } } },
    async (req, reply) => {
      const {
        rows: [job],
      } = await pool.query('SELECT * FROM public.job_status WHERE "jobId"=$1', [req.params.jobId]);
      return job ?? reply.code(404).send({ code: 'JOB_NOT_FOUND' });
    },
  );
  app.post<{ Params: { jobId: string }; Body: { imdbId: string } }>(
    '/jobs/:jobId/selection',
    {
      schema: {
        params,
        body: object({ imdbId: { type: 'string', pattern: '^tt[0-9]+$' } }),
        response: { 202: accepted },
      },
    },
    async (req, reply) => {
      const id = req.params.jobId;
      await pool.query('SELECT public.select_download($1,$2)', [id, req.body.imdbId]);
      const {
        rows: [job],
      } = await pool.query('SELECT "jobId",status FROM public.job_status WHERE "jobId"=$1', [id]);
      return reply
        .code(202)
        .header('Location', '/jobs/' + id)
        .send(job);
    },
  );
  return app;
}
if (import.meta.main) {
  const app = buildApi();
  for (const sig of ['SIGTERM', 'SIGINT'])
    process.once(sig, async () => {
      await app.close();
      await pool.end();
    });
  await app.listen({ port: numberSetting('PORT', 3000), host: process.env.API_BIND ?? '0.0.0.0' });
}
