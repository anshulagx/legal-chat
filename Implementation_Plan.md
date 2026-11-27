# Implementation plan

Legal support chat · Release 1

**GitHub repository** · [anshulagx/legal-chat](https://github.com/anshulagx/legal-chat)

Build one reviewable increment at a time. The [PRD](Legal_Support_Chat_PRD.md) defines the customer experience and acceptance flows. The [TRD](Legal_Support_Chat_TRD.md) specifies routes, state transitions, storage and provider choices. Phase numbers below describe build order. All gates start **unreviewed**.

## Before wave 01

**Anshul owns the baseline commit.** Commit the PRD, TRD, this plan and all eight guides under `qa/`, then push them to GitHub. The implementation agent records the repository, target branch and baseline commit SHA and verifies the documents are present at that SHA.

**Collect access in one handoff before writing application code.** The implementation agent asks Anshul for the outstanding items below together. Use existing authenticated sessions or scoped project access where available. Put secret values in an ignored local environment file or the hosting secret store. Share only resource names, settings and secret locations in the handoff. Commit example files with placeholders.

| Dependency | Access or decision to collect | Preflight verification |
|---|---|---|
| GitHub | Repository URL provided above. Confirm target branch, authenticated push access and any existing PR rules | Fetch the baseline SHA. Confirm repository write permission and the branch or PR route for wave commits. |
| MongoDB Atlas | Development/test and production database names, scoped connection strings, network access, and access to provision text and vector indexes | In a disposable development namespace, write across two collections in one transaction, abort and verify both writes rolled back. Create text and vector indexes using the measured embedding dimensions. Wait for readiness with a timeout. Query each with version and generation filters and verify the expected fixture ID is returned and an excluded decoy is absent. Clean up the probe resources. |
| Amazon S3 | AWS region, private versioned bucket names or environment prefixes, scoped credentials or role, and access to configure allowed origins | Inspect versioning, public-access block and CORS. Use a disposable development object to verify signed upload and a version-specific read. |
| OpenRouter and embeddings | API key, allowed chat and embedding model candidates, quota or spend ceiling, and endpoint/key if embeddings use another provider | Within the approved allowance, run a small chat and embedding request. Pin the embedding model and measured dimensions before the Atlas vector probe. Record both alongside the chat candidate. Phase 05 selects the final chat model. |
| Langfuse Cloud | Project host/region, project keys, environment labels and dashboard access for the demo | Send a content-free development trace and locate its ID in the dashboard. |
| Render | Workspace/service access, GitHub integration, permission to deploy and manage secrets, service plan and intended production origin | Verify repository visibility, service configuration access and the origin to use for cookies and S3 CORS. |
| App configuration and demo | Admin seed email, location for the seed password, development origin and intended video destination with upload/share access | The agent can generate separate JWT secrets, seed passwords and fictional QA identities. Confirm where secrets will be installed and how reviewers will open the video. |

### Environment verification gate

Before collecting credentials, use the existing [.env.example](.env.example) as the variable inventory. Document each variable’s purpose, required or conditional status and probe. As a pre-wave deliverable, provide a standalone command, `npm run preflight -- --env-file <path>`, with its dependencies and setup instructions. It must run from a clean checkout before the app exists, return a nonzero exit for failed or blocked checks and report manual observations separately. Confirm recording access and a screen reader or operator for the accessibility walkthrough.

Once Anshul confirms the environment file is populated, run the preflight before writing application code. Load the specified file in a fresh process with a dotenv parser. Use the supplied values for every probe so a cached login or an inherited shell credential cannot mask a broken setting.

1. Inventory every required variable by name. Check for missing, blank or placeholder values and validate types, URLs, origins, model IDs and numeric limits. Exercise local settings where possible, including signing and verifying a disposable JWT and checking the seed credentials against the planned signup rules.
2. Run the live checks in the table for each supplied environment and credential set. Verify the intended database, bucket, model and project. Use disposable development fixtures for write probes and read-only checks on production resources. Verify local Node/npm, Docker Compose and browser access. Repeat deployment-specific runtime checks against the hosted app in wave 08.
3. Give Anshul a redacted report mapping each required variable by name to its check, result and observed evidence. For example, report the embedding model and returned dimensions or the successful read of the pinned S3 version. Keep secret values, connection strings and signed URLs out of output.
4. Start wave 01 only after every required preflight check passes. Mark a failed request **FAIL** and a check that could not run **BLOCKED**. Report the affected setting and correction needed. After a correction, reload the file, rerun affected and dependent checks, and update the verdict.

## How to run a phase

The implementation agent commits the wave locally and hands the independent QA sub-agent the candidate SHA, startup command, test origin, fixture locations and test controls. The reviewer runs the linked guide from a clean checkout at that SHA and records evidence separately. A failed check requires a fix, a new candidate SHA and a rerun of affected checks and earlier regressions. A missing prerequisite keeps the gate BLOCKED.

**GitHub checkpoint after every wave.** After PASS, push the exact tested commit to the agreed GitHub branch or submit it through the required PR route. Record the tested SHA, verified remote SHA, link and verdict. For protected branches, verify the merge reached the target and its resulting tree matches the reviewed tree. If integration changes the tree, review the resulting candidate before advancing. A pending PR or failed push keeps the checkpoint open.

**Regression evidence.** The implementation agent supplies the root npm test commands named in the QA guides in the wave that introduces each behavior. Each suite runs repeatable assertions on isolated fixtures and exits nonzero on failure. The independent reviewer runs the suite and records individual case results alongside the browser observations.

Use an isolated test environment for replay, fault injection, worker pauses and low quotas. Start with two customer accounts A and B and a separately seeded admin. Keep fixture originals and expected excerpts together so a reviewer can establish the answer from the source before querying the app. Use real hosted dependencies at integration and release gates. Expose deterministic provider and clock controls only in test execution.

| Phase | Review condition | Independent QA guide |
|---|---|---|
| 01 · Foundation and account sessions | An authenticated customer can enter and leave a running app. | [Run gate 01](qa/QA-01-foundation-and-account-sessions.md) |
| 02 · Conversations and durable turns | A user turn has one durable identity, including when the first request is repeated. | [Run gate 02](qa/QA-02-conversations-and-durable-turns.md) |
| 03 · Direct uploads and immutable originals | The browser uploads a private original and the server pins the exact bytes for processing. | [Run gate 03](qa/QA-03-direct-uploads-and-immutable-originals.md) |
| 04 · Indexing and policy publication | A ready version is searchable and a failed replacement leaves the previous policy available. | [Run gate 04](qa/QA-04-indexing-and-policy-publication.md) |
| 05 · Grounded answers, streaming and citation viewing | A suggested question streams an answer whose claims can be checked in the original source. | [Run gate 05](qa/QA-05-grounded-answers-streaming-and-citation-viewing.md) |
| 06 · Agreement comparison and support handoff | The customer can verify both sides of a change and copy a draft for an unresolved question. | [Run gate 06](qa/QA-06-agreement-comparison-and-support-handoff.md) |
| 07 · Failure recovery, observability and accessibility | A failed or interrupted answer can be retried without losing the question, attachments or partial response. | [Run gate 07](qa/QA-07-failure-recovery-observability-and-accessibility.md) |
| 7.2 · UI/UX redesign and frontend/backend code quality | The reviewed design works across the acceptance flows, audit findings are resolved or explicitly dispositioned, and earlier behavior remains verified. | [Run gate 7.2](qa/QA-07.2-design-and-code-quality.md) |
| 08 · Hosted release and recorded acceptance | A reviewer can reproduce the application and follow the complete hosted demonstration. | [Run gate 08](qa/QA-08-hosted-release-and-recorded-acceptance.md) |

## Phase 01 · Foundation and account sessions

**Product scope.** Assignment and release requirements · authentication, configuration and handoff. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§1–2, 4, 8](Legal_Support_Chat_TRD.md)

