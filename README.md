# Legal Support Chat

## Run Phases 01–02

Use Node 22.22.0 (see `.nvmrc`) and a development MongoDB replica set or Atlas database. Copy
`.env.example` to `.env` if you do not already have it. For Phase 01 the
required settings are the environment, origin and port, MongoDB URI and database,
JWT settings, admin seed credentials, and authentication limits. Set
`APP_ORIGIN=http://localhost:3000` and `PORT=3000` for the default local
address. Keep a distinct database, origin and signing secret for production.

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
200 once account indexes and the admin seed are ready and MongoDB replies to a
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
