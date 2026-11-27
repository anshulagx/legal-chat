# Phase 7.2 frontend audit

Audit date: 2026-11-26. Baseline source revision: `ba22082e3597fe4e2fb6ceef2260e096b738b399`, plus the pre-existing phase-plan edits. Reviewed `main.tsx`, `chat.tsx`, `uploads.tsx`, `evidence.tsx`, `comparison.ts` and `sse.ts`. This is a focused source/behavior review; it does not establish full usability or accessibility acceptance.

## Baseline finding register (see approved implementation follow-up below)

| ID | Severity and confidence | Evidence and affected task | Remedy / disposition | Validation |
| --- | --- | --- | --- | --- |
| FE-01 | P1; high, reproduced defect | `client/src/uploads.tsx`, `action()`: indexing retry sets panel-local busy but does not inform the chat workspace. In a delayed retry from chat A, history navigation stays enabled. Switching to B displays B's file, but releasing A's retry calls its captured `load(A)` and replaces B's files. The heading still names B. This can also replace the comparison selection's available versions. | Fixed in `uploads.tsx`: propagate busy for attachment actions; honor the parent's disabled state; fence mutation-triggered reload/error by the attachment-list generation. No database or HTTP contract change. Owner: frontend auditor. | Baseline browser reproduction observed `{navigationEnabled:true, heading:"Chat B", attachmentFromA:1, attachmentFromB:0}`. New `scripts/phase07.2-frontend.test.mjs` holds the mutation response, verifies New chat/history/send disabled, then releases and switches to B, verifying only B's attachment remains. Passed 1/1. |
| FE-02 | P2; high, reproduced defect | `client/src/chat.tsx`, `loadConversations()`: list requests have component-lifetime cancellation but no request generation/order fence. Initial load can overlap the refresh after a first question; an older list may replace the newer result. | Fixed with a request-generation fence for list/error/loading state. Owner: frontend implementation. | Original chat source reproduced stale initial empty list erasing the refreshed conversation; integrated regression preserves it. |
| FE-03 | P2; high, reproduced defect | `client/src/chat.tsx`, `acceptDraft()` and `copyDraft()`: request outcomes use global problem/copy status without capturing `viewVersion`. Navigation during draft preparation can display an old chat's error or leave the next chat's draft controls busy. Message-ID mapping itself prevents a successful draft attaching to an unrelated message. | Fixed: draft success/error/busy and clipboard feedback fenced by view generation; selecting another chat clears local draft-busy state without removing durable server results. Owner: frontend implementation. | Original chat source reproduced old draft failure appearing in fresh chat; integrated regression suppresses it. |

FE-01's targeted regression directly verifies the normal user-facing protection. The generation fence is additional defense if a parent changes conversation props while a mutation is active; that exceptional prop-change path is not directly exercised by the new test.

## Boundaries reviewed

- Chat history selection already captures `viewVersion`, protecting its messages/loading/error updates against a later chat selection. Restored-generating history polling also has disposal and view checks. Streaming disables navigation and uses a synchronous active-send ref to prevent duplicate starts.
- Upload-list requests already have a generation fence. The reproduced defect was a later invocation of an *old closure* incrementing that generation, rather than an ordinary in-flight list response. Mutation feedback now respects the generation in which the action began.
- Component lifetime aborts cover chat/upload fetches and transfer XHR. Starter/history/upload intervals and citation key listeners have cleanup. History polls can overlap on slow networks; a hard performance/reliability impact was not measured here.
- Source viewer uses native dialog and aborts its fetch on dependency change/unmount; focus return is present. A fetch aborted during JSON parsing should still be guarded before committing state for complete cancellation robustness; no visible stale-source defect was reproduced.
- SSE JSON and history/source payloads are mostly trusted using casts. Comparison rendering has a closed catalog and runtime allowlist validation. A shared transport/runtime validation boundary would reduce duplication, but there is no confirmed malicious payload route or render vulnerability from this review. Do not report casts or file length alone as defects.
- Auth session refresh uses an abort controller and hides the private view during browser history restoration. This review did not prove all native browser back-forward-cache or session-expiry behaviors.

## Executed checks

Node used: `/opt/homebrew/opt/node@22/bin/node` (`v22.22.0`). Local Mongo replica set: port 27028; harness created and dropped random fictional databases. Headless installed Chrome, optional Playwright module `/private/tmp/bulls-browser.hXrEPA/playwright/index.mjs`. No live customer records or hosted services used.

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:client
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  QA_PLAYWRIGHT_MODULE=/private/tmp/bulls-browser.hXrEPA/playwright/index.mjs \
  node --test scripts/phase07.2-frontend.test.mjs
```

Client TypeScript/Vite build passed. Browser regression: 1 passed, 0 failed. Default sandbox execution could not connect to local Mongo (`EPERM`); the successful reproduction/regression used approved execution with local network access. These results are targeted implementation checks, not the independent phase gate. Visual design, screen-reader observation, native zoom and full acceptance replay remain separate requirements. No visual direction was implemented by this auditor.

## Approved implementation follow-up · 2026-11-27

Anshul approved the proposal with “lets implement the proposal”. `chat.tsx` now implements the scrolling transcript/composer dock, near-bottom following and Latest answer, native mobile history dialog with desktop rail, mounted separate admin destination, compact file disclosure, explicit ordered document selects and swap, and shared/private busy propagation. The visualViewport hook updates the workspace height and collapses file details when available height is below 500px. File errors and newly failed file transitions expand the disclosure; repeated failed-state polls do not force reopening after dismissal. Readiness announcements are delegated from the upload panel into one stable region outside the disclosure.

FE-02/FE-03 were reproduced using original `HEAD:client/src/chat.tsx` compiled in `/private/tmp/phase072-stale-before-7j7lcsi0`, preserving workspace changes. The initial attempt against the workspace distribution was invalid as baseline evidence because another agent had already built the fixes; the isolated original-source run observed both defects. After reversing the assertions to the intended behavior, `scripts/phase07.2-interactions.test.mjs` passed 2 tests, 0 failed against the implemented candidate. These checks use the current optional Playwright module `/private/tmp/legal-chat-phase072-tools/node_modules/playwright-core/index.mjs` and disposable Mongo replica set `mongodb://127.0.0.1:27029/?replicaSet=legalChatQA072`.

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  QA_MONGODB_URI='mongodb://127.0.0.1:27029/?replicaSet=legalChatQA072' \
  QA_PLAYWRIGHT_MODULE=/private/tmp/legal-chat-phase072-tools/node_modules/playwright-core/index.mjs \
  node --test scripts/phase07.2-interactions.test.mjs
```

Independent redesign QA remains separate. This implementation report does not substitute emulated viewport resizing for an actual mobile keyboard observation, and does not establish native zoom or screen-reader acceptance.