1. Create client/ (React, Vite, TypeScript, Tailwind) and server/ (Express, TypeScript, Mongoose). Serve the built client and API on one origin. Reuse the preflight environment template and validation rules. Add the application lockfile, development start instructions, and coarse liveness/readiness routes. Use separate environment settings and validate required configuration at startup.
2. Implement normalized unique emails, bcrypt with the 72-byte limit, customer-only signup and environment-seeded admin. Sign short-lived JWTs, validate claims and active sessions, and revoke on logout. Keep the token in an HttpOnly SameSite=Lax cookie, Secure on HTTPS. Check Origin for browser mutations.
3. Build signup/login forms, associated field errors, protected shell and logout. Add request IDs and authentication throttling by IP. Establish local test identities and document how to create isolated test data.

**Review condition.** An authenticated customer can enter and leave a running app. Complete the [phase 01 QA guide](qa/QA-01-foundation-and-account-sessions.md).

## Phase 02 · Conversations and durable turns

**Product scope.** Customer experience · fresh chat and conversation ownership. Assignment · chat and persistence. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§2, 4, 6–7](Legal_Support_Chat_TRD.md)

1. Implement owned conversations, sidebar summaries with cursor pagination, and ordered messages with sequence allocation. Start a conversation on first send or first attachment. Hide abandoned empty drafts. Derive the title from the first question.
2. Implement POST /chat/send and GET /chat/history over a test-injectable answer adapter. Atomically reserve the thread, user turn and attempt. Enforce unique owner/clientMessageId even when no thread ID exists, detect conflicting payloads and serialize active generation per thread. Store status and IDs for replay.
3. Render an optimistic question, fresh centered composer on every login, and selectable history. Fetch by conversation ID and enforce ownership server-side. Use a deterministic adapter in tests until grounded generation arrives in phase 05.

