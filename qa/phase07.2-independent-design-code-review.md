# Phase 7.2 independent design/code review

Date: 2026-11-27. Reviewer: frontend audit agent. Independently reviewed changes owned by other implementers in `client/src/main.tsx`, `style.css`, `evidence.tsx` and the visual/readiness changes in `uploads.tsx`. The reviewer implemented `chat.tsx` and the earlier upload busy/generation fix; those changes are explicitly excluded as independent evidence here. Base revision: `ba22082e3597fe4e2fb6ceef2260e096b738b399`, current working-tree candidate.

## Findings

| ID | Priority / evidence | Reproduction | Disposition |
| --- | --- | --- | --- |
| IR-01 | P2, high-confidence observed hoverability regression. `evidence.tsx`, `CitationLink.showPreview()` positions an above-anchor tooltip using its maximum height rather than its rendered height. | With a short quote and citation near the transcript bottom at 1280×900, anchor top was 484.52px, tooltip top 238.52px and actual height 54.39px. The resulting gap was 191.61px. Traversing that gap over 500ms dismissed the tooltip via its 120ms leave timer before the pointer reached it. The existing long-quote tooltip test has a full-height quote and does not exercise this case. | Fixed by evidence owner using the actual tooltip edge (`translateY(-100%)`) and available side space. Independently reran the original static-client scenario against final asset `index-CYjba_q6.js`: gap reduced to 6px and the quote remained visible when crossing at the original approximately 400px/s pointer speed. New owner regression also covers short quote adjacency and pointer traversal. |

Reproduction used the actual built client served by a temporary static HTTP server with fictional stubbed session/conversation/history/attachment responses (`/private/tmp/phase072-tooltip-static.mjs`). No database, hosted model or customer records were needed. The initial extra Mongo-backed short-viewport probe failed fixture readiness with repeated health 503s; that environment/setup failure is not product-defect evidence.

## Source review observations

- `main.tsx` consolidates the account information into native `details`, preserves labelled fields, autocomplete, field-level errors and first-invalid focus, keeps logout visible and gives initial workspace focus an accessible name. The header account disclosure is a disclosure, not a modal; no invented focus-trap requirement was imposed on it.
- CSS implements the approved warm-neutral/forest-green tokens, 720px reading column, plain answer hierarchy, separated user question, bounded in-layout composer, desktop history rail/mobile modal treatment, single-column mobile comparisons and wrapping filenames. Explicit hidden-state CSS keeps the inactive mounted destination out of layout and keyboard navigation. This source inspection supports implementation alignment; it is not a substitute for viewport and native-zoom observations.
- Comparison identity resolves by pinned `versionId`, uses actual uploaded filename/revision when available, and otherwise searches only citations for that same version across rows. Missing evidence stays explicit and actual left/right order is preserved. The allowlisted catalog validation remains unchanged.
- Source requests now check abort status both after response arrival and after JSON parsing, closing the stale-result window. Native source-dialog Close/Escape/focus-return behavior is retained. Exact quote, original link and readable surrounding text remain in the same inspection surface.
- Upload readiness announcements deduplicate per version/state and can be delegated to the stable parent live region outside the collapsed disclosure. Uploading, retrying and archiving have distinct activity text. Shared/private scope, revision, published/archive state, failure reason and sample-file downloads remain visible in their relevant surfaces. No storage, authorization or persistence contract changed in these UI edits.
- The portal avoids transcript clipping and includes pointer-leave delay, Escape dismissal and scroll/resize cleanup. The short-content placement issue above is a specific regression in its initial placement math, rather than evidence that portals are unsuitable.

## Verification boundary

IR-01 independent retest passed. Independent final evidence-suite execution passed all 5 tests (0 failures, 0 cancelled) against the built candidate containing the corrected tooltip. Backend agent separately owns integrated browser/accessibility QA. This report does not independently validate this reviewer's chat implementation and cannot declare phase PASS. Native zoom, real or explicitly emulated mobile keyboard and observed screen-reader walkthrough remain separate evidence requirements.

## Final independent execution

Final browser assets: `index-CYjba_q6.js`, `index-Du4hV38z.css`. Node 22.22.0, installed headless Chrome, optional Playwright from `/private/tmp/legal-chat-phase072-tools/node_modules/playwright-core/index.mjs`, disposable `legalChatQA072` replica-set databases on local port 27029. No hosted provider calls.

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  QA_MONGODB_URI='mongodb://127.0.0.1:27029/?replicaSet=legalChatQA072' \
  QA_PLAYWRIGHT_MODULE=/private/tmp/legal-chat-phase072-tools/node_modules/playwright-core/index.mjs \
  node --test scripts/phase07.2-evidence.test.mjs
```

Result: **5 passed, 0 failed, 0 cancelled**, approximately 29.1 seconds. Covered reversed/reopened comparison identity including a missing side; source loading dismissal, focus return and reopening; long-quote portal bounds, pointer hover and Escape; deduplicated file readiness while collapsed and toggled; short-quote adjacency and pointer traversal. These are the other implementer's tests independently executed, plus the reviewer's separate static-client IR-01 reproduction/retest.

An earlier full run loaded the readiness fixture before its attachment counter was corrected: 4 tests passed and the readiness check timed out waiting for a history item the fixture did not expose. The owner corrected that fixture; the complete final rerun above passed. No product behavior was changed to accommodate that setup correction.

Within this bounded review there are **no remaining confirmed actionable findings** in the independently reviewed changes. This is not a full-phase PASS or an accessibility certification; the independent integrated browser report and mandatory observations control the phase gate.
