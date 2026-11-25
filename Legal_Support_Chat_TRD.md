# Legal support chat — technical requirements

**Release 1 · 25 November 2026**  
Companion to [the product requirements](Legal_Support_Chat_PRD.md). This is an implementation specification for the full-stack hiring assignment. The submission consists of a working hosted app, a reproducible GitHub repository and a narrated demo. The video is the primary walkthrough, including admin operations.

## 1. Architecture and ownership

| Boundary | Implementation and responsibility |
|---|---|
| Browser | React, Vite, TypeScript, Tailwind, same-origin Fetch with credentials. Render chat history, progressive prose, evidence, A2UI comparisons and admin status. Upload bytes directly to private S3. |
| Web service | One Docker image on Render. Express serves the built client and API. Mongoose persists application state. An in-process worker with durable MongoDB leases performs indexing. A sleeping service resumes work on wake. |
| MongoDB Atlas Free | Accounts, sessions, chat history, upload reservations, immutable source passages, searchable chunks, text and vector indexes. Each environment has its own data. |
| Private Amazon S3 | Versioning enabled. Original PDF and TXT bytes. Browser gets a narrowly scoped signed upload form. Workers and authorized viewers read a pinned S3 object version. |
| Model APIs | OpenRouter for chat and a hosted API for embeddings. Initial embedding candidate is OpenRouter’s openai/text-embedding-3-small. Pin an exact chat model after the fixture test verifies streaming and structured output. Configure model IDs, embedding dimensions, quotas and credentials per environment. Paid fallback requires operator configuration. |
| Langfuse Cloud | One trace per answer attempt. Link indexing and retrieval observations by opaque IDs. Telemetry delivery operates independently of chat availability. |

One organization publishes a common knowledge base. A customer owns each conversation and its uploads. Admin privileges cover shared document management. They confer no general access to private conversations. The release supports selected-clause comparisons, digital text extraction and copyable email drafts. Exhaustive redlining, OCR, multi-tenancy and email delivery are future work.

## 2. Authentication and API conventions

Normalize email and enforce a unique index. Hash passwords with bcrypt, validate length against bcrypt’s 72-byte input limit, and return a generic invalid-login error. Signup always creates a customer. Seed the admin from server-side environment values. Issue a signed, short-lived JWT containing subject, session ID and expiry. Validate signature, allowed algorithm, issuer, audience, expiry and active session on protected routes. Use an HttpOnly, SameSite=Lax cookie with Secure on HTTPS. Logout revokes the session and clears the cookie using matching cookie attributes. Validate Origin on browser mutations. Never accept role or ownership from the client.

JSON is the default. All times are UTC ISO 8601. Cursor lists return items and an opaque nextCursor, with stable ordering and an ID tie-breaker. Errors have code, message, requestId and optional retryAfterSeconds. Return 400 for invalid input, 401 for an invalid session, 403 for an admin role failure, 404 for an inaccessible private resource, 409 for conflicting work, 413 for size, 415 for format and 429 with Retry-After for throttling. Provider unavailability before streaming returns a retryable 503. After stream headers, use a terminal error event.

