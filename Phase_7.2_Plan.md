# Phase 7.2 · UI/UX redesign and code quality

Status: COMPLETE · 2026-11-27 · ACCEPTED WITH USER WAIVER. Anshul approved the proposal on 2026-11-27 and amended its visual direction to a SaaS-style design the same day; the UI, amendment and audit fixes are implemented. Build, types, regression and browser checks pass on the final candidate. Anshul waived the remaining manual screen-reader and native-zoom observations; see the final QA report. Execution order: 07 → 7.2 → 08. Phase 7.2 is the user-requested inserted phase; it does not imply a separate phase 7.1 exists.

Implementation evidence: [QA report](qa/phase07.2-qa-report.md), [finding closure](qa/phase07.2-code-audit.md), [approved design](qa/phase07.2-design-proposal.md), [independent chat review](qa/phase07.2-independent-chat-review.md) and [independent design/code review](qa/phase07.2-independent-design-code-review.md).

The outcome is a clear, consistent support experience backed by code whose important failure modes and responsibilities have been reviewed. This document retains the implementation plan and its exit rules. The linked critique, audit, approved proposal and final QA report now provide the implementation evidence; the sequence below is not itself proof of acceptance.

## Scope and evidence

Use the [PRD](Legal_Support_Chat_PRD.md), [TRD](Legal_Support_Chat_TRD.md), [implementation plan](Implementation_Plan.md) and prior QA evidence as the baseline. Cover signup/login, fresh chat, history, long and streaming answers, attachments, comparison, sources, support drafts and admin document management. Include empty, pending, disabled, success, failure, interruption, retry and expired-session states where applicable.

