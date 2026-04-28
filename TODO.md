# TV Player Todo List

Priority labels:

- P0: Critical reliability and correctness
- P1: High-value user improvements
- P2: Nice-to-have and long-term items

## Recently Completed

- [x] Add configurable concurrent stream limit for multiple simultaneous viewers (set by `MAX_CONCURRENT_STREAMS`).
- [x] Document concurrent stream limit in compose and README examples.

## Sprint 1 (P0)

- [ ] Add unit tests for stream selection rules in src/hdhomerun.ts.
- [ ] Add unit tests for player setup and teardown behavior in src/player.ts.
- [ ] Add integration test for channel switching cleanup behavior in server.mjs.
- [ ] Add server request correlation id and structured log fields.
- [ ] Add /health endpoint that validates HDHomeRun reachability.
- [ ] Improve frontend playback error messages with actionable recovery hints.

Definition of done:

- [ ] npm test runs meaningful test coverage for the critical playback path.
- [ ] npm run build passes.

## Sprint 2 (P1)

- [ ] Add favorites and pinned channels in UI and local settings.
- [ ] Add channel search and optional sorting by number or name.
- [ ] Add last-channel resume on app load.
- [ ] Persist subtitle preference by channel id.
- [ ] Add playback status indicator for passthrough vs transcode mode.

Definition of done:

- [ ] Manual validation of HD, SD, and radio flows after UX changes.

## Sprint 3 (P1/P2)

- [x] Add configurable concurrent stream capacity to support multi-user viewing based on tuner count.
- [ ] Add selectable transcode profiles (quality, balanced, low bandwidth).
- [ ] Add adaptive retry policy based on known error categories.
- [ ] Add a lightweight diagnostics page that surfaces server stream metrics.
- [ ] Add optional tuner-thrash protection when channels are switched rapidly.

Definition of done:

- [ ] Stream startup and switch time are measured before and after changes.

## EPG Epic (P1/P2)

Goal:

- [ ] Ship a free EPG baseline with now/next and compact schedule view.

Milestone A: XMLTV ingestion baseline (Estimate: 1 to 2 days) **DONE**

- [x] Add EPG source configuration env vars in compose.yaml: EPG_SOURCE_URL, EPG_REFRESH_CRON, EPG_TZ.
- [x] Add backend XMLTV fetch and parse pipeline in server.mjs.
- [x] Add normalized EPG cache file storage and load-on-start behavior in server.mjs.
- [x] Document setup and expected source format in README.md.

Milestone B: Channel mapping and API (Estimate: 2 to 3 days) **DONE (with GUI)**

- [x] Implement channel-to-xmltv mapping strategy using GuideNumber and GuideName heuristics.
- [x] Add mapping override support via optional local JSON config.
- [x] Add endpoint /epg/now-next returning current and next programme by channel.
- [x] Add endpoint /epg/channel/:id returning schedule window (for example 12-24 hours).
- [x] Add endpoint /epg/status exposing freshness timestamp and source health.
- [x] Add POST /epg/configure endpoint for runtime EPG URL changes.
- [x] Add POST /epg/refresh endpoint for manual refresh triggers.
- [x] Add EPG settings modal UI with source URL input, status display, and refresh button.

Milestone C: Frontend guide UI (Estimate: 2 to 4 days) **DONE**

- [x] Add now/next metadata fetch in src/app.ts.
- [x] Extend channel rendering in src/channelList.ts to show now/next snippets.
- [x] Add guide panel for selected channel schedule in src/app.ts.
- [x] Style guide cards and timeline blocks in src/style.css.
- [x] Add graceful empty-state and stale-guide labels in the UI.

Milestone D: Refresh and resilience (Estimate: 1 to 2 days)

- [x] Add scheduled EPG refresh job in backend startup flow.
- [x] Keep serving last-known-good guide on fetch/parsing failures.
- [ ] Add lightweight metrics logs for guide fetch duration, mapping success, and freshness age.
- [ ] Add manual refresh endpoint guarded for local network use.

Milestone E: Validation and tests (Estimate: 1 to 2 days)

- [ ] Add parser unit tests with sample XMLTV fixtures.
- [ ] Add mapping tests for common UK Freeview channel name variants.
- [ ] Add API tests for /epg/now-next and /epg/status.
- [ ] Add frontend smoke test for now/next rendering fallback behavior.

Definition of done:

- [ ] At least 80% of visible channels have now/next entries.
- [ ] Guide data persists and remains available after server restart.
- [ ] UI clearly indicates guide freshness and missing data states.
- [ ] npm test and npm run build pass.

## Backlog (P2)

- [x] EPG now/next display.
- [ ] Channel logo support.
- [ ] DVR scheduling exploration spike.
- [ ] Remote-access hardening documentation.