| Method and path | Contract |
|---|---|
| POST /auth/signup · POST /auth/login | Email and password. Return safe profile and session cookie, 201 on signup or 200 on login. |
| POST /auth/logout · GET /auth/me | Logout returns 204. Current session returns user ID, email and role. |
| POST /conversations · GET /conversations | Create a conversation for first attachment, or list owned sidebar summaries ordered by recent activity. Hide empty abandoned drafts. |
| POST /chat/send | Body contains message and optional conversationId, clientMessageId and selectedDocumentVersionIds. Infer owner from session. Create thread on first send. Plain JSON returns conversationId, userMessageId, attemptId, response, citations, optional comparison and two follow-ups. Accept: text/event-stream selects streaming. |
| GET /chat/history | User-scoped logs across threads or filtered by conversationId, cursor and limit. Include message order, attempts and status, citations, versioned comparison payload, email draft and follow-ups. The client loads attachment state alongside the selected thread. |
| POST /chat/messages/:id/retry | Target an owned user turn with a failed or interrupted answer. Accept a client retry ID. Create one new attempt, keep the original question and attachments, and support the same JSON/SSE contract as send. |
| POST /chat/messages/:id/email-draft | Accept a specific assistant turn’s handoff offer. Persist a copyable draft with subject and body and return two follow-ups. Repeating the action returns the saved draft. |
| POST /conversations/:id/attachments · GET /conversations/:id/attachments | POST reserves one upload and returns a signed form. GET lists filename, version, state, size and actionable failure reason. |
| GET /admin/documents · POST /admin/documents | List shared files with active and pending versions. POST reserves the first version and returns a signed form. |
| POST /admin/documents/:id/versions · DELETE /admin/documents/:id | Reserve a replacement using the active version as its base, or archive the document and invalidate pending activation. |
| POST /uploads/:uploadId/complete | Reauthorize customer ownership or admin role, verify the uploaded object, pin its storage version and enqueue indexing. Return 202 with versionId and status. Repeat calls return the recorded state. |
| POST /admin/document-versions/:id/retry · POST /conversations/:id/attachments/:versionId/retry | Requeue a failed indexing job against its pinned source after a role or ownership check. An expired upload without bytes needs a fresh reservation. |
| GET /sources/:versionId/passages/:passageId · GET /sources/:versionId/file | Return the authorized original quotation, location and version label, or redirect to a short-lived signed GET for the pinned original. Only published shared versions or authorized private sources can be cited. Admins can inspect shared staging failures separately. |
| GET /health/live · GET /health/ready | Liveness checks process health. Readiness checks configuration, DB connectivity and ability to serve requests. Expose coarse status only. |

## 3. Direct browser upload and version publication

1. React creates a thread on first attachment. The appropriate reservation route accepts filename, declared MIME, size and a client upload ID. Express checks scope, rate and quota. Atomically reserve one of five attachment slots, including live reservations. Limit originals to 5 MiB and PDFs to 50 pages. Retry with the same client ID returns the same reservation or its terminal state.
2. Express chooses an opaque key, reserves a document version, and returns uploadId, versionId, expiresAt, form URL and signed form fields. Use a five-minute presigned POST policy restricted to the exact key and permitted MIME with a content-length-range bound. Restrict bucket CORS to the configured browser origins and required methods and headers. Keep bucket public access blocked. Only server-side credentials sign forms.
3. React sends multipart form data **directly to S3**, showing upload progress. S3 success means bytes arrived. The browser posts completion to Express. If the callback response is lost, retry completion against the same reservation.
4. Express reads object metadata using the server-owned key, checks size and type, captures the actual S3 VersionId and atomically pins it while moving the version to queued. Competing completions return the winner. All extraction, hashing, and signed reads use that exact VersionId, including after a signed form replay. The worker validates actual file format, parser limits, text encoding and page count before publication. Reject malformed, encrypted, image-only or unsupported files with a user-readable reason.
5. The worker claims queued work with a lease, records extraction and embedding progress, and upserts deterministic passage and chunk IDs. Reclaim expired leases after restart. Use a lease token on state writes to prevent a stale worker publishing. Retry transient provider failures with bounded backoff and honor Retry-After. Preserve permanent failure reasons for the admin.
6. Mark ready only after expected passages exist and the version’s chunks are queryable in both search indexes. Apply version-filtered probes with expected chunk IDs, retrying within a bounded indexing window. Atomically switch the shared document’s active pointer only if its base still matches and it remains unarchived. Concurrent or obsolete replacements require explicit resolution. A failed replacement leaves the current version active.
7. On reservation expiry release unused quota and remove abandoned objects after a grace period. Reconcile missing completion callbacks on a subsequent client retry. Cleanup checks pinned version references and live reservations before deleting any S3 version. Historical source bytes remain available after replacement or archive.

## 4. MongoDB records and constraints

