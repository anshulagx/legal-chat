# Legal Support Chat

## Run Phases 01–04

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

Phase 02 saves questions and returns a placeholder acknowledging receipt. It
does not provide legal answers. Document retrieval, grounded answers, citations,
suggestions and streaming arrive in Phase 05; uploads begin in Phase 03.

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
one but cannot deduplicate a retry that also omits it. Nonempty
`selectedDocumentVersionIds` are rejected until document selection exists.

Thread creation, sequence allocation, user turn and assistant attempt are one
MongoDB transaction. The answer adapter runs only after commit. Completion or
adapter failure atomically records the terminal result and releases the thread.
No model calls occur in Phase 02. Explicit failed-attempt retry and recovery of
active attempts after a process crash are Phase 07 work; a completed turn is
durable across restarts now.

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
the placeholder adapter. The deterministic test adapter and pause/failure
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
their backing shared versions are ready. Chat still returns the Phase 02
placeholder until Phase 05 adds grounded generation.

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
