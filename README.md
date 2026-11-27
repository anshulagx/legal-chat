# Legal Support Chat

- **Hosted app:** <https://legal-chat-wuxo.onrender.com> (free Render instance; the first request after idle can take about a minute)
- **Demo video:** _link added after recording_
- **Repository:** <https://github.com/anshulagx/legal-chat>

## Quick start with Docker Compose

Requires Docker with Compose v2, a MongoDB Atlas cluster (Search and Vector
Search indexes are Atlas features), a private versioned S3 bucket, an
OpenRouter key and, optionally, Langfuse Cloud keys. Each setting is described
in the sections below.

```sh
cp .env.example .env   # fill in the values; keep APP_ORIGIN=http://localhost:3000
docker compose up --build
```

Compose builds one image and runs it twice. The `bootstrap` service creates
indexes, seeds the fictional help guide and notice policy, waits until they are
searchable, then exits. The `app` service starts only after bootstrap succeeds
and serves http://localhost:3000. Compose sets `HOST=0.0.0.0` and
`INDEXING_ENABLED=true`, so `.env` needs the storage and OpenRouter settings.
Bootstrap is idempotent; the first run takes a few minutes while Atlas builds
indexes, later runs finish in seconds. Check `docker compose ps` for a
`healthy` app, or `curl localhost:3000/health/ready`.

The S3 bucket CORS must allow `http://localhost:3000` (see Phase 03). Atlas
Network Access must allow your current IP.

## Run Phases 01–06

