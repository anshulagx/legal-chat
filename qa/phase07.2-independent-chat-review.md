# Phase 7.2 independent chat review

Date: 2026-11-27. Reviewer: UI-review agent; did not implement `client/src/chat.tsx` or `client/src/style.css`. Read-only review of those files against the approved proposal. This reviewer implemented evidence/upload components, so this document does not independently approve those components. No new confirmed actionable chat/CSS defect was found in the scope below. This is not a complete phase gate verdict.

Candidate identification: working-tree client built as `/assets/index-CYjba_q6.js` during the browser observations. Source SHA-256 at review: chat `1fc6c0392b9d1fb2f6abd39a0ce4323b9d205589e3704e47d1315291e2555e31`; stylesheet `acfe20cb76f8b4c5dfd33b24fc4e7ab877832ca916682eb51e35ce766e1ad004`. The lead owns the final integrated candidate manifest and independent clean-copy QA.

## Own browser observations

Used Node22.22.0, installed headless Chrome, isolated Playwright and the existing phase05 fictional harness on `mongodb://127.0.0.1:27029/?replicaSet=legalChatQA072`. Random disposable database was deleted by fixture cleanup. No production records or hosted services were used.

| Check | Observed result | Disposition |
|---|---|---|
| Mobile delayed-history switch | Held chat A history response, selected A, reopened mobile history while A loaded, selected B, then released A. B's heading and user message remained selected. | PASS: old response did not replace current view. |
| Selected mobile chat focus | After B loaded and drawer closed, the actual focused element was B's `h1`. | PASS: selected-chat focus specification observed. |
| Drawer across breakpoint | Opened native history modal at390×844, resized to1280×900. Native dialog `open` became false, desktop rail was visible, and New chat remained interactive. | PASS: no lingering modal/inert background observed. |
| Actual comparison selector name | Opened two-file comparison controls and inspected Playwright `ariaSnapshot()` of the first combobox. First line was `combobox "First document"`; filenames and revisions were separate option children. | PASS: no observed accessible-name concatenation defect. Exact `getByLabel('First document')` locator matching is a harness issue here; semantic combobox name is clean. |

Executed `/opt/homebrew/opt/node@22/bin/node /tmp/legal-chat-phase072-independent-chat.mjs` with the QA Mongo URI. Final probe exited0. One preliminary probe assertion incorrectly required a single newline in `innerText`; actual content used two newlines. Normalized whitespace and reran the complete probe. This was a test expectation correction, not an app defect.

Actual accessible snapshot:

```text
- combobox "First document":
  - option "Choose a document" [selected]
  - option "original.txt · Revision 1"
  - option "amendment.txt · Revision 1"
```

## Own source inspection

- **Reading/streaming:** `updateScroll` uses the proposal's80px threshold. Explicit send/latest enables following; message/layout resize handlers scroll only while following. The resize observer skips a transcript with no rendered client rectangles, avoiding hidden-admin-view measurements resetting the reading state. Transcript overflow is independent from the bounded in-layout composer dock. I source-reviewed these decisions; I did not independently replay the timed long-stream fixture in this assignment.
- **History lifecycle:** native `showModal`/`close`, Escape via `onCancel`, breakpoint cleanup, selected-chat heading focus and explicit close are present. Desktop controls are separate from closed-dialog controls. The runtime checks above cover slow selection and breakpoint cleanup; repeated Tab cycles and Escape focus return are part of the backend QA agent's browser script, not new observations by me here.
- **Request/draft fencing:** conversation list responses use a generation token; selected-history completion/error/loading state uses `viewVersion`; generating-history polling has disposal/version/lifetime checks and cleans its interval. Draft response/error/finally and copy-result feedback use the selected-view token. Selection clears stale citation/draft-busy/retry/file state. Admin destination changes preserve the mounted chat instead of creating a new view identity, allowing a draft for that same chat to complete without discarding it.
- **Busy semantics:** navigation controls, ordinary/follow-up/retry submission and low-level `send` reject active upload/shared-file work. The failed-attempt retry button now uses `navigationBusy`, closing the earlier audit's adjacent source concern. The child panel stays mounted when its details or destination is hidden. Busy controls explain why navigation is paused. Lifecycle correctness beyond this client exclusion remains covered by server tests.
- **Files/selection:** current-chat scope, readiness counts, external live status, failure expansion, explicit first/second controls, duplicate-option exclusion, swap and clear match the proposal. A single selected comparison document is rejected before send rather than silently losing order. New-chat selection clears the selection and attachment identity state.
- **Layout:** hidden destinations use an explicit `[hidden]` rule, independently scrolling regions have minimum height/width bounds, focused controls receive outline/scroll-padding, and small viewport rules reduce composer size. The visual-viewport listener cleans up and collapses files when available height is small. These source properties do not prove native keyboard or zoom usability.

## Other-agent evidence and limits

The backend agent owns the integrated `scripts/phase07.2-browser.mjs` observations: timed following/paused reading/latest, admin return preserving draft and reading position, four viewport sizes, emulated keyboard height, focus scans, stale source dismissal, acceptance/recovery/session flows and accessibility scans. I inspected that script's assertions but do not claim its pending/completed outcomes as independently observed by this reviewer; use its final report and candidate identity.

The frontend agent independently reviews my evidence/upload implementation, including tooltip hover behavior. That review is separate from this chat review. No native200% browser zoom or real screen-reader walkthrough was performed by me. Final phase status must retain those observation limits and any explicit user disposition recorded by the lead.
