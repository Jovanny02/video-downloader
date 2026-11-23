# Headless video downloader

Submit a movie title or a series and episode selection. The service resolves IMDb IDs, opens the configured player in headless Chromium, validates the downloaded video, and publishes it with English subtitle sidecars. REST and SQL submissions use the same PostgreSQL transaction and Graphile Worker queue.

## Run the fixture deployment

Use Docker Engine with Compose v2 on a Linux host that permits sandboxed Chromium user namespaces. From the repository root, run the following commands.

```sh
cp .env.example .env
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
docker compose exec -T -e API_URL=http://api:3000 -e OUTPUT_DIR=/output worker npm run test:stack
```

The stack test submits a movie and two episodes through the running API, waits for completion, and checks the manifests and files on the mount. The default catalog is synthetic. The worker generates a three-second video, audio, and captions locally. After the images are built, the fixture workflow runs offline.

The API listens on host loopback. PostgreSQL uses a private Compose network and a named volume. `OUTPUT_DIR` defaults to `./output`. The one-shot initialization service gives container UID 1000 ownership of that directory. Use a dedicated directory on a local filesystem with atomic directory rename. Set the three URI-safe database passwords in `.env` before initializing a persistent database.

## Submit and retrieve files

```sh
curl -i http://127.0.0.1:3000/jobs \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: movie-example' \
  -d '{"title":"Example Movie","year":2024}'

curl -i http://127.0.0.1:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{"title":"Example Series","seasons":[{"season":1,"episodes":[3,1]},{"season":2}]}'

curl http://127.0.0.1:3000/jobs/JOB_ID
```

Use the `Location` from the `202` response. A movie produces one item. For a series, the year is its start year. A season without an episode list selects all its numbered entries. Duplicate selections are merged in numerical order, and a whole-season selection covers narrower selections for that season. Zero is valid if the catalog uses it. Missing coordinates, conflicting records, and an expansion over `MAX_ITEMS` leave the item list empty.

When the status is `needs_selection`, choose an IMDb ID from `candidates`. The fixture title `Shared Name` exercises this flow.

```sh
curl -i http://127.0.0.1:3000/jobs/JOB_ID/selection \
  -H 'Content-Type: application/json' -d '{"imdbId":"tt9900003"}'
```

The status response includes canonical metadata, batch counts, each item's IMDb ID and coordinates, attempt history, progress in bytes or segments, errors, subtitle outcomes, and relative artifact paths. Join an artifact path to `OUTPUT_DIR`. Each published directory contains a `manifest.json` beside the files. A typical movie directory looks like this.

```text
output/<job UUID>/<item UUID>/
  Example.Movie.mp4
  Example.Movie.en.srt
  Example.Movie.en.forced.srt
  Example.Movie.en.sdh.vtt
  manifest.json
```

A subtitle outcome of `not_available` means discovery found no English tracks. `partial` or `failed` in the subtitle result includes warning codes, and the video remains available. A job-level `partial` means at least one video succeeded and at least one failed.

The default API treats local clients as one trusted operator. To assign separate REST idempotency scopes, set `API_TOKENS` to a JSON object mapping caller names to distinct bearer tokens and send `Authorization: Bearer <token>`. Authorized callers share the status and selection interface. Repeating a key and normalized payload returns the same job. A different payload with that key returns HTTP 409.

## SQL producers

The API login inherits the restricted `download_submitter` role. An administrator can grant that role to other trusted login roles. Each SQL login has its own idempotency scope. Open a SQL session in the Compose database and submit through the same function.

```sh
docker compose exec db psql -U vod_api -d vod
```

```sql
SELECT submit_download('{"title":"Example Movie"}'::jsonb, 'sql-movie') AS job_id;
SELECT submit_download('{"title":"Example Series","seasons":[{"season":2}]}'::jsonb);
SELECT * FROM job_status WHERE "jobId" = 'JOB_UUID'::uuid;
SELECT select_download('JOB_UUID'::uuid, 'tt9900003');
```

The request and queue entry commit together. An existing producer's insert trigger can call `PERFORM public.submit_download(NEW.payload, NEW.id::text)` in its own transaction. A rollback rolls back both records. `download_submitter` can execute the submission and selection functions and read the status view. Graphile Worker manages its queue schema.

## IMDb metadata