**Review condition.** A user turn has one durable identity, including when the first request is repeated. Complete the [phase 02 QA guide](qa/QA-02-conversations-and-durable-turns.md).

## Phase 03 · Direct uploads and immutable originals

**Product scope.** Customer experience · conversation-scoped uploads. Administrator experience · shared file management. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§2–4, 8](Legal_Support_Chat_TRD.md)

1. Implement customer attachment and admin document reservations with ownership or role checks. Allocate an opaque key, immutable version record, five-minute signed S3 form, size/type policy and idempotent client upload ID. Atomically count reservations toward five attachments per thread. Configure private versioned S3 and origin-specific CORS.
2. Build the attachment picker and admin upload entry point. Show progress for the browser’s multipart POST directly to S3, then call /uploads/:uploadId/complete. Reauthorize completion, check server-owned metadata and pin the observed S3 VersionId once before queuing. Display queued state until the worker publishes.
3. Implement expiry, safe abandoned-object cleanup and per-user reservation limits. Keep a pinned version available if the signed form is reused. Provide two downloadable fictional documents with distinct notice periods for the later comparison.

**Review condition.** The browser uploads a private original and the server pins the exact bytes for processing. Complete the [phase 03 QA guide](qa/QA-03-direct-uploads-and-immutable-originals.md).

## Phase 04 · Indexing and policy publication

**Product scope.** Administrator experience · queued through ready, failed retry and replacement. Acceptance 5. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§3–5, 7–8](Legal_Support_Chat_TRD.md)

1. Implement the leased Mongo worker and modular extractor. Start with PDF.js digital text and UTF-8 TXT. Preserve one-based PDF pages and half-open UTF-16 TXT offsets. Check actual bytes, encoding, page limit (50), encryption and usable text. Record reasons and processing versions.
2. Build immutable passages and separate heading/clause-aware chunks with overlap and cross-page anchors. Follow TRD token bounds. Use the preflight-pinned model and dimensions. For a model or dimension change, build and validate a separate generation before switching the active pointer. Preserve existing passage anchors. Batch hosted embeddings, use deterministic upserts and scoped caching. Install text and vector indexes with version/generation filters and validate expected chunk IDs in both before marking ready.
3. Fence worker writes by lease token and reclaim expired jobs. Bound retries and honor provider delays. Publish shared replacements through a conditional active-pointer update against the recorded base. Archive invalidates pending activation and retains historical bytes. Add admin status, actionable errors, retry, revision/archive controls and audit events.
4. Provide idempotent bootstrap with stable fixture IDs and hashes. Seed a help guide answering the export question, two revisions of a policy and an answer key with exact excerpts. Expose starter questions once their sources are ready.

**Review condition.** A ready version is searchable and a failed replacement leaves the previous policy available. Complete the [phase 04 QA guide](qa/QA-04-indexing-and-policy-publication.md).

## Phase 05 · Grounded answers, streaming and citation viewing

**Product scope.** Customer experience · business questions, evidence beside each claim and streamed prose. Acceptance 1 and 4. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§2, 5–8](Legal_Support_Chat_TRD.md)

1. Snapshot active shared versions, ready private versions in the owned thread and index generations per attempt. Validate selected IDs. Run authorized keyword and vector searches concurrently, using original terms and bounded history for references. Merge the top 20 per branch by reciprocal rank, deduplicate and budget approximately six chunks. Persist the snapshot.
2. Evaluate keyword, vector and hybrid results against labeled fixtures. Use the pinned embedding configuration for queries. Select the chat model after streaming and structured-output trials. Include amendment queries in the retrieval fixtures and verify candidate IDs from each branch respect ownership before fusion. Test private history and source reads with a second customer and the seeded admin. Build the OpenRouter adapter with deadlines and bounded correction. Ground factual paragraphs in selected passage IDs, resolve quotes server-side, persist before emit and withhold invalid anchors.
3. Use the same validated output for JSON and POST Fetch SSE. Flush accepted and progress, send heartbeats, validated paragraphs, then complete with exactly two contextual suggestions. Parse fragmented UTF-8, display stage changes, and preserve focus. A suggestion submits a new turn.
4. Add accessible inline citation previews and authenticated viewers. Resolve exact PDF page or highlighted TXT range plus readable HTML. Preserve historical versions with Superseded or Archived labels. Restore citations and suggestions on reopen. Instrument retrieval, generation, validation and latency in Langfuse using opaque IDs.

