# Working on the headless video downloader

This repository contains a single-host, title-based downloader for on-demand media the operator may save. The implementation plan records the original scope. The README contains the current deployment, verification, and recovery procedures.

## Where changes belong

- REST and trusted SQL producers share the PostgreSQL submission and selection functions. A request pins its provider when submitted. Preserve those semantics when changing the API or queue.
- IMDb matching resolves a movie or canonical series and episode coordinates before player navigation. The synthetic catalog and generated local media drive the default fixture deployment. The official dataset importer and subscribed GraphQL client are separate metadata backends.
- Player routes and start actions live in `src/providers/`. The browser lifecycle and document diagnostics live in `src/browser.ts`. Keep provider URLs, cookies, credentials, and response bodies out of durable diagnostics. The browser and media client enforce configured origins, including redirects and manifest resources.
- `src/jobs.ts` persists each item's outcome and attempt history. `src/storage.ts` publishes validated video and subtitle artifacts by atomic rename and reconciles the manifest on replay. Keep subtitle failures independent of successful videos.

## Provider investigation from November 22, 2026

`tt22084616` is the confirmed IMDb ID for *Spider-Man: Brand New Day* (2026). The operator could play it interactively. The native worker's sandboxed Chromium received a Cloudflare-branded HTTP 403 on the exact VidFast movie URL and on the adapter's `?sub=en` URL. The denial occurred at the player document, before playback, stream discovery, or FFmpeg. The responding rule is unknown. VidSrc served its page but exposed no trustworthy media within the configured origins.

Use the item error and its matching attempt-history entry to locate a failure. For a player document denial, look for `UNSUPPORTED_PLAYBACK`, `stage: player_navigation`, the HTTP status, navigation mode, response origin, UTC observation time, and optional `cfRay`. A denied wrapper has its own `wrapper_navigation` stage. The README's VidFast handoff describes the remaining provider-side checks. Live readiness requires a provider-permitted deployment and a validated output from an authorized title.

## Verification

- Run `npm test` for the TypeScript build and unit suite. Run `npm run test:e2e` with Node 24 LTS, the pinned sandboxed Chromium, PostgreSQL with `pg_trgm`, FFmpeg, and ffprobe. See the README for the test database privileges and environment settings.
- The integration suite exercises the API, two queue consumers, direct and iframe players, MP4/HLS/static DASH, English subtitle outcomes, and recovery after publication. The local 403 cases cover a denied top-level player and a successful wrapper whose child navigation redirects to a denied document.
- Native verification and Compose configuration validation were completed during this session. The operator chose native verification for this host. A fresh Compose runtime test and a live subscribed IMDb GraphQL call remain separate deployment checks.