The dataset backend streams the four gzip TSVs through PostgreSQL COPY, handles IMDb nulls, joins episode and rating records, and builds exact and trigram indexes over display titles, original titles, and aliases. The importer validates headers, types, IDs, and catalog content before swapping schemas in one transaction. Readers keep the last published catalog after a failed refresh. Allow disk space for both catalogs, staging data, temporary sort files, indexes, and WAL.

For a personal, non-commercial deployment covered by IMDb's terms, run the official import below. Set `FIXTURE_CATALOG=false` when bootstrapping an empty deployment with real metadata. Subsequent service starts preserve a published catalog. Available dataset fields include title, type, year, runtime in minutes, genres, rating, vote count, episode names, and IMDb links. Missing fields are nullable. [IMDb dataset fields and terms](https://data.imdb.com/non-commercial-datasets/)

```sh
docker compose exec -T worker npm run import
```

To import an existing directory, mount it read-only into a one-shot worker. Supply all four `title.{basics,akas,episode,ratings}.tsv.gz` files. Plain TSV files with the same names are also accepted.

```sh
docker compose run --rm --no-deps -v /absolute/path/to/imdb:/catalog:ro worker npm run import -- /catalog
```

IMDb refreshes the source daily. An example host crontab entry follows. Replace the working directory with this checkout. The importer serializes concurrent refreshes.

```cron
15 3 * * * cd /absolute/path/to/video-downloader && docker compose exec -T worker npm run import
```

