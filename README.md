# Legal Support Chat

## Run Phase 01

Use Node 22.22.0 (see `.nvmrc`) and a development MongoDB database. Copy
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
