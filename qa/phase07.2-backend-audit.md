# Phase 7.2 backend audit

Date: 2026-11-26. Reviewer: backend audit agent, independent of the frontend implementation. This is a bounded source and fixture review, not a claim that every possible backend defect has been excluded.

## Confirmed finding

| ID | Evidence / affected task | Priority and confidence | Remedy / owner | Validation and disposition |
|---|---|---|---|---|
| BE-01 | Reproduced defect in `server/src/chat.ts`, `respond()` finalizer. A terminal saved-result lookup failure before SSE headers were sent threw the intended HTTP 503, but the finalizer called `res.end()` first. Express consequently committed an empty 200; the browser could not receive the actionable retry message. | P1 recovery behavior; high confidence. The fixture injects a one-shot database lookup exception, rather than claiming a real database outage was observed. | Backend owner: end the SSE response only after `started` is true. Keep pre-header exceptions available to the normal Express error handler. No API/schema migration. | Fixed. The corrected regression fails with `200 !== 503` when only this condition is reverted in an isolated copy, and passes against the changed implementation. Tests also verify request ID, saved completed reply, idempotent replay with one original turn, and an SSE error after a paragraph has already started streaming. Independent integrated retest remains the lead/QA owner's responsibility. |

The temporary before-fix runtime was copied to `/private/tmp/phase072-backend-before-6qnxsytj`; only its compiled finalizer condition was restored to the original. It used the same new test and fixtures. No production fault controls were added. The repository fixture monkey-patches `Message.findOne` only in the isolated test process and restores it on the first matching attempt lookup.

## Reviewed invariants and remaining uncertainty

- `auth.ts`: JWT algorithm/issuer/audience and required identity claims; revocation and expiry lookup; account role comes from the database; exact Origin check on mutations; no-store response handling. Customer routes require a session and upload/admin routes additionally enforce server-side role checks. No new authorization bypass was identified in this review.
- `chat.ts`, `attempts.ts`, `conversations.ts`: account-scoped send/history/retry/cancel queries, signed scope-bound cursors, unique idempotency keys, transactional turn and attempt reservation, active-attempt lease fencing, stale reconciliation, durable partial paragraphs, retry cooldown and original document selectors. The existing phase07 suite exercises ownership denial, concurrent retries, cancellation, expiry/restart and throttling. No schema or transaction-boundary change was needed for BE-01.
- `uploads.ts`, `storage.ts`, `index-worker.ts`: upload ownership and admin guards, reservation hashes and limits, immutable version pinning and checksum verification, cleanup grace, worker lease token fencing, publication compare-and-set, historical originals and archive handling. These were inspected; this audit did not rerun a real S3 or hosted retrieval integration. Existing fixture suites remain the regression authority; live service behavior is not established by them.
- `sources.ts`, `answer.ts`, `answer-provider.ts`, `retrieval.ts`: source ownership and historically published shared versions, source-ready restriction, server-resolved anchors, bounded structured output, registered comparison output validation, request deadline and provider retry delay handling. `answer-telemetry.ts` and test-adapter guards were inspected for masked/bounded telemetry and NODE_ENV restrictions. No provider or retrieval contract changed, so no new live model call was necessary for this fix.
- Resource observation (unconfirmed capacity concern): admin document listing/events and ready-version migration scheduling read potentially growing record sets without paging. Source passage responses also return all passages for a bounded original. This is a source observation, not a reproduced latency or availability defect: no scale benchmark was run. Measure realistic corpus sizes and response/worker time before choosing pagination or batching contracts; a refactor based solely on file length would not establish an improvement.
- Rate-limit stores are process-local; this review does not establish coordinated quotas across replicas. Validate the intended hosted topology before a multi-instance deployment. Attempt fencing and unique indexes use shared database state independently of those stores.
- Mixed persistence fields are a compatibility boundary. Their use alone is not a demonstrated defect; no migration, rewrite of old messages or broad casting cleanup was attempted without a failing behavior.

## Commands and results

Used Node 22 (`/opt/homebrew/opt/node@22/bin/node`) and isolated randomly named fixture databases on the existing `legalChatQA` replica set at port 27028. Sandbox loopback denial (`EPERM`) on the first attempt was an environment restriction, not a product failure; reruns used approved execution outside that restriction.

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p server/tsconfig.json
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test scripts/phase07.2-backend.test.mjs scripts/phase07.test.mjs
```

Server type compilation passed. The focused regression passed. The combined recovery regression passed: 11 tests, 0 failures; the lead owns full phase01–07 build/regression and dependency-advisory evidence. This audit does not approve a UI direction or close the required accessibility observation.
