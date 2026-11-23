# Headless Video Downloader Implementation Plan

Build a headless service that accepts a movie title or a series title with season and episode selections. It resolves the title against IMDb, opens a configured player for each movie or episode, and saves the video and any available English subtitle files. Run the service in Docker on a single host for the first release. The current repository contains only a README.

## Scope and deployment

| Component | Implementation |
| --- | --- |
| API | Node.js LTS, TypeScript, and Fastify with JSON Schema request and response contracts |
| Queue and application state | PostgreSQL and Graphile Worker, with one durable queue shared by REST and SQL submitters |
| Player automation | Playwright with headless Chromium and a registry of player adapters |
| Media processing | Streaming HTTP downloads for direct MP4 and FFmpeg plus ffprobe for on-demand HLS and output validation |
| Deployment and storage | Docker Compose services for the API, worker, and PostgreSQL. Mount a database volume and an output directory. |

Run the API and worker from the same codebase as separate processes. The API handles submission and status. The worker resolves metadata and runs downloads. Only the worker image needs the browser and media binaries. Start with one concurrent download per worker and make concurrency configurable. Pin the Playwright package, Chromium build, and container dependencies together. Run the browser as a non-root user with Chromium sandboxing configured. [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) · [Playwright Docker guidance](https://playwright.dev/docs/docker) · [Docker Compose](https://docs.docker.com/compose/)

Support navigation to the provider's player URL and an internal iframe wrapper for providers that require an embedding context. Serve the wrapper on an origin permitted by that provider. The public submission contract is title-based. The service downloads video-on-demand media that the configured provider makes available for download or that the operator has permission to save. Surface DRM or other playback restrictions as an unsupported result. Add DASH support to the media pipeline after the MP4 and HLS paths pass end-to-end tests.

## Submission and status API

`POST /jobs` accepts either of these request bodies.

Movie

```json
{
  "title": "Example Movie",
  "year": 2024
}
```

Series

```json
{
  "title": "Example Series",
  "seasons": [
    { "season": 1, "episodes": [1, 2, 3] },
    { "season": 2 }
  ]
}
```

- The title is required. The optional year refers to the movie release year or series start year. A `seasons` array selects a series. Omitting the array selects a movie. Omitting `episodes` within a season selects every numbered episode indexed for that season. Explicit episode lists must be nonempty. Normalize duplicates and process selections in numerical order.
- Validate requested seasons and episodes against IMDb before creating download items. If an explicit selection is missing, return the missing coordinates in the job status and leave that request unexpanded. Use the actual catalog numbering for specials, if present. Apply a configurable cap to expanded items and report the cap when a request exceeds it.
- Return `202 Accepted` with `jobId`, a `Location` header for `GET /jobs/{jobId}`, and initial status after the enqueue transaction commits. Support an optional `Idempotency-Key` scoped to the caller. Repeating the same normalized request returns its original job ID. Reusing the key with a different request returns `409 Conflict`.
- `GET /jobs/{jobId}` returns the canonical title, IMDb ID and metadata when resolved, each video's status, progress when measurable, output and subtitle artifacts, and any error codes. For a batch, report item counts as well as individual outcomes. Treat the files in the mounted output directory as the first release's retrieval interface. Return relative paths.
- If a title needs disambiguation, return `needs_selection` and a short candidate list with IMDb ID, title, year, and type. `POST /jobs/{jobId}/selection` accepts one of those IMDb IDs and schedules resolution again. Apply the same check if the selection is submitted through SQL. Submitting the same selection twice is idempotent.

Typical request states are `queued`, `resolving`, `needs_selection`, `processing`, `completed`, `partial`, and `failed`. Use `partial` when some videos in a batch succeeded and others failed. Track subtitle results separately so a completed video remains available if subtitle fetching fails.

## IMDb metadata and matching

Use IMDb as the source of record. Expose a small metadata interface for title search, title details, and episode lookup so the queue and player code can use either an imported IMDb catalog or the official IMDb GraphQL API. Use the local dataset option for a personal, non-commercial deployment covered by IMDb's terms. The GraphQL option requires an AWS Data Exchange subscription. [IMDb datasets](https://data.imdb.com/non-commercial-datasets/) · [IMDb GraphQL API](https://data.imdb.com/documentation/api-documentation/)

1. **Import and index.** Stream and decompress IMDb's TSV files into PostgreSQL staging tables. Use `title.basics` for titles, types, years, runtime, and genres, `title.akas` for aliases, `title.episode` for parent IMDb IDs and season and episode numbers, and `title.ratings` for rating and vote count. Handle IMDb's null marker. Join episode IDs back to title records for episode names. Validate the staged data and publish it atomically, retaining the last good catalog if refresh fails. Provide a one-shot import command and document how to schedule refreshes. IMDb publishes daily dataset updates. [IMDb dataset schema](https://data.imdb.com/non-commercial-datasets/)
2. **Resolve conservatively.** Normalize case, Unicode, whitespace, and punctuation for matching while preserving the original display title. Filter by movie or series type and optional year. Search both official titles and aliases, deduplicating any matches with the same IMDb ID. Auto-select a unique exact normalized match. Present candidates for ambiguous or approximate matches. Record a distinct `TITLE_NOT_FOUND` result when the search has no viable candidates.
3. **Expand against canonical episode records.** Keep the series IMDb ID and each requested episode's IMDb ID, season number, episode number, and title. Flag conflicting IMDb records for the same season and episode instead of guessing. Use the series ID and episode coordinates when an embed endpoint expects them.

The dataset-backed API response includes the available title, year, type, runtime, genre, rating, and episode metadata. It can also construct the IMDb title link from the ID. Plot summaries and posters are outside the initial dataset-backed response. Keep missing IMDb fields nullable rather than requiring complete catalog records. [IMDb dataset fields](https://data.imdb.com/non-commercial-datasets/)

## Durable jobs and retries

Create application tables for requests, download items, and artifacts. Keep request input, the pinned provider key, the selected IMDb record, and status in the request table. Use a unique `(request_id, imdb_title_id)` constraint for movie or episode items. Record per-item attempt status, relative file paths, subtitle metadata, and sanitized errors. Keep user-visible history in the application tables.

Implement a shared PostgreSQL function, `submit_download(payload jsonb, idempotency_key text DEFAULT NULL)`, that validates the common payload, inserts the request, and enqueues `resolve_title` in the same transaction. Return the application job ID. The API calls this function after request validation. Trusted database producers can call it directly or use a trigger on an existing submission table. Give callers permission to execute the application function through a restricted database role. Keep the queue's internal schema under Graphile Worker's management. [Graphile Worker SQL enqueueing](https://worker.graphile.org/docs/sql-add-job)

- `resolve_title` looks up IMDb metadata, records any selection needed, or writes the resolved items and enqueues their `download_item` tasks in one transaction. Each task payload can contain just the application record ID. Guard the resolution state transition so replaying a task cannot expand it twice.
- `download_item` gives each movie or episode independent progress and retry behavior. Use finite attempts with backoff for transient network and upstream errors. Report title ambiguity, unavailable media, unsupported playback, and invalid episode selections as explicit outcomes. Reopen the player on a retry to obtain fresh media URLs. Keep expiring URLs and session credentials out of queue payloads and logs.
- Download into an attempt-specific staging directory on the output volume. Verify the result and publish it using an atomic rename into the item's deterministic final directory. Store a small artifact manifest with the video and subtitle outcomes. If the worker dies after publishing files and before committing status, reconcile the manifest and finalize the existing result on retry. Recompute batch totals from item rows so concurrent updates cannot lose counts.
- Stop claiming new work on container shutdown and give active jobs a grace period to finish or stop cleanly. Graphile Worker retries failed tasks with backoff. Its documented recovery after an ungraceful process exit can leave jobs locked for at least four hours. Accept that limitation for the initial single-host deployment. A requirement for recovery within minutes would change the queue choice. [Graphile Worker error handling](https://worker.graphile.org/docs/error-handling)

## Player adapters

Define a shared contract around a resolved movie or episode. The adapter builds the provider URL, declares direct or iframe navigation, starts the provider's normal playback flow, and identifies which observed media and subtitle resources belong to the requested title. Return typed candidates containing the source kind, URL, track metadata, and any known duration or resolution. The core worker owns browser lifecycle, timeouts, media selection, downloading, and storage.

For each item, register the network observer before navigation. Use a fresh browser context, start playback through the adapter if needed, and collect candidates within a bounded interval. Identify candidates by response content type, manifest structure, or file signature as appropriate. Prefer a master manifest when it describes matching video and audio renditions. Ignore trailers, previews, ad assets, and unrelated frames. If the player exposes title or episode identity, check it against the request and reject a mismatch. Return a clear error if the adapter cannot select a trustworthy candidate. [Playwright network events](https://playwright.dev/docs/network#network-events) · [Playwright frames](https://playwright.dev/docs/frames)

- **Fixture adapter.** Use a local player that serves generated or rights-cleared media. Include direct and iframe-only fixtures and a page whose player fetches media only after Play. Use this adapter for automated end-to-end tests.
- **VidFast adapter.** Use IMDb `tt…` IDs with the documented movie and episode routes. Build episode URLs from the series ID, season, and episode. Request English as the default subtitle language when applicable. Verify direct playback in the deployed Chromium build before choosing it for that integration. Use the internal wrapper when embedding is required and the configured origin is permitted. [VidFast embed documentation](https://vidfast.vc/)
- **VidSrc adapter.** Target a specific configured VidSrc integration and verify that host's documented routes, playback behavior, and subtitle exposure. Its URL builder and playback logic live in its own module. Use the same adapter contract tests as VidFast. Keep the active provider configurable and pin its key when a job is submitted, so changing the default affects new jobs. [One documented VidSrc embed integration](https://vsembed.su/vidsrc/docs/)

Keep the configured origins and media host rules with each adapter. Restrict browser and media subprocess network access to the intended destinations, including redirects and manifest-referenced resources. Keep the queue and database on a private service network. Run external tools with structured arguments and derive output paths from service-controlled IDs and sanitized names.

## Video and English subtitles

For a direct MP4, fetch the complete file into staging and track transferred bytes when a size is available. For on-demand HLS, use FFmpeg with the selected playlist and matching audio rendition. Preserve the selected video and main audio by remuxing without re-encoding where supported. Prefer MP4 when the codecs fit. Use ffprobe to require the expected streams and check duration against the manifest when known. Treat IMDb runtime as a sanity check because cuts and runtimes can differ. [FFmpeg HLS demuxer](https://ffmpeg.org/ffmpeg-formats.html#hls) · [FFmpeg stream copy](https://ffmpeg.org/ffmpeg.html#Streamcopy) · [ffprobe](https://ffmpeg.org/ffprobe.html)

1. Discover subtitles from the adapter's player track list, HTML text tracks, manifest renditions, and embedded text tracks exposed by ffprobe. Match English tags such as `en`, `en-US`, and `eng`, and explicit English labels when tags are unavailable. Preserve normal, forced, and SDH or closed-caption tracks as distinct variants when exposed. Leave unidentified languages unclassified.
2. Save each distinct English text track as its own UTF-8 sidecar file. Preserve SRT or WebVTT when supplied directly. Extract embedded text tracks or assemble segmented WebVTT with a parser or media tool that honors HLS timestamp mapping and discontinuities. Use fixture coverage for cue alignment and boundary duplicates. Record a subtitle warning for formats the initial pipeline cannot extract, such as bitmap subtitles. [HLS WebVTT and timestamp mapping](https://www.rfc-editor.org/rfc/rfc8216.html#section-3.5)
3. Derive sidecar names from the video stem, language, and track kind. Examples include `Example.Series.S01E02.en.srt` and `Example.Series.S01E02.en.sdh.vtt`. Use a deterministic suffix when distinct tracks share the same label. Return each artifact's language, kind, format, and relative path. Report `not_available` when discovery succeeds and finds no English track. Report `partial` or `failed` with a reason when a discovered track could not be saved.

## Implementation order

1. **Scaffold the service.** Set up TypeScript, Fastify, migrations, Docker Compose, health checks, and an output mount. Configure the database connection, output root, metadata backend, provider key, and job limits through deployment settings. Implement REST and SQL submission against the same database function and make a test worker complete a queued job.
2. **Resolve IMDb titles.** Import a small synthetic catalog for tests, then wire the official dataset importer. Implement title matching, disambiguation, and episode expansion. Confirm a movie creates one item and a season request creates precisely its resolved episode items.
3. **Complete a download with fixture media.** Add the browser adapter contract, direct and iframe fixtures, media detection, streamed MP4, HLS remuxing, progress, and output verification. Prove recovery after a transient failure and after a crash between file publication and the database update.
4. **Save subtitles.** Cover standalone SRT and WebVTT, segmented English WebVTT, embedded text, multiple English variants, and absent or failed subtitle tracks.
5. **Integrate and swap players.** Implement VidFast and the selected VidSrc integration through separate adapters. Run contract tests with fixture responses and validate each deployment with content available for authorized testing. Confirm switching the configured provider changes the playback target without changes to the API, IMDb resolver, or media pipeline.
6. **Ship the runbook.** Document how to import IMDb data, start Compose, submit a movie or a batch through REST and SQL, read status, find outputs, select a provider, and diagnose failures. Document independent database and media backups and the chosen job recovery behavior.

## Acceptance criteria

- A movie title alone resolves to a single IMDb movie and produces one validated video. A show title with selected episodes yields exactly those episodes and exposes their IMDb IDs and output paths.
- An ambiguous title returns candidates and produces zero download items until a candidate is selected. A bad season or episode reports the invalid selection. Repeated submissions with the same idempotency key and repeated processing after a retry produce one logical result.
- REST and SQL submissions use the same queue and appear through the same status interface. A second worker can process queued items without duplicating a download.
- Direct player navigation and the internal iframe mode both work with fixture media. The selected provider is configurable and adding another adapter requires no changes to job submission or IMDb matching.
- English subtitle tracks are saved as separate, synchronized files. Non-English-only and subtitle-fetch failure cases have distinct outcomes, and a subtitle issue leaves the successful video available.
- A fresh Docker Compose setup can run the fixture workflow from submission to files on the mounted volume. Automated tests run independently of third-party player uptime. Real provider behavior is verified separately before declaring that integration ready.