**Review condition.** A suggested question streams an answer whose claims can be checked in the original source. Complete the [phase 05 QA guide](qa/QA-05-grounded-answers-streaming-and-citation-viewing.md).

## Phase 06 · Agreement comparison and support handoff

**Product scope.** Customer experience · compare clauses and handle incomplete evidence. Acceptance 2–3. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§2, 5–7, 9](Legal_Support_Chat_TRD.md)

1. Provide the agent with the registered Google A2UI ClauseComparison option. Have it select the component from a comparison request, clarify an ambiguous pair and retrieve evidence separately for each selected version. Validate each finding, both passage references and explicit missing-side states.
2. Translate the rows into a pinned A2UI surface, allowlist the React renderer and emit a single complete comparison event. Persist the surface with protocol/catalog versions. Stack passages beneath the term on mobile. Render two contextual follow-ups.
3. Handle mixed evidence at paragraph level. State supported facts with citations, name the unresolved term and offer a draft. On explicit acceptance call the assistant-turn draft endpoint, persist subject and body, offer Copy and restore the same draft on repeated acceptance. Include two immediate-submit suggestions.

**Review condition.** The customer can verify both sides of a change and copy a draft for an unresolved question. Complete the [phase 06 QA guide](qa/QA-06-agreement-comparison-and-support-handoff.md).

## Phase 07 · Failure recovery, observability and accessibility

**Product scope.** Assignment and release requirements · failure recovery and bonuses. Acceptance 4–6. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§2, 4, 6–9](Legal_Support_Chat_TRD.md)

1. Enforce configurable per-user generation limits and a single active attempt per thread. Return a retryable 503 before stream headers or a terminal error after them. Honor Retry-After on 429. Keep submitted questions and attachment selections visible and show when retry is available.
2. Implement cancellation, disconnect detection, terminalization and stale-attempt reconciliation after restart. Retry an owned failed turn with an idempotent retry ID and a fresh evidence snapshot. Rehydrate interrupted paragraphs and keep their status distinct from later attempts.
3. Finish Langfuse attempt and retry correlation, branch ranks, timings, usage when supplied and terminal states. Mask telemetry before export, bound flush time, and isolate optional full tracing to operator-controlled fictional fixtures. Cover all five UI surfaces with keyboard, responsive layout, live regions, dialogs, focus return and accessible feedback.

**Review condition.** A failed or interrupted answer can be retried without losing the question, attachments or partial response. Complete the [phase 07 QA guide](qa/QA-07-failure-recovery-observability-and-accessibility.md).

## Phase 7.2 · UI/UX redesign and frontend/backend code quality

**Status: COMPLETE · 2026-11-27; phase gate ACCEPTED WITH USER WAIVER.** Anshul approved the [proposal](qa/phase07.2-design-proposal.md) on 2026-11-27, then amended its visual direction to a SaaS-style indigo/slate design the same day. The UI, the amendment and the audit fixes are implemented; build, type, 82 regression tests, 8 targeted browser tests and 18 comprehensive browser checks pass, on tested commit `1db726b`, which is verified on GitHub branch `codex/phase07-recovery`, as recorded in the [QA report](qa/phase07.2-qa-report.md) and [checkpoint](qa/phase07.2-checkpoint.json). Anshul waived the remaining manual screen-reader and native-zoom observations on 2026-11-27; this closes the gate without establishing screen-reader conformance. Phase 08 may proceed. This phase begins with critique and audit, followed by a design review with Anshul, implementation, and independent verification. The original entry authorized planning; the subsequent proposal approval is recorded in the linked design document. Implementation evidence and remaining gate observations are recorded in the phase QA report. See the [detailed execution plan](Phase_7.2_Plan.md).

**Product scope.** Improve the existing customer and admin experience across the six PRD acceptance flows, and audit and remediate frontend and backend code quality. Preserve the PRD's fresh-chat behavior, owned history, conversation-scoped uploads, cited answers, Google A2UI comparison and copyable support draft. [PRD](Legal_Support_Chat_PRD.md) · [TRD](Legal_Support_Chat_TRD.md).