| Collection | Main fields | Indexes or invariant |
|---|---|---|
| users | emailNormalized, passwordHash, role, createdAt | Unique normalized email. |
| sessions | userId, expiresAt, revokedAt | TTL cleanup on expiry. Request validation enforces expiry immediately. |
| conversations | ownerId, title, updatedAt, nextSequence, activeAttemptId, attemptLeaseUntil, attachmentCount | Index ownerId, updatedAt and ID for sidebar. Allocate message sequence and active attempt atomically. |
| messages | conversationId, ownerId, sequence, role, content, clientMessageId, parentTurnId, retryId, status, evidenceSnapshot, citations, comparison, followUps, draft, traceId | Unique conversation and sequence. Partial unique owner and clientMessageId on user turns handles a repeated first send before a thread ID exists. Unique parentTurnId and retryId for explicit retries. |
| documents | scope, conversationId or shared scope, title, activeVersionId, archivedAt | Index conversation and scope. Historical access resolves via the logical document. |
| documentVersions | documentId, revision, baseVersionId, reservationOwner, clientUploadId, expiresAt, key, s3VersionId, size, MIME, hash, state, lease, failureCode, extractorVersion, chunkingVersion, embeddingModel, dimensions | Unique document and revision, unique reservation owner and client upload ID, index state and lease expiry. Source pointer immutable once pinned. |
| passages | versionId, ordinal, text, heading, clauseRef, one-based PDF page or TXT offsets | Unique version and ordinal. Store offsets as half-open UTF-16 ranges in the decoded canonical text used by the web viewer. |
| chunks | versionId, indexGeneration, ordinal, ordered passageIds, headingPath, clauseRef, searchText, embedding | Unique version, generation and ordinal. Create one text search index and one vector search index with filterable versionId and generation. |
| adminEvents | actorId, action, documentId, versionId, requestId, timestamp | Record publish, replace, retry and archive for audit. |

Persist the user turn, thread creation if needed, and initial attempt reservation in one transaction. Reusing an idempotency key with different input returns 409. Reusing it with identical input returns existing IDs and status. Completed turns return their saved answer. An active duplicate directs the client to the existing history entry. Never start a second generation for it.

## 5. Extraction, chunking and hybrid retrieval

The extractor contract takes source bytes and returns an ordered list of verbatim text blocks with page or character locations. Start with PDF.js digital text extraction and a UTF-8 decoder. Preserve paragraph boundaries where recoverable. Detect absent or unusable text and surface a failure. Future Azure Document Intelligence or Tesseract-backed adapters implement the same output contract. Store extractor and chunking versions so results can be reproduced.

Keep original page-local citation passages separate from search chunks. Group paragraphs by heading and clause, starting at 350–500 tokens with a 700-token cap. Split long clauses at sentences, retaining exact source anchors across fragments. Carry one overlapping passage when splitting a long clause and trim overlap to the cap. Join cross-page continuations for search while preserving both source pages. Preserve short clauses, numbers, negation and exceptions. Fall back to ordered paragraphs when heading detection is unreliable.

For each turn, snapshot the active shared versions, ready private versions in the owned thread and their active index generations. The customer-facing selector accepts only versions in this scope. For comparisons restrict search to each selected file independently. Preserve the original question for exact terms. Resolve conversational references from a bounded recent-turn window, treating prior answers as context and retrieving fresh evidence for factual claims.

Run text and vector queries concurrently. The text branch boosts quoted phrases, headings and exact clause IDs. The vector branch embeds the query using the indexed model and dimensions. Both branches filter authorized versions and generations before candidate selection. Begin with 20 hits per branch. Merge by chunk ID using equal-weight reciprocal rank fusion in TypeScript, summing 1/(60 + one-based rank) for each branch containing a hit. Deduplicate passages, reserve space per selected comparison document and send approximately six distinct chunks within the prompt budget. Pass original passage IDs and excerpts to the generator. Treat retrieved content as evidence, never as application instructions.

