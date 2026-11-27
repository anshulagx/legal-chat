# Phase 7.2 independent backend fix review

Date: 2026-11-26. Reviewer: frontend audit agent, who did not implement the backend fix or backend regression. Base revision `ba22082e3597fe4e2fb6ceef2260e096b738b399`; reviewed the current working-tree `server/src/chat.ts` diff and `scripts/phase07.2-backend.{test,fixture}.mjs`. This is independent verification of BE-01, not independent acceptance of the entire phase.

## Verdict

**BE-01 fix verified.** No additional actionable defect found in this one-condition change. The original finalizer ended an SSE-requested response even when no stream had started, committing HTTP 200 before the thrown `HttpError` reached Express. Requiring `started` leaves pre-header exceptions for the normal HTTP error handler and preserves ending a stream after headers/paragraphs have been sent. Timer and close-listener cleanup remains unconditional.

| Check | Observation | Result |
| --- | --- | --- |
| Server TypeScript compilation | `npx tsc -p server/tsconfig.json` completed with exit 0 under Node 22.22.0. | PASS |
| Fresh integrated targeted run | `node --test scripts/phase07.2-backend.test.mjs`: 1 test passed, 0 failed. | PASS |
| Independently reconstructed original-condition runtime | Copied compiled server and required test/helper files to `/private/tmp/phase072-independent-backend-before-kcjrhnh2`; restored only `streaming && !res.writableEnded` in its finalizer. The same test failed at the expected assertion: actual HTTP **200**, expected **503**. Repository source was not reverted or altered. | PASS: original defect reproduced |
| Pre-header recovery | Integrated test requires JSON HTTP 503, `ANSWER_UNAVAILABLE` and a request ID. | PASS |
| Durable reply/replay | Integrated test replays the same client message ID, receives completed `Fictional saved reply.`, and requires one original user-message record. | PASS |
| Already-started stream | Test fixture emits a paragraph before injecting the lookup exception; integrated test sees a paragraph and final SSE `error` with `ANSWER_UNAVAILABLE`. | PASS |
| Full phase 7.2 | Visual implementation/review, all acceptance flows and mandatory accessibility observations were not part of this review. | NOT EVALUATED |

The first temporary-runtime attempt omitted `scripts/account-validation.mjs`, so fixture startup failed. After adding that unchanged runtime dependency, the original-condition run reached and failed the intended HTTP assertion. The startup error is not used as defect evidence.

## Test and risk assessment

The fault fixture is test-only and injects a one-shot `Message.findOne` exception targeting the generated assistant attempt. It restores the model method on the matching lookup. This exercises the transport lookup after answer persistence; it does not claim that a real Mongo outage was observed. No production fault-control route, schema migration, provider contract change or authorization change was added.

The early-failure case depends on reaching its injected lookup before the existing 100 ms SSE admission timer fires. This run demonstrably exercised that path; a sufficiently delayed test environment could open the stream first and make its expected-503 assertion timing-sensitive. The late case explicitly opens the stream with a paragraph. This is a test robustness limitation to consider if CI shows intermittent timing failures, not evidence that the production fix is incorrect.

All runtime checks used approved local-network execution, the local `legalChatQA` replica set on port 27028 and disposable fictional databases created/dropped by the existing harness. No real provider/storage integration was invoked. The lead retains ownership of full regressions and the final gate; this report cannot close the outstanding design review or accessibility requirements.