1. Capture the running UI at a recorded revision on desktop and mobile, including long conversations and loading, empty, failure and recovery states. Produce a prioritized UI/UX critique with screenshots, affected tasks, design principles, proposed fixes and clear distinctions between observed problems and hypotheses.
2. Run separate frontend and backend code audits in parallel. Record reproducible defects separately from maintainability concerns, with severity, file references, evidence, owner, proposed fix and validation. Inspect state races and cleanup, API boundaries, types, errors, module responsibilities, security, transactions, retries, worker leases, storage, retrieval and telemetry. Establish the existing build/test baseline and tooling gaps.
3. Present a coherent design proposal: navigation, reading area, composer, uploads, comparison/source verification, admin flows, design tokens, component states and desktop/mobile mockups. Compare meaningful alternatives and agree on the direction with Anshul before changing the product UI.
4. Implement the reviewed design and prioritized audit fixes in bounded increments using separate frontend and backend ownership. Extract modules where responsibilities justify it, improve boundary validation and error handling, and add proportionate static checks and targeted regression tests. Preserve existing route, persistence and evidence contracts unless a specific change and migration have been reviewed.
5. Independently verify the integrated candidate against all six acceptance flows, frontend/backend audit closure and the phase 01–07 regressions. Recheck accessibility on the final UI, including the outstanding observed phase 07 walkthrough. Record before/after evidence and the exact tested revision before release advancement.

**Entry and exit rules.** Audit and design work can start while the phase 07 accessibility observation is outstanding. Phase 7.2 does not waive that requirement: phase 08 remains blocked until phase 07 and 7.2 both pass. Existing phase 07 screenshots/scans do not establish acceptance of a redesigned UI. Follow the [phase 7.2 QA guide](qa/QA-07.2-design-and-code-quality.md) and the existing GitHub checkpoint procedure after PASS.

## Phase 08 · Hosted release and recorded acceptance

**Prerequisites.** Phase 07 and the inserted phase 7.2 must both pass. Use the integrated, redesigned and audited candidate for deployment and recording.

**Product scope.** Assignment and release requirements · handoff. Acceptance and demo 1–6. [PRD](Legal_Support_Chat_PRD.md) · [TRD §§7–9](Legal_Support_Chat_TRD.md)

1. Ship a multi-stage Dockerfile, compose.yaml, example environments, lockfile and README describing configuration, bootstrap, indexes, seed readiness, health checks and provider setup. Document the chosen models and evaluation results. Verify clean startup with docker compose up after configuration.
2. Build one image from the frozen candidate and record its digest. Deploy that digest to an isolated hosted demo and the public Render service with separate credentials and data. Induce provider failure, indexing failure, restart and throttling only on the demo service using operator-controlled dependencies or runtime limits. Exercise signup, streaming, direct uploads and citation viewing on the public origin. Record the environment for each scene and associate the video and both deployments with the reviewed digest. Verify same-origin API requests, secure cookies, proxy-aware rate limits, direct-upload CORS and streamed responses on the hosted origin. Check durable jobs resume after wake.
3. Publish the repository, hosted URL and narrated demo per assignment handoff. Use a fresh fictional account and the seeded materials. Follow the six TRD video scenes, showing network metadata, actual A2UI selection and registration, source verification, trace, policy replacement and recovery. Keep credentials and signed URLs out of frame.

**Review condition.** A reviewer can reproduce the application and follow the complete hosted demonstration. Complete the [phase 08 QA guide](qa/QA-08-hosted-release-and-recorded-acceptance.md).

## Release traceability

| PRD acceptance flow | First complete gate | Release evidence |
|---|---|---|
| 1. Suggested question and cited answer | 05 | Hosted streamed answer, hover preview and exact passage |
| 2. Agreement and amendment | 06 | Direct S3 upload, complete A2UI card, both source pages and renderer |
| 3. Unsupported term | 06 | Named gap and copyable draft after acceptance |
| 4. Fresh chat, restored thread and second account | 05 | Private fact available only in original thread, denied history and source access |
| 5. Admin replacement | 05 | Status transition, new citation, old superseded citation and denied customer mutation |
| 6. Failed reply, throttling, logout and Compose | 08 | Recovery gate 07 plus clean Compose and hosted replay in gate 08 |

Gate 7.2 rechecks all six flows locally after redesign and refactoring; Compose and hosted checks remain in gate 08. Gate 08 repeats all six flows against the release candidate. Multi-tenancy, OCR, exhaustive redlining and email delivery remain deferred under the PRD and TRD.
