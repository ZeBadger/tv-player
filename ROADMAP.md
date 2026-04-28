# TV Player Roadmap

This roadmap focuses on reliability first, then user experience, then advanced capabilities.

## Product Goals

1. Make playback resilient across channel switches and weak streams.
2. Improve day-to-day usability for TV and radio browsing.
3. Add visibility into stream and transcode health.
4. Grow toward recorder and richer metadata features without destabilizing core playback.

## Phase 1: Reliability And Safety (Now)

1. Add automated tests for stream URL selection and player lifecycle.
2. Add end-to-end smoke tests for HD passthrough, SD transcode, and radio playback.
3. Add structured server logs for stream start, stop, error, and retry events.
4. Add health and diagnostics endpoint for runtime checks.
5. Add user-facing playback error taxonomy with clearer recovery messages.

Exit criteria:

1. Core playback paths are covered by tests.
2. Channel switch regressions are caught automatically.
3. Stream failures are diagnosable from logs alone.

## Phase 2: UX Improvements (Next)

1. Favorites and pinned channels.
2. Last-channel resume and quick-switch history.
3. Search and sort controls for large lineups.
4. Better subtitle UX with channel-level preference memory.
5. Playback status panel with current mode (HD passthrough vs transcode).

Exit criteria:

1. Frequent actions (find channel, switch, subtitle toggle) take fewer clicks.
2. Returning users recover previous viewing context automatically.

## Phase 3: Performance And Adaptive Behavior (Later)

1. Multiple transcode profiles with runtime switching.
2. Optional low-latency mode tuning.
3. Smarter retry strategy by error class.
4. Optional tuner-aware backoff when switching rapidly.

Exit criteria:

1. Reduced buffering and startup delay on constrained networks.
2. Lower CPU usage at equivalent perceived quality.

## Phase 4: Discovery And Metadata (Later)

1. EPG ingestion and now/next display.
2. Channel logos and richer metadata.
3. Better radio presentation and background playback hints.

EPG implementation milestones (free-first strategy):

1. Milestone A: XMLTV ingestion baseline (1 to 2 days).
2. Milestone B: Channel mapping and now/next API (2 to 3 days).
3. Milestone C: Frontend TV guide panel and per-channel schedule (2 to 4 days).
4. Milestone D: Scheduled refresh, caching, and stale-data handling (1 to 2 days).
5. Milestone E: Optional over-the-air EIT fallback spike (2 to 4 days, research-heavy).

Milestone details:

1. Milestone A (XMLTV ingestion baseline).
   Deliverables: Parse XMLTV feed, normalize to internal model, persist to local cache.
   Primary file changes: server.mjs, compose.yaml, README.md.
2. Milestone B (channel mapping and now/next API).
   Deliverables: Map lineup channels to xmltv ids and expose now/next backend endpoint.
   Primary file changes: src/hdhomerun.ts, server.mjs.
3. Milestone C (frontend guide UX).
   Deliverables: Render now/next in channel list and show a compact per-channel timeline.
   Primary file changes: src/app.ts, src/channelList.ts, src/style.css.
4. Milestone D (refresh and resilience).
   Deliverables: Add background refresh schedule, stale cache policy, and user-visible guide freshness state.
   Primary file changes: server.mjs, compose.yaml, src/app.ts.
5. Milestone E (EIT fallback spike).
   Deliverables: Prototype free over-the-air fallback path and compare quality/maintenance cost.
   Primary file changes: separate prototype module and docs notes in README.md.

Exit criteria:

1. Users can browse by content context, not only channel name.
2. Now/next is available for the majority of mapped channels.
3. Guide data remains available during temporary upstream failures via cache.

## Phase 5: Stretch Features (Future)

1. Optional DVR recording scheduler.
2. Basic multi-user profiles for per-user hidden channels and preferences.
3. Optional remote access hardening guide.

Exit criteria:

1. Advanced features do not regress core playback reliability.
