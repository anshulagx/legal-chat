# Phase 7.2 design proposal

Date: 2026-11-26. Status: APPROVED by Anshul on 2026-11-27 ("lets implement the proposal"); implemented; see the final QA report for verified behavior and remaining observations. Baseline source: `ba22082e3597fe4e2fb6ceef2260e096b738b399` plus the pre-existing phase-plan edits. The direction and scope below are approved; acceptance still requires implementation evidence.

**Amendment, 2026-11-27.** Anshul replaced the visual tokens below (forest green, warm neutrals, serif auth headline, 44px control minimum) with a SaaS-style indigo/slate system, icons and badges. The interaction and state specification is unchanged. The amended tokens are recorded in the [QA report](phase07.2-qa-report.md#design-review-and-amendment).

Open [the interactive mockups](phase07.2-mockups.html) to select desktop/mobile and six screens. The PNGs below are proposed layouts, not screenshots of implemented behavior. Prototype controls illustrate navigation; they do not provide production focus trapping, session handling, uploads or chat.

## Direction and scope

Retain the existing forest green and warm neutral identity. Consolidate account chrome into one header, keep history in the left rail and make cited answers the primary reading surface. Give the customer a stable composer with file scope nearby. Use a dedicated Shared documents destination for administrators. Retain reviewer fixture downloads in an expandable “Try sample files” section within Files in this chat.

| Surface | Desktop proposal | Mobile proposal |
|---|---|---|
| Fresh chat | [1280px](phase07.2-proposed-desktop-fresh.png) | [390px](phase07.2-proposed-mobile-fresh.png) |
| Long answer | [1280px](phase07.2-proposed-desktop-long.png) | [390px](phase07.2-proposed-mobile-long.png) |
| Files / comparison | [1280px](phase07.2-proposed-desktop-comparison.png) | [390px](phase07.2-proposed-mobile-comparison.png) |
| Source viewer | [1280px](phase07.2-proposed-desktop-source.png) | [390px](phase07.2-proposed-mobile-source.png) |
| Shared documents | [1280px](phase07.2-proposed-desktop-admin.png) | [390px](phase07.2-proposed-mobile-admin.png) |
| Authentication | [1280px](phase07.2-proposed-desktop-auth.png) | [390px](phase07.2-proposed-mobile-auth.png) |

## Tokens and component responsibilities

| Token | Value / purpose |
|---|---|
| Canvas / surface | `#fbfaf7` / `#ffffff` |
| Main / secondary text | `#202927` / `#4b5651` |
| Primary / selected wash | `#215a51` / `#edf3ee` |
| Divider / control border | `#d5ded7` / `#858f88` |
| Error / highlighted quote | `#991b1b` / `#fff0a6`, with text labels |
| Typography | System UI; body 16px, line-height 1.6; page 28–32px; metadata 12–14px |
| Width / spacing | Answer column 720px max; 4/8/12/16/24/32 spacing; 16px mobile gutters |
| Controls / focus | At least 44px control height; visible 2px green focus outline with 4px offset; never hide focused controls behind composer |
| Surfaces | 12–16px radius for composer/user question; plain answer paragraphs; borders reserved for actionable grouping |

WorkspaceShell owns destination, header and responsive history. ConversationView owns history/stream identity. MessageList owns reader position; ComposerDock owns question and compact file status. FilesPanel owns upload progress/readiness and ordered comparison selection. SourceViewer retains the native modal dialog. AdminDocuments reuses file lifecycle controls in its own destination. Existing server authorization and A2UI allowlist remain authoritative.

## Interaction and state specification

- **Fresh and reopened chat:** fresh chat uses shared knowledge only; files stay in the chat where uploaded. New chat clears selections, draft, errors and attachment view. Selected history item has a textual/current state. Loading blocks conflicting send/upload actions and shows a local status; failed history offers retry without replacing the selected view.
- **Reading and streaming:** use a workspace height based on `100dvh`, an independently scrolling transcript and an in-layout composer below it. Follow content only when within 80px of the bottom or after explicit send/latest. Scrolling upward pauses following. “Latest answer” appears when content is below the view. Resize and incoming paragraphs must preserve the reader's anchor when following is paused. Use scroll padding for focus visibility.
- **Question submission:** keep the same textarea mounted and focused through generation, read-only while a reply is pending. Preserve the current Enter/newline behavior; do not introduce a new shortcut requirement. Show progress in one polite status region without announcing every token. Keep Stop reply reachable in the dock. On completion enable follow-ups; on failure keep question, saved partial paragraphs and selected files. Retry uses the existing idempotent attempt contract; show the cooldown next to its disabled control. Stale attempt actions never target another view.
- **Files:** Attach files expands the file area above the question. Always show a count/readiness summary near the dock when files exist. Expanded list labels private scope, filename, revision and queued/indexing/ready/failed state; failure offers reason and retry. Long filenames wrap. File readiness is announced once per transition. Ready files can be selected in explicit first/second order; allow swapping before submit. Two ready versions are required for explicit comparison; no duplicate version selection. Busy lifecycle actions prevent conflicting navigation until complete.
- **Comparison:** use actual filenames and revisions for both sides; preserve first/second order on mobile. Missing evidence is a visible sentence for that document. Paragraph/side citations stay beside their claim. No change to the pinned catalog or evidence authority.
- **Sources:** retain modal inspection with exact passage, original link, surrounding text and active/superseded/archived label. Loading and errors occupy the modal, with Close always available. Escape dismisses; focus returns to the citation. Abort and fence stale requests when closing/changing sources. Citation preview supports hover/focus and Escape; touch opens the source directly.
- **Mobile history:** History opens a native modal drawer with a heading, current item, explicit Close, Escape handling, contained keyboard focus and focus return. Selecting a chat closes it and focuses the chat heading or composer after load. At desktop widths keep the rail non-modal. During active send/upload, retain current navigation restrictions with a visible reason.
- **Admin:** navigation opens Shared documents without discarding the current chat. List active/replacement versions with readiness, failure reason, retry, replace and archive. Keep the active policy usable while replacement indexes. Earlier citations continue to open superseded originals. Customer sessions cannot render admin navigation and server guards remain unchanged.
- **Auth / session:** keep labelled email/password inputs, autocomplete, field errors and focus-first-invalid behavior. Loading, network retry and logout failures are visible. On expired session, abort private requests, clear mounted private views and route to login. Prototype shows signup and a login treatment; both production forms need actual scans.
- **Draft:** keep unresolved question, opt-in draft action, editable/copyable draft behavior as currently specified by the product, and visible copy success/failure. No send-email integration. Do not move focus merely because a paragraph or draft arrives.
- **Small screens / keyboard:** dock remains part of layout rather than an overlay. Measure `visualViewport` behavior on a real or explicitly emulated mobile keyboard; if visible transcript height becomes too small, collapse the expanded files panel and allow dock scrolling. At 320px use single-column comparisons and wrapped controls. At 768px test rail transition and at native 200% zoom ensure focused controls remain reachable.

## Competing approaches and recommendation

| Choice | Strongest alternative | Recommendation and trade-off |
|---|---|---|
| Persistent composer | Normal document flow is simpler, works naturally with browser scrolling and leaves more answer space on short screens. | Persistent in-layout dock reduces repeated travel after long replies. It costs transcript height and requires keyboard/zoom checks. Collapse file detail when space is constrained. |
| Source modal | Desktop side panel permits simultaneous answer/source reading, but narrows comparisons and adds responsive/focus complexity. | Retain native modal, keeping existing citation focus behavior and a full-width passage. Users temporarily lose simultaneous context. |
| Compact file access | Always expanded file list improves discoverability and immediate status visibility, but pushes the question down. | Compact count/status near question plus an expanded Files panel; automatically expand on attach/error and preserve scope text. Discoverability must be verified by task replay. |
| Admin destination | Inline disclosure is a smaller change and keeps all tasks on one page. | Dedicated destination matches PRD, reduces customer-flow clutter and gives lifecycle tasks enough space; retain a return-to-chat control and current state. |

These choices are design hypotheses supported by the app review, not user-study conclusions. Confidence is moderate until Anshul reviews and the implemented design completes task testing.

## Review decision and validation boundary

Anshul approved this direction on 2026-11-27 with "lets implement the proposal", satisfying Phase_7.2_Plan.md step C. The design-independent attachment race and HTTP error-response fixes can ship to the local candidate beforehand. No schema migration is proposed.

After approval: implement in small batches, independently review fixes, replay all six local acceptance flows and scan five surfaces at 320/390/768/1280px. Native zoom, keyboard and screen-reader observations remain distinct from automation. Prior phase 07 records an explicit manual-accessibility waiver; that is historical authorization for phase 07, not evidence that this proposed UI has been tested. Do not silently rewrite that gate history.

Evaluation references checked on 2026-11-26: [Nielsen's heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) provide broad status, recovery and consistency criteria; [WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies testable accessibility criteria. Neither source establishes that these app mockups meet those criteria. Tavily CLI could not initialize its protected home directory; the two primary pages were read with the web tool instead.
