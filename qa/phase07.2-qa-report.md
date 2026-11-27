# Phase 7.2 QA report

Date: 2026-11-27. **Phase gate: ACCEPTED WITH USER WAIVER.** Implementation, design amendment and all automated checks PASS on the final candidate. On 2026-11-27 Anshul explicitly chose to record a waiver for the remaining manual observations (observed screen-reader walkthrough and native browser 200% zoom) and close the phase. The waiver removes the acceptance blocker; it does not establish screen-reader behavior or full WCAG conformance. Tested commit, clean-checkout result and GitHub checkpoint: [checkpoint record](phase07.2-checkpoint.json).

## Design review and amendment

Original direction: [approved proposal](phase07.2-design-proposal.md), Anshul's 2026-11-27 instruction “lets implement the proposal.” Its interaction and state specification (one account header, stable in-layout composer, separately scrolling transcript, ordered document identities, native modal history/sources, dedicated admin destination, sample files under Files in this chat) is retained unchanged.

**Visual amendment, 2026-11-27.** Anshul then requested “a UI revamp … to make it look more like a SAAS prod application.” This supersedes the proposal's visual tokens only:

| Proposal token | Amended value |
|---|---|
| Forest green `#215a51` primary, warm canvas `#fbfaf7` | Indigo `#4f46e5` primary (hover `#4338ca`), slate neutrals: canvas `#f8f9fb`, text `#101828`/`#344054`, muted `#5d6679`, borders `#eaecf0`/`#d0d5dd` |
| Serif auth headline | Sans-serif headline on an indigo gradient panel with three feature points; form in an elevated card |
| ≥44px controls; 2px green focus outline, 4px offset | 36–44px controls (all above the WCAG 2.2 AA 24px target-size minimum; auth inputs/buttons remain 44px); 2px indigo focus outline, 2px offset |
| Bordered, text-only controls | Inline SVG icons (`client/src/icons.tsx`, `aria-hidden`), status badges for file readiness, avatar account menu, assistant avatar, user-question bubble, citation chips, fixed chat-title header |

Accessible names, headings, labels, live regions, dialogs, routes and API contracts are unchanged; the question label is now visually hidden but still programmatically associated. The design was implemented by the lead agent in this session rather than a separate implementer, and verified by the same agent; see limitations.

## Environment

Node 22.22.0; Chrome 158.0.8127.37 headless; Playwright-core 1.65.1; axe-core 4.10.3. Disposable fictional databases on `mongodb://127.0.0.1:27028/?replicaSet=legalChatQA` (data path `/tmp/legal-chat-qa-mongo`); the harness creates and drops its own databases on dynamic local origins. Cookies, credentials and signed URLs are excluded from evidence. Browser contexts bypass CSP solely for axe injection; application CSP is unchanged. Runtime/test file hashes: [candidate manifest](phase07.2-candidate-manifest.json).

## Results

| Required check | Expected and actual observation | Evidence | Result |
|---|---|---|---|
| 7.2.1 Audit closure | FE-01/BE-01 fixes and their independent reviews are unchanged by the visual amendment. FE-02/FE-03 delayed-list/draft regressions, missing-side identity, delayed source dismissal, tooltip and readiness tests pass on the final UI. No unresolved confirmed P0/P1. | [Audit register](phase07.2-code-audit.md), [targeted tests](phase07.2-targeted-browser.log), [regression](phase07.2-regression.log) | PASS |
| 7.2.2 Design fidelity/task clarity | Auth, fresh chat, long chat, comparison/files, sources, history drawer and admin captured at 320/390/768/1280 CSS px with no horizontal overflow. Inspected against the proposal's interaction specification and the amended visual direction. A 320px source-title wrapping defect found during this review (filename broke mid-word beside Close source) was fixed by giving the title its own row on mobile, then recaptured. | [Browser observations](phase07.2-browser.json), captures below | PASS for reviewed implementation; subjective preference is Anshul's |
| 7.2.3 Local acceptance replay | All six flows replayed with deterministic local fixtures (table below). Compose and hosted acceptance remain phase 08. | 82-test regression, 18-check browser run | PASS within local fixture scope |
| 7.2.4 Interaction edges | Ten-paragraph cited stream follows bottom, preserves a paused reader across new paragraphs, and Latest answer returns to bottom. Composer reachable after a long reply at four widths. Drawer Escape/focus return, delayed source dismissal, explicit file order/swap, admin draft/reader preservation, partial retry/cancel, 429 countdown, logout and session expiry pass. | [Comprehensive browser log](phase07.2-comprehensive-browser.log), [targeted log](phase07.2-targeted-browser.log) | PASS |
| 7.2.5 Accessibility | 28 axe scans (seven surfaces × four widths): zero violations. Remaining incomplete items resolved below. Keyboard order, native modal Escape/focus return, citation previews and emulated short viewport pass. Observed screen-reader walkthrough and native 200% zoom not performed. | [Browser JSON](phase07.2-browser.json) | AUTOMATED PASS; MANUAL WAIVED |
| 7.2.6 Code/regression | `npm run build` and `npm run typecheck` pass. 82/82 regression tests (phases 01–07, client stream, grounding, telemetry, 7.2 backend), 8/8 targeted browser tests, 18/18 comprehensive checks. `npm audit` reports zero advisories across 241 dependency records; no package or lockfile change in the amendment. | [Regression](phase07.2-regression.log), [advisory result](phase07.2-dependency-audit.json) | PASS |