Use Node 22.22.0 (see `.nvmrc`) and a development MongoDB replica set or Atlas database. Copy
`.env.example` to `.env` if you do not already have it. For Phase 01 the
required settings are the environment, origin and port, MongoDB URI and database,
JWT settings, admin seed credentials, and authentication limits. Set
`APP_ORIGIN=http://localhost:3000` and `PORT=3000` for the default local
address. Keep a distinct database, origin and signing secret for production.
Allow the runtime's current outbound IP in Atlas Network Access; it can change
when the network connection changes. For connection failures, follow the
[Atlas connection checks](https://www.mongodb.com/docs/atlas/troubleshoot-connection/).

```sh
npm ci
npm run dev
```

Open http://localhost:3000. The dev command builds the React client once and
watches server code. Restart it after client changes. The server serves the
client and API at the same origin. The configured admin is seeded on startup.
Changing its environment password updates the hash on restart. If the seed
email already belongs to a customer, startup cannot become ready. Use a
different admin email or correct the isolated data before retrying.

For a production build, run `npm ci --include=dev` then `npm run build`. Set server variables
through the host's environment settings and run `npm start`. On Render use
`NODE_ENV=production`, the public HTTPS origin for `APP_ORIGIN`, and
`/health/ready` as the health check path. Render's `PORT` and `RENDER=true`
settings supply the listener port and enable the single trusted proxy hop.
To load a private file for a local production-mode run, use
`node --env-file=.env.production.local server/dist/index.js`. Keep both private
env files out of version control and the browser bundle.

`/health/live` returns 200 while the listener is alive. `/health/ready` returns
200 once indexes and the admin seed are ready and MongoDB replies to a
ping. Readiness returns 503 when the database is unavailable. Request logs
contain the generated request ID, method, response status and duration.

## Phase 01 QA

Follow [the Phase 01 guide](qa/QA-01-foundation-and-account-sessions.md). Use
a dedicated QA MongoDB deployment or project, separate from production. The
automated suite creates and drops a uniquely named fixture database. Its
MongoDB user needs database create, read, write and drop permissions for that
namespace. It defaults to local MongoDB at `127.0.0.1:27017`. If using Atlas,
supply the isolated URI via `QA_MONGODB_URI` in the runner environment and keep
its value out of the terminal history. Never set it to the production URI.

```sh
npm run build
npm run test:phase01
```

For browser QA, use a separate ignored environment file such as `.env.qa.local`
with a disposable MongoDB database, an admin address on `example.test` and a
new test password. Run `node --env-file=.env.qa.local server/dist/index.js`.
Use distinct browser profiles for the fictional customers and admin. For the
limited run, set `AUTH_LOGIN_LIMIT=2` in that file and restart. API clients must
supply `Origin` matching `APP_ORIGIN` on each authentication POST. Record only
cookie attributes and sanitized outcomes. The HTTP fixture tests secure-cookie
emission for a configured HTTPS origin. Check actual HTTPS behavior and Back
navigation in Chrome separately where applicable.

## Phase 02 behavior and API

Each login or page reload opens a fresh composer. Previous chats appear in the
sidebar; select one to restore its ordered messages. A thread is created on
first send. Explicitly created empty drafts are omitted from the sidebar. The
first question supplies the title. Account and admin sessions see only their
own conversations.

Phase 02 introduced durable turns. Phases 05–06 now retrieve authorized evidence,
stream validated paragraphs, open original sources, compare selected clauses,
and offer copyable support drafts when evidence is incomplete.

All chat routes require the same session cookie as `/auth/me`. Mutations also
require `Origin` equal to `APP_ORIGIN`.

| Route | Phase 02 contract |
| --- | --- |
| `POST /conversations` | Creates an owned empty draft; returns `id`, `title`, `updatedAt` with 201. |
| `GET /conversations?limit=20&cursor=…` | Owned nonempty summaries, newest activity first with ID as tie-breaker. Returns `items`, `nextCursor`. |
| `POST /chat/send` | `{message, clientMessageId, conversationId?}`; 1–8,000 trimmed characters. Returns durable `conversationId`, `userMessageId`, `attemptId`, `clientMessageId`, `status`, `response`, `citations`, `followUps`. |
| `GET /chat/history?conversationId=…&limit=100&cursor=…` | Owned messages in sequence order. Without a conversation ID, orders owned messages by creation time and ID across threads. Returns `items`, `nextCursor`; messages include role, status and attempt IDs. |

Pagination limits are 1–100 (default 30). Cursors are opaque, signed and bound
to the account and list/filter; follow `nextCursor` unchanged until it is null.
Ordering uses the current data, so a conversation receiving a new answer can
move to the beginning of the sidebar between requests.

The client creates a new `clientMessageId` for each intentional question and
retains the entire original body for transport retries. Replaying the same key
and input returns the stored IDs and result; an active duplicate returns 202
with `status: generating` and should be polled through history. Changing the
message or original conversation argument with the same key returns 409
`IDEMPOTENCY_CONFLICT`. A different message while the thread is busy returns
409 `GENERATION_ACTIVE`. If a caller omits the optional key, the server allocates
one but cannot deduplicate a retry that also omits it. `selectedDocumentVersionIds` can restrict retrieval to ready versions in the
owned thread or active shared knowledge. The ordered pair defines comparison sides.

Thread creation, sequence allocation, user turn and assistant attempt are one
MongoDB transaction. The answer adapter runs only after commit. Completion or
adapter failure atomically records the terminal result and releases the thread.
No model calls occur in the Phase 02 fixture. Phase 07 adds explicit retries,
cancellation and leased recovery of active attempts after a process crash.

## Phase 02 QA

Use [the Phase 02 guide](qa/QA-02-conversations-and-durable-turns.md). For a local
isolated test deployment, install MongoDB Community and run these commands in
separate terminals. Use an empty disposable directory and an unused port:

```sh
mkdir -p /private/tmp/legal-chat-qa-mongo
mongod --dbpath /private/tmp/legal-chat-qa-mongo --bind_ip 127.0.0.1 --port 27028 --replSet legalChatQA --nounixsocket
mongosh 'mongodb://127.0.0.1:27028/?directConnection=true' --eval 'rs.initiate({_id:"legalChatQA",members:[{_id:0,host:"127.0.0.1:27028"}]})'
```

Wait until `rs.status()` reports a PRIMARY, then run:

```sh
npm ci
npm run build
QA_MONGODB_URI='mongodb://127.0.0.1:27028/?replicaSet=legalChatQA' npm run test:phase01
QA_MONGODB_URI='mongodb://127.0.0.1:27028/?replicaSet=legalChatQA' npm run test:wave-02
```

The Phase 02 runner defaults to that local replica-set URI. To use an isolated
Atlas QA project instead, supply `QA_MONGODB_URI` through the runner environment.
The user must have create/read/write/drop and `collMod` permissions in the
generated `legal_chat_qa02_*` database: one test installs and restores a validator
to prove transaction rollback. The suite never reads a private `.env` file. It
creates and drops its fixture database, starts two application processes,
injects deterministic answers through the test-only fixture, and checks
cross-process duplicate sends, conflicts, pagination, restart persistence,
privacy, serialization, rollback and adapter failures.

For browser checks, create an ignored `.env.qa.local` using a separate disposable
database in this replica set, a fresh JWT secret and fictional seed credentials.
Run `node --env-file=.env.qa.local server/dist/index.js`. The normal server uses
the grounded provider when configured. The deterministic test adapter and pause/failure
controls exist only in `scripts/phase02-fixture.mjs` and its IPC channel;
`setTestAnswerAdapter` rejects injection outside `NODE_ENV=test`. No HTTP endpoint
can select or control it. Keep QA credentials and cookie values out of evidence.

Implementation reference: [Mongoose 8 transactions](https://mongoosejs.com/docs/8.x/docs/transactions.html).

## Phase 03 direct file uploads

Customers can attach up to five PDF or UTF-8 text originals to each chat. Each
file may contain 1 byte through 5 MiB. The first attachment creates a thread.
The file picker transfers multipart bytes directly to private Amazon S3,
shows progress, and then calls the metadata-only completion endpoint. Reopening
a chat restores its attachments. Admins have a separate shared-document upload
panel. Queued means the exact original is saved; extraction/indexing starts in
Phase 04. PDFs must eventually pass its 50-page/digital-text validation.

Download fictional [agreement](client/public/fixtures/agreement.pdf) and
[amendment](client/public/fixtures/amendment.txt) fixtures from the upload panel.
Their notice periods differ: 30 and 60 days. They are test documents.

Configure the existing `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
conditional `AWS_SESSION_TOKEN`, `S3_BUCKET`, `S3_KEY_PREFIX`,
`UPLOAD_RESERVATION_LIMIT` and `UPLOAD_RESERVATION_WINDOW_SECONDS` settings.
An app without any upload settings keeps auth/chat available and returns 503
for storage-dependent mutations. Partial settings fail startup validation.
When configured, readiness also requires bucket versioning, all four Block
Public Access settings and exact `APP_ORIGIN` CORS for GET/POST. The app neither
creates buckets nor changes bucket policies or CORS. Allow the browser origin
and `content-type` header in bucket CORS. No exposed VersionId header is needed:
the server captures the object version through HEAD. CSP permits direct XHR
only to the configured regional bucket hostname and the application origin.

The supplied identity needs scoped object POST/write, Head/GetObject,
GetObjectVersion, ListBucketVersions and DeleteObjectVersion for the application
prefix, plus read access to the three bucket configuration checks. Use distinct
development/production prefixes and identities. Do not apply an expiry lifecycle
to pinned originals. No originals are stored on the web service's local disk.

| Route | Contract |
| --- | --- |
| `POST /conversations/:id/attachments` | `{filename,mime,size,clientUploadId}` reserves an owned slot; returns 201 with uploadId/versionId, expiry and signed `form: {url,fields}` while reserved. |
| `GET /conversations/:id/attachments` | Owned filename/type/size/state/checksum metadata. Another account receives 404. |
| `POST /admin/documents` | Same reservation body for a new shared document. Customer receives 403. |
| `GET /admin/documents` | Admin-only shared upload list. |
| `POST /uploads/:uploadId/complete` | Metadata only. Returns 202 and the pinned version's current state, initially `queued`. Duplicate/concurrent calls retain that original after indexing. |

Always retry a reservation with its original `clientUploadId` and input; a
changed payload returns 409. Repeated reservations do not consume extra slots
or rate-limit attempts. New reservations count against the per-user configured
limit and return 429 with Retry-After when exceeded. Unsupported MIME is 415;
declared oversize is 413; S3 independently enforces the signed MIME, exact key
and 1-byte–5-MiB policy. Completion checks observed size/MIME and hashes an
explicit S3 VersionId, then atomically pins that version and creates one queued
job. Reusing the still-valid form can create another S3 version but cannot
replace a pinned original. `readPinnedOriginal` is the Phase 04 worker-input
boundary: it reads the recorded VersionId and verifies SHA-256 before returning
bytes.

Forms expire within five minutes and retries never extend the reservation's
original deadline. A background pass runs every minute, with bounded batches.
It reconciles bytes received without a completion callback before expiring an
empty reservation and releasing its slot exactly once. An expired empty upload
requires a new ID. A one-hour grace period precedes deletion of abandoned or
replayed extra versions. Cleanup deletes only explicit, unpinned S3 versions;
it checks for live reservations/pinned references, retains all pinned originals,
and keeps terminal MongoDB rows indefinitely for idempotency and orphan tracking.
New reservation requests reconcile only their owner's expired reservations;
global garbage collection runs in the background. Transient storage failures
retain records/slots for a later pass.

## Phase 03 QA

Use the isolated replica set described above, then run:

```sh
npm ci
npm run build
npm run test:wave-03
```

This default suite uses a local versioned storage emulator injected only into a
test fixture. It asserts duplicate completion, form replay, real transaction
quota races, oversized/type-invalid posts, expiry reconciliation/slot recovery,
ownership, admin roles and rate limiting. It also tests two duplicate
reservations racing for the final slot. Emulator results do not establish AWS
or browser-CORS compatibility.

For the required real S3 gate, provide `QA_S3_ENV_FILE` pointing to an ignored,
private environment file with explicit *development/test* AWS settings, an
isolated `S3_KEY_PREFIX` ending `/`, approved `APP_ORIGIN`, and QA MongoDB URI:

```sh
QA_S3_ENV_FILE=/private/tmp/legal-chat-phase03.qa.env npm run test:wave-03
```

The runner reads selected settings without printing them, uses a unique
subprefix and database for each run, stops fixtures, then deletes only that
run's explicit object versions and database. It never loads production files
implicitly or modifies bucket configuration. Do not use a production identity
or production prefix. The real suite posts to S3 and asserts policy rejection,
private originals and immutable version reads. Use Chrome at the exact CORS
origin to complete the separate QA guide's Network observation, recording only
method, hostname, status and transfer size. Keep cookies, signed fields and
provider credentials out of recordings.

Test-only IPC controls in `scripts/phase03-fixture.mjs` advance the application
clock, run cleanup and read checksums of pinned/latest originals. They are not
HTTP endpoints, and storage/clock injection rejects non-test execution. Run
`test:phase01` and `test:wave-02` as regressions on the same isolated replica set.

References: [AWS signed POST SDK](https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-presigned-post)
and [S3 version-specific reads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/RetrievingObjectVersions.html).

## Phase 04 indexing and bootstrap

Set `INDEXING_ENABLED=true` together with storage settings and
`OPENROUTER_API_KEY`, `OPENROUTER_EMBEDDING_MODEL`, and
`OPENROUTER_EMBEDDING_DIMENSIONS`. The measured development configuration is
`openai/text-embedding-3-small` with 1,536 dimensions; see the
[redacted preflight record](qa/phase04-embedding-preflight.json). Nonfinite or
incorrectly sized vectors are rejected. Omitted/false disables indexing, so
earlier-phase isolated fixtures require no model access.

After configuration, build and bootstrap the fictional knowledge base:

```sh
npm run build
npm run bootstrap
```

The npm command loads `.env`. To select a separate private environment file:

```sh
node --env-file=/private/tmp/legal-chat-phase04.qa.env scripts/bootstrap.mjs
node --env-file=/private/tmp/legal-chat-phase04.qa.env server/dist/index.js
```

Bootstrap seeds an export help guide and two notice-policy revisions with
stable fixture IDs and content hashes. It pins originals, waits for indexing,
and publishes the ready revision. Repeating bootstrap preserves identities and
active pointers; changed fixture content requires a new revision. Files and the
answer key are in `client/public/fixtures/`. Starter questions appear only when
their backing shared versions are ready. Chat uses grounded generation when the
chat and embedding providers are configured.

The worker reads the exact pinned S3 version. PDF.js extracts digital-text PDFs;
encrypted, malformed, image-only, or over-50-page files fail with a readable
reason. TXT decoding rejects invalid UTF-8 and binary control data. Immutable
passages retain one-based PDF pages or half-open UTF-16 TXT offsets. Separate
heading/clause-aware chunks use the cl100k tokenizer, a 350–500-token target,
700-token cap, and anchored overlap for long clauses. Short clauses remain
intact. Extractor, chunker, model and dimension metadata identify a generation.

Durable jobs have leases and tokens. Persistence batches and publication run
inside transactions conditioned on the current token and unexpired lease.
Expired jobs can be reclaimed; stale workers cannot overwrite or publish the
new owner's work. Provider calls have deadlines and bounded transient retries,
respecting Retry-After. Failed versions retain pinned bytes for explicit retry.
Embedding caches include content, model, dimensions, processing versions and
the shared or private owner/conversation scope.

A document version is marked ready only after queryable Atlas indexes and
successful version/generation-filtered keyword and vector probes. Model/dimension changes build a new
generation before switching its active pointer. Existing ready search remains
available after a failed rebuild; historical passage identities are preserved.
Reindexing a historical policy does not republish it over the current revision.

One common text index and dimension-specific vector fields/indexes avoid an
index per document or version. Atlas Free permits three Search/Vector indexes
in total, allowing old/new vector indexes alongside the common text index for
a dimension migration. Additional distinct dimensions require managing index
retention from completed migrations or more cluster capacity. Creation
acknowledgment alone is insufficient; builds and query visibility can take
several minutes.

## Phase 04 publication and API

The admin shared-document panel shows processing state, readable failures,
retry, replacement and archive controls. Replacements capture the server's
current base revision and activate only after readiness with the same base and
an unarchived document. Failure or a losing replacement race leaves the
current policy available. Publication conflicts require a new replacement
based on the current revision. Archive invalidates pending activation and
retains historical originals and anchors.

| Route | Phase 04 contract |
| --- | --- |
| `GET /admin/documents` | Admin version list with status, failures, revision, active pointer and archive metadata. |
| `POST /admin/documents/:id/versions` | Stages a replacement using the initial upload reservation body; file bytes go directly to S3. |
| `POST /admin/document-versions/:versionId/retry` | Requeues a failed shared version using its pinned original. |
| `POST /conversations/:id/attachments/:versionId/retry` | Requeues a failed private version after owner/conversation checks. |
| `DELETE /admin/documents/:id` | Archives the logical document and invalidates pending publication. |
| `GET /admin/documents/:id/events` | Admin-only actor/action/document/version/timestamp records, with request ID when present. |
| `GET /knowledge/starter-questions` | Authenticated questions backed by ready fixture versions. |

Customers receive 403 for shared management. Admin status confers no general
private-file access. Completion replay remains idempotent in indexing, ready
and failed states and never repins a replacement latest S3 object.

## Phase 04 QA

Follow [the Phase 04 guide](qa/QA-04-indexing-and-policy-publication.md). With the
isolated local replica set from Phase 02 running:

```sh
export QA_MONGODB_URI='mongodb://127.0.0.1:27028/?replicaSet=legalChatQA'
npm ci
npm run build
npm run test:phase01
npm run test:wave-02
npm run test:wave-03
npm run test:wave-04
```

The default Phase 04 suite uses controlled provider/storage adapters and real
MongoDB transactions. Parser fixtures, source anchors, failures/retries,
expired/stale leases, generation changes, replacement races and archive are
tested. Adapter results do not establish hosted compatibility. The opt-in
hosted gate is:

```sh
QA_INDEX_ENV_FILE=/private/tmp/legal-chat-phase04.qa.env npm run test:wave-04
```

Use only development/test Atlas, S3 and OpenRouter settings in that private file,
with a unique S3 prefix. Optional `MONGODB_COLLECTION_PREFIX` is accepted only
with `NODE_ENV=test` and must match `qa04_<8-to-40 lowercase letters/digits>_`.
It applies to every application model and is omitted in normal environments.
Native Atlas operations use the actual model collection name. Hosted cleanup
must remove only exact owned collections/indexes and object versions, never
the containing development database. Coordinate hosted runs because the
cluster-wide index quota is shared.

Parser fixtures and expected page excerpts, UTF-16 coordinates and hashes are
under `scripts/fixtures/phase04/`. Fault injection belongs to test execution;
hosted clients cannot select providers, advance clocks or issue worker writes.
Record hosted branch queries, bootstrap counts/pointers from two runs and the
admin browser walkthrough separately from adapter evidence. Keep credentials,
cookies and signed forms out of evidence.

References: [Mongoose 8 transactions](https://mongoosejs.com/docs/8.x/docs/transactions.html),
[Mozilla PDF.js](https://github.com/mozilla/pdf.js),
[OpenRouter embeddings](https://openrouter.ai/docs/api_reference/embeddings),
and [Atlas index limits](https://www.mongodb.com/docs/atlas/atlas-search/limitations/).

## Phases 05–06: grounded answers and comparison

Configure `OPENROUTER_API_KEY`, `OPENROUTER_CHAT_MODEL`,
`OPENROUTER_EMBEDDING_MODEL` and `OPENROUTER_EMBEDDING_DIMENSIONS` on the server.
`openai/gpt-4o-mini` is the configured chat candidate; see the live trial evidence
below for the measured compatibility result. Query embeddings use each indexed
generation's recorded model and dimensions. `INDEXING_ENABLED=true` enables the
upload worker; existing ready sources can be queried with the worker disabled.
The optional `ANSWER_DEADLINE_MS` defaults to 90,000 (range 1,000–180,000).

`POST /chat/send` accepts `selectedDocumentVersionIds`. These IDs must be ready
private files in the owned conversation or active shared versions. A comparison
uses two ordered IDs; when the pair is ambiguous the assistant asks for a
selection. The composer lists ready attachments for explicit selection. Search
uses the question's original terms and bounded recent context, concurrent Atlas
text/vector branches, top 20 candidates per branch and reciprocal rank fusion
with a six-chunk budget. Each comparison side is searched separately. A persisted
attempt snapshot fixes the authorized versions and index generations.

Both JSON and Fetch SSE use the same validator. SSE sends `accepted`, `progress`,
validated `paragraph` events, an optional single complete `comparison`, and
`complete`; failures send `error`. Heartbeat comments keep waiting streams alive.
Paragraphs are persisted before emission. Factual paragraphs require passage IDs
in that attempt's selected evidence. Exact quotations and locations come from
stored passages. One correction is allowed; invalid anchors are withheld.
Citation validation establishes source identity, so fixture QA also checks the
meaning of each claim against the original.

Citations open an authenticated dialog with readable source text, highlighted
TXT passage and original PDF page links. `GET /sources/:versionId/passages/:passageId`
and `GET /sources/:versionId/file` reauthorize every read, including admin reads.
Original bytes are read from the pinned S3 version and hash-verified. Previously
published shared versions retain Superseded/Archived labels. Unpublished staging
versions cannot be read through customer source routes.

The comparison catalog registers only `ClauseComparison`. The persisted payload
pins A2UI `v0.8`, catalog `legal-support/1` and contains `surfaceUpdate` and
`beginRendering` messages. The closed React renderer checks the catalog,
component, row payload and both source references. Missing evidence is explicit
on each side; rows stack beneath their term on mobile. The custom catalog ID
identifies the local registration; it is not an external runtime dependency.
Implementation references: [A2UI v0.8 message schema](https://raw.githubusercontent.com/a2ui-project/a2ui/main/specification/v0_8/json/server_to_client.json)
and [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

When a reply identifies an evidence gap, its handoff offer can be accepted with
`POST /chat/messages/:assistantTurnId/email-draft`. The endpoint saves a subject
and body containing the unresolved question and available source excerpts.
Repeated acceptance returns the same draft. Copy it to send through your own
email client. Every completed answer and draft has two immediate-submit follow-up
questions; history restores citations, comparison rows, offers and drafts.

Optional Langfuse Cloud settings export opaque attempt/turn/conversation IDs,
retrieval ranks and stage timings with a bounded request timeout. Prompts,
answers, filenames, quotations, signed URLs and credentials are excluded.
The direct OTLP exporter uses ingestion version 4; the live verification reads
Observations API v2 following the [current Langfuse API guidance](https://langfuse.com/docs/api-and-data-platform/features/public-api).

### Phase 05–06 QA

Use the disposable MongoDB replica set described above and Node 22:

```sh
npm run build
npm run test:wave-05
npm run test:wave-06
```

The suites use fictional sources, real MongoDB transactions and test-only
storage/retrieval/model controls. HTTP clients cannot select these controls.
`test:wave-05` also covers fragmented UTF-8/SSE frames and the A2UI renderer
allowlist. Run bounded hosted model trials separately with:

```sh
node --env-file=.env scripts/phase05-live-trial.mjs
```

This makes seven small hosted chat requests with fictional material and writes
sanitized results to `qa/phase05-live-model-trial.json`. Review the phase QA report
for the separate live retrieval, browser and regression verdicts. Phase 07
recovery controls and evidence are documented below.


## Phase 07 · Recovery and operational controls

Use Node 22 or newer (`nvm use`). `npm run build` compiles the server and client;
`npm run test:wave-07` runs isolated MongoDB integration tests plus content masking
and bounded telemetry-flush tests. Set `QA_MONGODB_URI` to a disposable replica set
(the default for phase 07 is `mongodb://127.0.0.1:27028/?replicaSet=legalChatQA`).
Fixtures and all fault injection are installed only in `NODE_ENV=test` processes.

- `POST /chat/messages/:userMessageId/retry` accepts `{ "retryId": "<unique client ID>" }`.
  An owned failed/interrupted turn receives one new assistant attempt. Repeated
  retry IDs replay the same attempt, including concurrent requests. The original
  question, selections and all earlier attempt paragraphs remain in history.
  A retry takes a fresh authorized evidence snapshot; selected IDs cannot grant
  new source access. The user turn points to its latest attempt.
- `POST /chat/messages/:assistantAttemptId/cancel` with `{}` interrupts an owned
  active attempt. Disconnecting the answer request also aborts generation.
  Validated paragraphs remain saved. The client offers Stop reply while generating
  and Retry reply after failure/interruption, including after reopening history.
- `CHAT_GENERATION_LIMIT` and `CHAT_GENERATION_WINDOW_SECONDS` default to 10 per
  600 seconds per authenticated user. Exact send/retry replays bypass the limiter.
  Limits use the single-process in-memory store and reset on restart; use a shared
  rate store before scaling web instances. One active attempt per thread is
  enforced separately in MongoDB transactions.
- `CHAT_ATTEMPT_LEASE_MS` defaults to 90 seconds. A running attempt renews every
  third of the lease. Startup, periodic cleanup and subsequent chat requests
  reconcile expired leases as interrupted. An unexpired lease survives restart
  until expiry; open history polls while generation is pending. Terminal writes
  are fenced by the active attempt and lease, so obsolete work cannot complete
  a replacement attempt.
- Immediate answer failures return retryable HTTP 503 before SSE headers.
  Provider throttling returns 429 and `Retry-After` when known; after SSE starts,
  failures use a terminal error event with attempt IDs and retry delay. A brief
  100 ms admission window permits immediate failures to preserve HTTP status;
  slower generation flushes accepted/progress and heartbeats. JSON failures use
  the corresponding 503/429 status and retain the durable result IDs in the body.

Langfuse exports attempt, original turn and conversation IDs, a SHA-256 digest of
client retry IDs, branch ranks, timings, supplied token counts and terminal status.
Failed attempts retain their trace ID. Export uses a strict allowlist before
serialization, never questions, passages, filenames, signed forms, cookies or
credentials. Full prompt/output tracing is not exposed. Export failure does not
block answers. At most 100 exports may be pending, each has a 5-second deadline,
and shutdown waits at most 1.5 seconds for telemetry.

Optional browser checks use isolated tooling, not application dependencies:

```sh
npm install --prefix /tmp/legal-chat-browser --no-audit --no-fund playwright-core axe-core@4.10.3
QA_PLAYWRIGHT_MODULE=/tmp/legal-chat-browser/node_modules/playwright-core/index.mjs \
QA_AXE_PATH=/tmp/legal-chat-browser/node_modules/axe-core/axe.min.js \
node scripts/phase07-browser.mjs
```

Set `QA_CHROME_PATH` when Chrome is not installed at the macOS default path.
The scanner bypasses CSP only in its isolated browser context to inject axe.
Application CSP remains enabled. Checks cover signup, login, chat, source viewer
and admin, 320px reflow, citation focus/escape behavior, retry and cancellation.
Axe cannot establish full accessibility conformance. Complete the keyboard,
zoom and observed screen-reader walkthrough in the
[phase 07 QA guide](qa/QA-07-failure-recovery-observability-and-accessibility.md).
Run `node --env-file=.env scripts/phase07-live-telemetry.mjs` for two fictional,
content-free Cloud trace exports/readbacks; it does not call a chat model.
See [phase 07 evidence and remaining gate checks](qa/phase07-qa-report.md).

## Phase 7.2 · Support workspace redesign and code quality

The [approved proposal](qa/phase07.2-design-proposal.md) is implemented in the
support workspace: a scrolling answer column with a persistent composer, a
mobile history dialog, explicit comparison document identities/order, compact
file readiness controls, and a dedicated Shared documents destination for admins.
The chat stays mounted when opening admin management. Account details live in
one header menu; source inspection remains a native modal.

New replies follow the transcript only while the reader is near the bottom.
Scrolling upward pauses following; **Latest answer** returns to the stream.
Files stay in their chat. Open **Attach files** to upload, inspect readiness,
choose two ready versions, swap their order, or download fictional sample files.
Queued and failed files are summarized beside the question. File/reply operations
pause conflicting navigation. Failed replies preserve the question and partial
answer and offer the existing retry/cooldown behavior.

The focused audit also fixed out-of-order history refreshes, old draft feedback
after navigation, indexing retries reloading the wrong attachment context,
clipped citation previews and HTTP error status before SSE starts. No storage,
database schema, retrieval or A2UI catalog migration is introduced.

Use Node 22+ and a disposable Mongo replica set. For example, the current QA
session uses port 27029 with replica-set name `legalChatQA072`; substitute your
own isolated replica-set URI if using the setup above.

```sh
export QA_MONGODB_URI='mongodb://127.0.0.1:27029/?replicaSet=legalChatQA072'
npm run typecheck
npm run build
npm run test:phase07.2
# Point to an optional playwright-core index.mjs and axe-core/axe.min.js installation.
export QA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs
export QA_AXE_PATH=/absolute/path/to/axe-core/axe.min.js
npm run test:phase07.2:browser
npm run qa:phase07.2
```

Browser commands also accept `QA_CHROME_PATH` and default to the installed macOS
Google Chrome binary. `qa:phase07.2` writes after screenshots and structured
observations to `qa/` (override with `QA_OUTPUT_DIR`), using fictional fixture
accounts and isolated databases. CSP bypass is restricted to the scanner browser
context, for axe injection. Test-only faults remain guarded by `NODE_ENV=test`;
no production fault endpoint is added.

The existing phase 01–07 suites remain required. `npm run typecheck` checks both
projects without emitting build files; `npm audit --json` queries advisory data
when the registry is reachable. Neither proves functional or accessibility
acceptance. See [the QA report](qa/phase07.2-qa-report.md) for actual results,
candidate identity and outstanding observations. The original
[mockups](qa/phase07.2-mockups.html) remain design references, not implementation
screenshots.

## Phase 08 · Container, deployment and models

The multi-stage `Dockerfile` compiles the client and server with dev
dependencies, then copies the build output, fictional fixtures, bootstrap
script and production dependencies into a `node:22.22.0-bookworm-slim` image
that runs as the `node` user. The image defaults to `NODE_ENV=production`
and `PORT=3000` and checks `/health/ready`. No secrets are baked in; all
configuration comes from the runtime environment.

### Render

`render.yaml` describes one Docker web service built from this Dockerfile
with `/health/ready` as the health check. Render supplies `PORT` and
`RENDER=true`, which enables the single trusted proxy hop. Set the
`sync: false` values in the Render dashboard:

- `APP_ORIGIN`: the service's public `https://` origin. Production rejects
  non-HTTPS origins and cookies are `Secure`.
- `MONGODB_DB_NAME` and `S3_KEY_PREFIX`: production-only values, distinct
  from development. The S3 bucket CORS must list the Render origin.
- `JWT_SECRET` and `ADMIN_SEED_PASSWORD`: new random values, not the
  development ones.
- `LANGFUSE_TRACING_ENVIRONMENT=production` keeps hosted traces apart.

Bootstrap the production database once from a checkout, using a private
production env file:

```sh
npm ci --include=dev && npm run build
node --env-file=.env.production.local scripts/bootstrap.mjs
```

The free plan sleeps after inactivity. On wake, startup reconciles expired
answer attempts and the index worker reclaims expired job leases, so queued
uploads resume. Originals and citations are read from pinned S3 versions,
never local disk. The rate-limit store is in memory: keep one instance, or
move to a shared store before scaling.

### Models and evaluation

| Purpose | Model | Evidence |
| --- | --- | --- |
| Chat, planning and comparison | `openai/gpt-4o-mini` via OpenRouter | [Live trial](qa/phase05-live-model-trial.json): grounded stream, comparison, mixed evidence and ambiguous-pair clarification all passed; first paragraph in about 3 seconds. |
| Embeddings | `openai/text-embedding-3-small`, 1,536 dimensions | [Preflight](qa/phase04-embedding-preflight.json) and [retrieval evaluation](qa/phase05-retrieval-evaluation.json). |

On the five labeled retrieval fixtures (exact ID, paraphrase, exception,
amendment and cross-page), keyword, vector and hybrid search each found the
expected passage in the top six. Mean first relevant rank was 1.0 for keyword,
1.2 for vector and 1.0 for hybrid. Candidates were empty for a fresh thread and
a second customer, confirming ownership scoping before fusion.