Batch hosted embedding calls and cache by content hash, model, dimensions and processing version within authorized storage. Build a separate index generation for model changes, validate before cutover, and keep historical passage anchors stable. Evaluate exact identifiers, paraphrases, cross-page clauses, exceptions and amendments with keyword-only, vector-only and hybrid runs. Report expected-passage hit rate at six and first relevant rank. Add reranking only if measured failures show relevant candidates being discarded during final selection.

## 6. Answer generation and client behavior

Render the user turn immediately. Use POST Fetch with an SSE reader supporting fragmented UTF-8 frames, disconnect handling and cancellation. Send initial IDs and flush progress promptly. Disable response buffering for the stream. Send heartbeat comments while waiting. The JSON path consumes the same validated output.

| SSE event | Payload and handling |
|---|---|
| accepted | conversationId, userMessageId, attemptId. Associate optimistic UI with durable IDs. |
| progress | A real stage such as retrieving or comparing. Show a typing or progress indicator. |
| paragraph | Sequence, text and inline citation anchors. Validate model-supplied IDs against this attempt’s evidence, resolve quotes server-side, persist then emit each completed paragraph. |
| comparison | One complete validated A2UI surface with schema/catalog version and rows. Emit after all rows and source references pass validation. |
| complete | Persist terminal status and exactly two suggested questions before emitting completion. Include an email-draft action if evidence was insufficient. |
| error | Code, attemptId, retryability and retry delay if known. Preserve previously displayed paragraphs and label interrupted output. |

If a paragraph fails citation validation, withhold it and allow one bounded correction. If evidence remains insufficient, identify the gap, answer supported parts and offer a draft. A valid ID proves source identity. Fixture review must separately check whether the quoted passage supports the claim. A disconnect aborts the provider request where possible and marks the attempt interrupted. Reconcile stale active attempts on restart. Retry preserves the user message and selected attachments and records its own evidence snapshot.

Use one registered Google A2UI catalog component, ClauseComparison. The agent selects comparison mode and the component. The server translates validated rows into the pinned A2UI protocol surface. Each row contains a term, finding and two sides, each carrying a verified passage or an explicit missing-evidence state. If the intended pair is ambiguous, ask for the pair. Render only allowlisted components and data. Store protocol/catalog version with the payload for history replay. In the video show the actual surface and its registered React renderer.

After every completed assistant turn, including a comparison or email draft, show two persisted contextual questions. Clicking immediately submits a new user turn. Prefer suggestions from the same generation. Supply context-appropriate deterministic fallbacks if malformed or missing. When the customer accepts a handoff offer, compose a draft from the unresolved question and supported facts, let the customer copy it, and leave delivery to them.

## 7. UI and accessibility acceptance

Use a centered fresh composer with starter questions after each login, a left history sidebar on desktop and a drawer on mobile. Generate an initial thread title from the first question. Restore attempts, attachments, citations, cards, drafts and suggestions on thread selection. Hover or focus previews a cited passage. Keyboard activation or touch opens an authenticated viewer at the cited PDF page or highlighted TXT range. Show accessible HTML for the passage beside the original. Label archived and superseded sources. Stack the two comparison passages under a named term on narrow screens.

Target WCAG 2.2 AA across signup, login, chat, source viewer and admin. Provide accessible field labels, associated errors, visible focus, logical headings, contrast, reflow and adequate target spacing. Announce stage changes and answer completion through a polite live region. Keep focus stable while streaming. Ensure previews are dismissible, hoverable and persistent. Dialogs support Escape, focus containment and return to their invoking control. Describe upload and indexing failures in text. Verify with automated accessibility scans, keyboard-only operation, zoom/reflow and a manual screen-reader walkthrough.

## 8. Operations and deployment

Use express-rate-limit for authentication by IP and for chat and upload reservations by authenticated user. Configure trusted proxy handling for Render. Start with configurable limits of 10 login attempts per 15 minutes per IP, 10 generations and 10 reservations per 10 minutes per user. Tune through smoke testing. Bound pending uploads and active generations separately. A single-instance in-memory rate store resets on restart. Move to a shared store before running multiple web instances.