## Six local acceptance flows

| Flow | Actual local evidence | Boundary |
|---|---|---|
| 1. Grounded support/source | “What is the notice period?” starter streamed a cited policy answer; the source modal showed the exact passage and original link. Phase 05 tests verify TXT offsets, PDF page and original bytes. | Deterministic provider and fixture storage. |
| 2. Agreement comparison | Reopened pinned comparison shows filenames/revisions and explicit first/second order on both sides, including missing evidence; explicit selection and Swap order pass. | Ready versions seeded; upload/index lifecycle covered by phases 03/04. |
| 3. Absent term/draft | Missing liability cap offers an opt-in draft; accepted draft persists and Copy writes subject plus body to the clipboard. | No email delivery. |
| 4. New/reopened chats/isolation | History reopen, delayed list refresh, cross-customer and admin denial, logout and expiry clearing pass. | Fictional accounts. |
| 5. Shared policy/admin | Dedicated admin destination hides chat controls and preserves the unsent question and reader position; customer denial, replacement and archive with historical source labels pass. | Replacement publication seeded in browser; real paths in phase 04. |
| 6. Failure/recovery | Partial failure retry keeps one question with two attempts; Stop reply offers retry; 429 keeps the question once and enables retry after the countdown. Regression covers cooldown, restart/lease recovery and cancellation. | Deterministic faults only. |

## Scanner incomplete dispositions

- **Auth cover (`.brand`, `.cover-title`, feature items, `.cover-footnote`), signup and login:** “background color could not be determined due to a background gradient.” The cover's gradient blends `#4f46e5`, `#1e1b4b` and `#7c3aed` at 40% alpha over `#1e1b4b`; the lightest region is the `#4f46e5` stop. Worst-case contrast: white text 6.29:1, `#e0e7ff` feature and footnote text 5.10:1. The footnote was changed from `#c7d2fe` (4.22:1 worst case) to `#e0e7ff` during this review.
- **Source quote `<mark>` at 320px:** “partially overlaps other elements” because the dialog header is sticky. Computed `#101828` on `#fef08a` is 15.25:1; the 320px capture shows the passage unobstructed.
- Earlier composer-dock and avatar incompletes were removed by replacing decorative gradients with solid `#ffffff` and `#e0e7ff` backgrounds (avatar text 8.06:1).

## Captures

Before (pre-amendment baseline): [long desktop](phase07.2-before-long-desktop.png), [long mobile](phase07.2-before-long-mobile.png), [fresh desktop](phase07.2-before-fresh-desktop.png), [comparison desktop](phase07.2-before-comparison-desktop.png), [source](phase07.2-before-source.png), [auth](phase07.2-before-auth.png).

After (final candidate): [fresh 1280](phase07.2-after-fresh-1280.png), [fresh 390](phase07.2-after-fresh-390.png), [matched long desktop](phase07.2-after-match-long-desktop.png), [matched long mobile](phase07.2-after-match-long-mobile.png), [comparison 1280](phase07.2-after-comparison-1280.png), [files 390](phase07.2-after-files-390.png), [source 1280](phase07.2-after-source-1280.png), [source 320](phase07.2-after-source-320.png), [admin 1280](phase07.2-after-admin-1280.png), [login 1280](phase07.2-after-login-1280.png), [login 390](phase07.2-after-login-390.png), [history drawer 390](phase07.2-after-history-390.png), [emulated keyboard](phase07.2-after-keyboard-emulated.png). Other files follow `phase07.2-after-{signup,login,fresh,comparison,files,source,admin,long}-{320,390,768,1280}.png`. Some headless captures taken immediately after a viewport resize show a stale band of the previous frame at the bottom (for example signup 768); this is a capture artifact also present in the pre-amendment baseline, not rendered page content.

## Limitations

- Manual screen-reader walkthrough and native browser 200% zoom were waived by Anshul on 2026-11-27, not observed.
- The visual amendment was implemented and verified by the same agent; prior independent reviews cover the audit fixes and the original redesign, not the amended styling.
- Reduced viewport emulates keyboard space only; no real mobile OS keyboard observation.
- Deterministic fictional provider, storage and retrieval adapters; no hosted deployment, Compose or live provider quality assertion.

## Reproduction

```sh
export PATH=/Users/anshulagarwala/.nvm/versions/node/v22.22.0/bin:$PATH
export QA_MONGODB_URI='mongodb://127.0.0.1:27028/?replicaSet=legalChatQA'
export QA_PLAYWRIGHT_MODULE=/private/tmp/legal-chat-phase072-tools/node_modules/playwright-core/index.mjs
export QA_AXE_PATH=/private/tmp/legal-chat-phase07-tools/node_modules/axe-core/axe.min.js
npm run build
npm run typecheck
node --test --test-concurrency=3 scripts/phase0[1-7].test.mjs scripts/client-stream.test.mjs scripts/grounding.test.mjs scripts/phase07-telemetry.test.mjs scripts/phase07.2-backend.test.mjs
npm run test:phase07.2:browser
npm run qa:phase07.2
```

Build output: 268.23 kB JavaScript (82.46 kB gzip) and 34.83 kB CSS (8.11 kB gzip). Sizes are measurements, not a performance benchmark.