Use [Nielsen's usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) for status visibility, familiar language, user control, consistency, error prevention/recovery, recognition and visual restraint. Use [WCAG 2.2](https://www.w3.org/TR/WCAG22/) as the accessibility reference. These provide evaluation criteria; they do not prove the current app has a usability defect or that a proposed design works. Validate app-specific conclusions through observed tasks. Automated scans alone cannot close the required screen-reader walkthrough.

The first source inspection identifies these starting points, not a finished browser critique:

| Source observation | Question to resolve in the audit |
|---|---|
| `client/src/chat.tsx` renders messages, version selection, composer and then uploads in document order; `style.css` has no persistent composer behavior. | How much navigation does a long answer require before asking again or seeing attached files? Can persistent controls preserve reading position, focus and mobile keyboard space? |
| `client/src/main.tsx` renders a workspace header and a separate account band; `style.css` uses bordered message cards, inputs and action controls. | Which chrome is useful, and which competes with the answer and primary action? Validate hierarchy, density and readability on actual screens. |
| `client/src/evidence.tsx` labels comparison sides “First version” and “Second version.” | Can users identify the actual agreement/amendment and comparison order without inferring it from citations? |
| `client/src/uploads.tsx` contains file upload and demo fixture affordances; `chat.tsx` also embeds admin management. | Are upload scope, readiness, comparison selection and admin navigation discoverable without crowding the question flow? Keep reviewer fixtures accessible. |
| Frontend state/requests span `main.tsx`, `chat.tsx`, `uploads.tsx` and `evidence.tsx`; backend `chat.ts` and `uploads.ts` combine several responsibilities. | Where do duplicated handling, state coupling or mixed responsibilities create demonstrable risk or make safe changes harder? File size alone is not a defect. |

Confidence is high in these source observations; user impact and the best design remain unvalidated. The next step to reduce uncertainty is a running-app walkthrough at a recorded revision with representative short and long conversations.

## Work sequence and deliverables

| Step | Work | Reviewable deliverable / dependency |
|---|---|---|
| 7.2-A · Baseline | Record revision, clean working state, Node/tool versions, startup procedure, existing commands, fixture set and test outcomes. Capture desktop/mobile screens and task paths. Reuse isolated fictional fixtures; do not expose secrets or real customer content. | Baseline evidence and explicit PASS/FAIL/BLOCKED checks. Existing failures must not be attributed to later changes. |
| 7.2-B · Critique and audits | Run the UI task review, frontend audit and backend audit in parallel. Inspect actual controls and behavior, not screenshots alone. Trace each code finding to a reachable path and reproduce suspected defects. | `qa/phase07.2-ui-ux-critique.md` and `qa/phase07.2-code-audit.md`, with a prioritized finding register. |
| 7.2-C · Design review | Produce desktop/mobile mockups for fresh chat, populated/long chat, attachment/comparison, source viewer and admin, plus an auth treatment and interaction/state specification. Define tokens and reusable component roles. Show primary flow, recovery and keyboard behavior. | `qa/phase07.2-design-proposal.md` plus mockups. Review the critique, proposed direction and trade-offs with Anshul before UI implementation. |
| 7.2-D · Implementation | Apply the reviewed direction and audit fixes in small, reviewable batches. Agree on shared contracts first; let backend work proceed independently where it does not depend on design choices. Reconcile integration after each batch. | Working app, targeted regression coverage and finding-by-finding fix references. Update README/TRD when actual contracts or commands change. |
| 7.2-E · Independent QA | Review the exact integrated candidate in a clean checkout. Replay the six acceptance flows locally, regression tests, viewport and accessibility checks. Verify fixes without relying only on implementer assertions. | `qa/phase07.2-qa-report.md`, before/after captures, tested SHA, finding dispositions and gate verdict. |

### UI/UX proposal requirements

Define a restrained visual system: semantic colors, type hierarchy, readable answer width, spacing, surfaces, borders, focus treatment, control sizing and state styles. Favor a clear question-and-answer hierarchy, visible primary actions and evidence that remains easy to inspect. Keep technical protocol identifiers and implementation details out of customer flows unless they help the user's task.

Specify a stable composer and deliberate scroll behavior: follow streamed content when the reader is at the bottom, allow reading earlier content without forced jumps, and provide a way back to the latest answer. Test resizing, long filenames, long comparisons and the mobile keyboard. The mobile history drawer needs an accessible trigger, close behavior, focus handling and a selected-chat indication.

Make attached-file scope and readiness understandable near the question flow. Give comparison sides recognizable document identities and explicit order. Preserve paragraph-level sources, superseded/archived labels, missing evidence and the copyable draft. Put admin document management in a clear admin destination with actionable status, retry and replacement feedback; retain role enforcement on the server.

Evaluate alternatives where the choice affects workflow: persistent composer versus normal document flow (reachability versus viewport space); source modal versus side panel (focused inspection versus room for context); compact attachment controls versus expanded file list (reading space versus discoverability). Recommend one coherent approach using task evidence. Do not turn this into a generic component gallery or a framework migration.

### Frontend audit and fixes

- Trace state ownership for navigation, sessions, selected conversation, history loading, optimistic turns, streaming, retry timing, attachments, source dialogs and drafts. Exercise slow requests, switching chats mid-request, logout/session expiry and unmount cleanup. Check aborts, stale responses, polling/interval cleanup and event listeners.
- Review duplicated fetch/error/session handling, unchecked JSON boundaries and type assertions. Introduce shared request handling and typed domain boundaries where they remove real duplication or risk. Keep client expectations aligned with server responses and the allowlisted A2UI renderer.
- Separate view components, transport and stateful behavior where it makes responsibilities clearer. Define reusable controls and design tokens without premature abstraction. Verify semantic markup, announcements, dialog/drawer focus, touch interaction and consistent errors.
- Review frontend dependency usage and bundle composition. Measure any reported performance problem before optimizing. Avoid dependency churn without a specific finding.

### Backend audit and fixes

- Trace authentication/session revocation, customer/admin authorization, origin checks, validation, HTTP errors, request IDs, throttling and private-data handling through every exposed route. Check resource/deadline bounds and test-only adapter isolation.
- Inspect transaction boundaries, duplicate requests, attempt fencing and leases, disconnect/cancellation, cooldowns, pagination and cross-process behavior. Review Mongo schemas/indexes, broad casts and `Mixed` persistence fields against runtime validation and compatibility with existing records.
- Inspect upload reservation/completion, immutable S3 version pinning, cleanup, worker claims/retries/publication, source authorization and exact anchors. Review retrieval evidence snapshots, provider response validation, A2UI allowlisting and masked, bounded telemetry.
- Consider extracting reservation/lifecycle/transport responsibilities from `server/src/chat.ts`, and schema/storage/admin responsibilities from `server/src/uploads.ts`. Extract only after identifying stable boundaries; preserve transaction sessions, fencing, response statuses and persistence semantics. Document any necessary schema change and migration/rollback before applying it.
- Inventory static-analysis and dependency-audit gaps. Add repository-local lint/type/format checks proportionate to the findings; choose tools during the audit and document executable commands. Treat advisory scanner results as leads requiring reachability and impact assessment, not automatically proven vulnerabilities. Record inaccessible advisory data as unknown.

## Finding register and priorities

Each finding needs an ID, area, evidence type (observed behavior, reproduced defect, source observation or hypothesis), file/line or screenshot, affected task, severity, proposed remedy, owner, validation and final disposition. Record confidence and unresolved uncertainty. Do not present stylistic preferences as correctness defects.

- **P0:** confirmed security/data-loss exposure or inability to run a core flow. Resolve first.
- **P1:** broken acceptance/recovery behavior, significant accessibility barrier or serious reliability risk. Resolve before PASS.
- **P2:** material interaction, clarity or maintainability issue. Implement the agreed phase scope; any deferral needs explicit rationale and Anshul's acceptance.
- **P3:** optional polish or low-impact cleanup. Fix when justified or document a reasoned deferral.

Every confirmed P0/P1 must be fixed and independently retested. Every audit finding must have a disposition; “reviewed” alone is insufficient. A disproved finding needs evidence. Do not use coverage percentages, shorter files or passing lint as proof of product quality.

## Sub-agent ownership and integration

The lead agent owns the plan, shared contracts, prioritization, design review, integration and final evidence. Use up to three concurrent sub-agents: a UI/UX reviewer, a frontend auditor and a backend auditor during discovery. After design review, assign frontend and backend implementation to separate owners and reserve independent review for an agent that did not implement the candidate being judged. Reuse agents sequentially when concurrency is full.

Assign non-overlapping files before edits. Shared DTOs, package scripts, lockfile, README and database contracts have one designated owner; other agents propose changes to that owner. Do not have concurrent writers refactor the same module. Independent QA records its own observations and returns failures for remediation and retest.

## Validation and completion

Use Node 22 or newer and an isolated disposable Mongo replica set. Run `npm run build`, all existing phase 01–07 suites and any new targeted suites against the final candidate. Install no production fault controls. Reuse the existing fixture harness; add behavior tests for confirmed defects and high-risk changed paths, rather than tests that mirror CSS or component internals. Re-run live dependency probes when affected contracts change; the local fixture suite does not prove hosted-provider behavior.

The QA guide defines task and accessibility evidence. Verify at 320, 390, 768 and 1280 CSS px, with native browser zoom and a real or emulated mobile keyboard observation clearly labeled. Capture screenshots at identical viewports/fixtures for comparisons. Automated scans cover all five surfaces, while human observation checks task clarity, focus, announcements and usability. Record any unavailable check as BLOCKED.

The exit requires the reviewed design implemented across its agreed scope, all six local acceptance flows preserved, zero unresolved P0/P1 findings, dispositioned lower-priority findings, passing required automated checks and an observed accessibility walkthrough on the final UI. The existing phase 07 accessibility requirement remains open until evidence closes it; it can be completed during this phase. After independent PASS, follow the main plan's tested-SHA GitHub checkpoint. Packaging, hosted deployment and video remain phase 08.