For a subscribed IMDb Title and Name Essentials API deployment, set `METADATA_BACKEND=graphql`, `IMDB_DATASET_ID`, `IMDB_REVISION_ID`, `IMDB_ASSET_ID`, and `IMDB_API_KEY`. Supply AWS credentials with permission to call the subscribed asset. The SDK signs Data Exchange `SendApiAsset` calls to `/v1`. The resolver uses title search, title details, and paginated episode lookup. Live GraphQL verification requires subscription credentials. [IMDb API access](https://data.imdb.com/documentation/api-documentation/getting-access/) · [IMDb API request example](https://data.imdb.com/documentation/api-documentation/calling-the-api/)

## Configure a player

`PROVIDER_KEY` selects `fixture`, `vidfast`, or `vidsrc`. The migration process writes the default key and limits to PostgreSQL. Every submission snapshots those settings, including SQL submissions. After changing settings, run the following commands.

```sh
docker compose run --rm --no-deps migrate
docker compose up -d api worker
```

| Setting | Effect |
| --- | --- |
| `WORKER_CONCURRENCY` | Concurrent tasks in a worker, default 1. Separate containers can share the database and output mount. |
| `MAX_ITEMS`, `MAX_ATTEMPTS` | Expansion cap and queue attempt limit, defaults 100 and 4. |
| `VIDFAST_ORIGIN`, `VIDSRC_ORIGIN` | Exact HTTPS embed origins. Defaults are `https://vidfast.vc` and `https://vsembed.su`. |
| `VIDFAST_MODE`, `VIDSRC_MODE`, `FIXTURE_MODE` | `iframe` or `direct`. The default is `iframe`. The S01E01 fixture requires an iframe. |
| `WRAPPER_ORIGIN`, `PLAYER_BIND` | Origin of the per-attempt wrapper and bind address for its HTTP listener. Both default to loopback, using port 8091. |
| `<PROVIDER>_PLAYER_ORIGINS` | Comma-separated exact HTTPS origins for permitted player dependencies. |
| `<PROVIDER>_MEDIA_ORIGINS` | Comma-separated exact HTTPS origins for authorized media, playlists, segments, and subtitles. Include the player origin here when it serves media. |
| `<PROVIDER>_MEDIA_PREFIX` | Optional title-bound CDN path prefix for blob players. Use a trailing slash and `{id}` for the movie or episode ID, or `{series}/{season}/{episode}` for series coordinates. |

Use the provider's permitted embed origin and media destinations for content the operator may save. For a remote iframe deployment, route `/wrap/` on that origin through a TLS reverse proxy to the worker listener. Set `PLAYER_BIND=0.0.0.0` on the private proxy network and set `WRAPPER_ORIGIN` to the exact public origin. Each temporary wrapper belongs to the worker that created it, so each worker needs its own origin or affinity to that worker. Direct navigation can be selected after testing the deployment.

The registry builds movie URLs from the movie IMDb ID and TV URLs from the series IMDb ID and episode coordinates. Both integrations request English subtitles. Chromium uses a fresh context and an origin-filtering proxy. The media client validates every redirect, segment, and initialization resource. FFmpeg and ffprobe receive local files. The worker selects resources associated with the active video or the configured title-bound path. Ambiguous media and mismatching player identity produce explicit errors. [VidFast routes](https://vidfast.vc/) · [VidSrc routes and subtitle parameters](https://vsembed.su/vidsrc/docs/)

**Live verification, November 22, 2026.** Sandboxed Chromium checked direct and iframe navigation for `tt22084616`. VidFast returned HTTP 403. VidSrc served the player page but exposed no trustworthy media within the configured origins. Both live integrations still need an authorized successful download in their target deployment.

### VidFast handoff for the next Codex session

`tt22084616` is the IMDb ID for *Spider-Man: Brand New Day* (2026). The operator reported successful playback in their browser. In a fresh worker browser, the exact movie URL and the adapter URL with `?sub=en` both returned HTTP 403 on direct navigation. Both responses displayed “Attention Required! | Cloudflare” and had zero video elements. The specific Cloudflare rule is unknown. The worker stopped before player interaction, media discovery, or FFmpeg. [IMDb record](https://www.imdb.com/title/tt22084616/) · [Exact player URL](https://vidfast.vc/movie/tt22084616) · [Cloudflare's explanation of HTTP 403](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-403/)

| Priority and potential issue | Check | Potential solution |
| --- | --- | --- |
| 1. VidFast denies the worker access to the player document | On an authorized retest, record UTC time, provider origin, direct or iframe mode, document HTTP status, and Cloudflare Ray ID if present. The operator can give VidFast those details to identify the rule and confirm supported service access. | Use the provider-approved integration, registered embed origin, or official download endpoint if one is offered. A persistent document-level 403 is a terminal access outcome for that attempt. |
| 2. Identify which document was denied | Inspect the failed item and its attempt history in `GET /jobs/{jobId}`. A document-level 403 carries `UNSUPPORTED_PLAYBACK`, `stage`, `httpStatus`, `mode`, `origin`, UTC `observedAt`, and an optional validated `cfRay`. | For `wrapper_navigation`, check the wrapper deployment. For `player_navigation`, use the provider origin, time, and Ray ID to investigate the player response. Both denials end the attempt before playback. |
| 3. The deployment may use an unregistered wrapper origin | If VidFast confirms embedding is supported, compare its registered origin with `WRAPPER_ORIGIN`. Verify that the reverse proxy routes the temporary wrapper to the worker that created it. | Configure the registered HTTPS origin and set `VIDFAST_MODE` to the supported mode. Repeat the document check before changing adapter logic. |
| 4. A loaded player may need a different playback interaction | After the player document loads successfully, inspect its ordinary Play control and the frame that owns the video. The current adapter uses a shared button matcher and observes candidates from the selected player frame. | If the supported player differs, implement its documented interaction in `src/providers/vidfast.ts` and reproduce it with a local fixture. Check title identity before accepting media from a child frame. |
| 5. A playing video may still yield `NO_TRUSTED_MEDIA` | Inspect the resource kind and origin from the verified player frame. Compare them with VidFast's confirmed player and media destinations. A blob URL alone does not identify a downloadable resource. | Configure the specific approved origins in `VIDFAST_PLAYER_ORIGINS` and `VIDFAST_MEDIA_ORIGINS`. Use `VIDFAST_MEDIA_PREFIX` only when the provider has a documented title-bound path. Retain redirect and segment origin checks. |

**Offline regression coverage.** The end-to-end suite serves a local branded 403 directly and through a successful iframe wrapper with a redirected child document. It checks the public error details, one terminal attempt, zero playback starts, and zero published artifacts.

**Live completion criterion.** With provider-approved access and a title the operator may save, submit through the API. Verify the intended IMDb ID, a completed item, a playable output with the expected streams, and the recorded English subtitle outcome. A successful document load alone establishes only that navigation works.

## Media and worker recovery

The worker streams direct MP4 and remuxes on-demand HLS or static DASH using stream copy. It chooses the highest-bandwidth offered video variant and matching main audio. MP4-compatible renditions use MP4, with Matroska available for other codecs. Output checks require video and audio, a positive duration, a duration consistent with the playlist when available, and a readable packet stream through EOF. A large difference from the IMDb runtime is a warning. Protected playback, live playlists, and unsupported DASH segment indexes return `UNSUPPORTED_PLAYBACK`.

English SRT and WebVTT tracks, including forced and SDH variants, have separate filenames. The HLS subtitle assembler uses the media clock for each discontinuity and removes repeated boundary cues. Supported embedded text tracks are extracted with FFmpeg. Bitmap and unsupported segmented DASH subtitle formats produce subtitle warnings. [HLS WebVTT timing](https://www.rfc-editor.org/rfc/rfc8216.html#section-3.5)

Graphile Worker retries transient failures with backoff. Each attempt reopens the player for fresh URLs. Files and their manifest move from an attempt-specific staging directory to the final item directory in a single rename. On replay, the worker reconciles the manifest with application state. Per-item locks serialize duplicate tasks, and batch status is recomputed from item rows.

Compose sends SIGTERM and gives the worker 65 seconds to exit. The worker stops claiming tasks and signals active work to abort after 45 seconds. Following an ungraceful exit, Graphile Worker can keep jobs locked for at least four hours. Submitted jobs and attempt history remain in PostgreSQL. [Graphile Worker error handling](https://worker.graphile.org/docs/error-handling)

| Symptom or code | Where to look |
| --- | --- |
| `TITLE_NOT_FOUND` or `needs_selection` | Check movie versus series, optional year, published catalog, or the candidate list. |
| `INVALID_EPISODE_SELECTION`, `CONFLICTING_EPISODES`, `ITEM_LIMIT_EXCEEDED` | Inspect `error.missing`, `error.conflicts`, or `error.cap`. The job creates zero items. |
| `UNSUPPORTED_PLAYBACK`, `DESTINATION_DENIED`, `NO_TRUSTED_MEDIA` | Check the permitted origin, player mode, verified CDN paths, and provider availability. |
| `MEDIA_TOOL_FAILED` or `INVALID_VIDEO` | Check free space, mount ownership, FFmpeg support, duration and stream suitability, and item history. |
| Repeated browser startup failures | Check worker logs, user namespaces, the versioned seccomp profile, and host AppArmor policy for Chromium. |
| A job appears stuck after a host crash | Check `docker compose logs worker`, attempts, and the queue lock recovery window. Remove abandoned `.staging` directories only with workers stopped. |

## Backups

Back up PostgreSQL and media independently. For a coordinated recovery point, pause SQL producers and stop the API and workers, let active work drain, take both backups, and restart the services.

```sh
docker compose stop api worker
docker compose exec -T db pg_dump -U postgres -d vod -Fc > vod.dump
tar --exclude=.staging -C ./output -cf media.tar .
docker compose start api worker
```

Use your configured `OUTPUT_DIR` in place of `./output`. Keep deployment settings and credentials separately. Restore the database archive with `pg_restore` into a fresh database with the Compose roles initialized, restore the media tree to the mount with UID 1000 access, then start the API and workers. The database archive includes Graphile jobs, the catalog, and application records. The media archive includes videos, subtitles, and manifests.

## Development and verification

```sh
npm ci
npm test
npx playwright-core install chromium --only-shell
DATABASE_URL=postgresql://test_admin@localhost/postgres npm run test:e2e
```

Use Node 24 LTS, PostgreSQL with `pg_trgm`, a sandbox-capable non-root Chromium environment, and FFmpeg/ffprobe on PATH. `FFMPEG_PATH`, `FFPROBE_PATH`, and `PLAYWRIGHT_BROWSERS_PATH` can point to local installations. The end-to-end test creates and drops its own uniquely named database, uses a temporary output directory, and needs a test database administrator that can create a database and the submitter role. It exercises two queue consumers, scoped submissions, selection, exact episode expansion, partial failures, switching providers, and recovery on both sides of publication. The integration test has no dependency on third-party media providers.

The Dockerfile pins image digests and the Debian package snapshot. The npm lockfile pins Playwright Core 1.65.1 and its Chromium headless shell revision 1255. Update the package, browser revision, and matching Chromium seccomp profile together. [Playwright container guidance](https://playwright.dev/docs/docker)
