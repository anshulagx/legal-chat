# Phase 7.2 independent frontend fix review

Date: 2026-11-26. Reviewer: backend audit agent; did not implement the frontend change. Scope: `client/src/uploads.tsx` action handling and `scripts/phase07.2-frontend.test.mjs`. Source review was read-only. This is targeted independent verification of FE-01, not a phase 7.2 PASS or design approval.

## Verdict

**PASS for the normal indexing-retry navigation reproduction addressed by FE-01.** The browser regression passed independently (1 test, 0 failures). Its sensitivity was checked against an isolated client build with `uploads.tsx` restored from HEAD: the same regression failed at the first navigation-disabled assertion (`false !== true`). The repository's working source and build were not reverted for this check.

The implementation propagates action busy state to the workspace, whose history/New chat selection and ordinary question submission controls honor that state. The action holds this state through the attachment reload, then clears it in `finally`. It also rejects a new action when the parent's `disabled` flag is true. A synchronous panel-local ref prevents duplicate actions before React state updates.

The captured attachment-list generation guards a completed mutation's reload and error feedback. It addresses the important distinction between an old response and an old closure starting a new request: existing list-response fencing alone did not prevent an old action from later loading its original chat's files into the newly selected view. Abort/lifetime checks prevent post-unmount UI feedback, and the action does not undo the durable server mutation.

## Observed checks

| Check | Actual observation | Result |
|---|---|---|
| Delay retry on chat A | Retry request held by the browser route fixture. Chat B, New chat and ordinary Send question controls disabled. | PASS |
| Release response and navigate | Chat B became selectable after A's action/reload completed; B heading and B's attachment present, A's failed attachment absent. | PASS |
| Test sensitivity | Same test against isolated original upload component failed: Chat B remained enabled. | PASS |

The route fixture returns a successful JSON response without executing an indexing job. This verifies browser state/transport behavior under delayed success, not indexing correctness or service availability. The test checks user-facing state and identity, rather than component internals or CSS.

## Limitations

The test does not force an out-of-band conversation prop change while the action is active, so the additional generation fence is source-reviewed, not directly exercised by this regression. It does not directly cover delayed mutation failure, logout/unmount, shared-document archive, or the disabled-action guard during streaming. These limits do not invalidate the verified normal navigation fix, but should not be described as independently tested paths.

The existing failed-answer `Retry reply` control and low-level `send()` guard do not use the uploading flag. This is an adjacent source observation: this test establishes the ordinary Send question protection, not exclusion of every possible concurrent reply action. No defect or impact from that adjacent path was reproduced in this review. The proposed visual redesign and remaining FE-02/FE-03 hypotheses were outside this assignment.

## Environment and executable evidence

Node 22.22.0; installed Chrome in headless mode; fictional isolated fixture databases on MongoDB replica-set port 27028. Approved local-network execution was required. No real customer or hosted service data was used.

```sh
PATH=/Users/anshulagarwala/.nvm/versions/node/v22.22.0/bin:$PATH \
QA_PLAYWRIGHT_MODULE=/private/tmp/legal-chat-phase072-tools/node_modules/playwright-core/index.mjs \
node --test scripts/phase07.2-frontend.test.mjs
```

Result: 1 passed, 0 failed. For sensitivity, copied the current runtime, fixture and client to `/private/tmp/phase072-frontend-independent-before-c0__0_d6`, restored only `client/src/uploads.tsx` from HEAD, built that isolated client, and ran the same command there. Result: 0 passed, 1 failed at the expected navigation assertion. The lead owns final integrated candidate/SHA identification and the complete phase gate evidence.