Use structured request logs, request IDs, provider deadlines, bounded retries and graceful shutdown. Trace retrieval branches, rank fusion, evidence selection, generation, validation, time to first paragraph, usage when supplied, and terminal status in Langfuse Cloud. Link retries via the original turn ID. Default exports contain opaque IDs and numeric metadata. Exclude document text, prompts, responses, signed forms, cookies and credentials. Enable full prompt/output tracing only for an isolated operator-run demo using known fictional fixtures. A hosted user or client flag cannot enable it. Apply masking before export and bound flush time at shutdown.

Ship client/ and server/, example environment files, lockfile, multi-stage Dockerfile, compose.yaml and README. The README covers Atlas connection and index definitions, S3 versioning/CORS and scoped permissions, OpenRouter and embedding configuration, Langfuse Cloud, cookie settings, seed, health checks and deployment. Only public configuration reaches the client bundle. Use distinct dev/prod origins, buckets or prefixes, Atlas databases and tracing environments. After documented configuration, docker compose up builds and runs the app. Provision indexes and seed via an idempotent bootstrap command. Seed shared files by stable fixture ID and content hash, then wait for readiness before advertising starter questions. Provide downloadable fictional comparison files for private upload.

Deploy the same image to Render, publish the working URL in the README, and smoke-test signup, chat streaming, direct uploads and source viewing from the hosted origin. Render may cold-start. The worker resumes durable jobs after wake. Do not depend on local disk for uploads or citations.

## 9. Verification and video handoff

| Scene | Evidence to capture and release check |
|---|---|
| 1. First cited answer | Sign up on the hosted app, select the export question, see retrieval progress and streamed paragraphs, open the source, then click a suggested follow-up. Reopen history and verify the same citations and suggestions. |
| 2. Direct upload | Upload the fictional agreement and amendment. Show the Network panel’s method, host, status and transfer sizes for reservation → browser POST to S3 → completion in Express. Keep signatures, request bodies and credentials out of frame. Show indexing move to ready. Verify the uploaded file bytes went directly to S3. |
| 3. Comparison and tracing | Ask about a known notice-period change. Inspect both original pages and a term missing on one side. Show the agent-selected A2UI payload and React registration, then the corresponding Langfuse Cloud trace with keyword/vector ranks and model usage. |
| 4. Evidence gap and privacy | Ask an unsupported question, accept the email draft and copy it. Start a new chat and verify prior private attachments are absent. Reopen the original thread. Verify a second account cannot access the first account’s history, passage, file route or upload reservation. |
| 5. Admin revision | In an operator-controlled admin session, stage a replacement, show status and activate it. Compare a fresh answer to an old citation labeled Superseded. Exercise failed indexing and retry. Demonstrate that customer requests to admin routes are denied. |
| 6. Recovery and handoff | Trigger a controlled failed reply and a 429. Show the retry delay, preserved question and single user turn after retry. Verify logout, documented Compose startup, working deployed link and repository setup. Put the video link prominently in the README. |

Automate integration cases for concurrent first sends, repeated upload completion, replayed signed forms, oversize or malformed uploads, expired reservations, interrupted attempts, index leases, replacement races and cross-account source access. Run the six PRD flows in browser smoke tests or a recorded acceptance run. Keep a small retrieval fixture set with expected excerpts and a human-reviewed answer key. All known demo claims must open their expected sources, and every comparison row must resolve both sides or label a missing passage. Record actual outcomes, chosen model IDs and accessibility findings at implementation handoff.

## Implementation references

- [Amazon S3 versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) and [presigned access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [MongoDB hybrid search](https://www.mongodb.com/docs/vector-search/hybrid-search/hybrid-search-overview/) and [reciprocal rank fusion](https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankfusion/)
- [OpenRouter hosted embedding candidate](https://openrouter.ai/openai/text-embedding-3-small)
- [A2UI catalogs](https://a2ui.org/concepts/catalogs/) and [Langfuse masking](https://langfuse.com/docs/observability/features/masking)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [Render free web service behavior](https://render.com/docs/free)
