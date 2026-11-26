# Phase 07 implementation and QA evidence

Date: 2026-11-26. Baseline: `b9c9c99` on `codex/phase05-06`.

Implementation is complete. **Phase gate: BLOCKED** pending an observed screen-reader/operator accessibility walkthrough. No remote checkpoint or release advancement is claimed.

Environment: Node 22.22.0, isolated local MongoDB replica set `legalChatQA` on port 27028, random disposable databases, fictional sources, deterministic test-only answer/storage/retrieval adapters. Browser: local headless Chrome through Playwright; axe-core 4.10.3. Test browser bypasses CSP only for scanner injection. Application CSP remains enabled. Langfuse: configured development Cloud project; no chat model calls in the telemetry probe.

| Check | Actual evidence | Result |
|---|---|---|
| 07.1 | Named integration assertions cover retryable 503 before headers, terminal SSE error after one persisted paragraph, disconnect interruption and retained question/paragraphs. Browser partial-failure/retry and Stop reply checks pass. | PASS for exercised cases |
| 07.2 | Two concurrent requests with the same retry ID create one new assistant attempt and one original user turn. Original selections persist. B/admin cannot retry A's turn. SIGKILL/restart plus lease expiry preserves partial text, marks interrupted and releases generation. A grounded-provider retry after shared revision replacement takes a fresh snapshot while retaining the failed snapshot. | PASS |
| 07.3 | Per-user quota returns 429/Retry-After; B's independent quota works; exact replays bypass quota; generation works after expiry. Provider cooldown persists across reload and blocks early retry. Browser verifies the countdown disables retry and preserves the optimistic question in an existing thread. Telemetry outage is isolated and shutdown flush bounded. Two real Cloud traces were exported and read back with six observations each, common original turn, separate terminal states, hashed retry ID, all branch ranks, timings and fictional supplied token counts. Marker content is absent. | PASS for exercised cases |
| 07.4 | Axe detects no WCAG A/AA violations on signup, login, chat, source viewer and admin. All five pass 320px reflow and 200% CSS zoom without horizontal overflow. Keyboard automation checks signup Tab order, citation Enter, Escape, focus return and tooltip dismissal. Stable composer uses readOnly while sending; stages/completion use a polite live region. Observed screen-reader announcements, full keyboard walkthrough and native browser zoom acceptance still require an operator. | BLOCKED |

## Automated and independent review

- `npm run build`: PASS.
- Full regression run: **81 assertions passed, 0 failed** across phase 01–07 suites, client stream parsing and grounding tests. Set `QA_MONGODB_URI='mongodb://127.0.0.1:27028/?replicaSet=legalChatQA'` for phase 01, whose historical default is port 27017.
- Independent QA sub-agent re-review: all initially reported correctness issues addressed; no remaining blocking correctness issue found. Its separate `npm run test:wave-07` run passed **12 tests, 0 failed**.
- `node scripts/phase07-browser.mjs`: PASS for automated scan, reflow, CSS zoom and browser recovery assertions. [Structured browser evidence](phase07-browser.json).
- `node --env-file=.env scripts/phase07-live-telemetry.mjs`: ingestion, readback and masking PASS. [Sanitized Cloud evidence](phase07-live-telemetry.json). Supplied usage numbers in this probe are fictional test metadata; this does not establish actual model billing.

An initial regression invocation used phase 01's port-27017 default and could not start that fixture. It passed after explicitly configuring the isolated replica set. Initial browser scans found an invalid message-region label, unsupported labels on generic divs and file-input intrinsic-width overflow; all were fixed and rescanned.

Axe leaves one source-caption color-contrast item incomplete because it cannot resolve an overlap/background. Visual inspection of [the actual source dialog](phase07-source.png) found no obscured caption; its configured text `#202927` against opaque dialog background `#fbfaf7` has a calculated contrast ratio of 14.29:1. This resolves that specific scanner uncertainty, not full accessibility conformance.

## Limits and next acceptance step

The rate store is intentionally single-instance/in-memory and resets on restart. Thread locking and retry uniqueness are database-enforced. Restart recovery waits for an unexpired lease (90 seconds by default); open generating history polls and subsequent requests reconcile expiration. Optional full-content tracing is not exposed. No deployment, push or live customer data was used.

An operator must complete QA 07.4 with a screen reader, keyboard-only navigation and native zoom, including stage/completion announcements, focus stability, comparisons, source dialog and admin feedback. Record the observed result before changing the gate to PASS or advancing the GitHub checkpoint.
