# Environment preflight

From the repository root, use Node 22 or newer and start Docker. Run `npm install` once to install the MongoDB and AWS SDKs. Copy `.env.example` to a private environment file if you do not already have one. Keep credential files ignored by Git.

Set an OpenRouter spending cap before running the command below. The flag authorizes one small chat request and one embedding request per run. Without it, those checks report BLOCKED and no model requests are sent.

```sh
npm run preflight -- --env-file .env --allow-model-calls
npm run preflight -- --env-file .env.production.local --allow-model-calls
```

The command reads provider values from the selected file. It reports missing fields, invalid formats, rejected requests and connection failures without displaying credential values or provider response bodies. FAIL or BLOCKED results exit with status 1. MANUAL entries require separate verification before Wave 01.

| Variables | Required and verified behavior |
| --- | --- |
| `NODE_ENV`, `APP_ORIGIN`, `PORT` | Required. Selects production behavior, validates the app origin and checks the port range. Production requires HTTPS. The origin is checked against S3 CORS. |
| `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_TTL_SECONDS` | Required. A disposable JWT exercises signing, verification, claims and expiry. Generate a distinct secret for each environment. |
| `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD` | Required. Checks email format and the 72-byte bcrypt input limit. The application seeds the account in Wave 01. |
| `MONGODB_URI`, `MONGODB_DB_NAME` | Required. Pings Atlas and checks access to the configured database. Development tests transaction rollback plus filtered text and vector queries, then drops the probe collections. Production performs read-only checks. |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Region and key pair required for the configured IAM setup. Token required for temporary credentials. Each SDK request uses the supplied identity. |
| `S3_BUCKET`, `S3_KEY_PREFIX` | Required. Checks versioning, Block Public Access, CORS and scoped listing. Development uploads a fictional fixture, reads the exact object version and removes it. Production checks configuration read-only. |
| `OPENROUTER_API_KEY`, `OPENROUTER_CHAT_MODEL`, `OPENROUTER_EMBEDDING_MODEL`, `OPENROUTER_EMBEDDING_DIMENSIONS` | Required. The chat candidate returns a reply. The embedding candidate returns a finite vector of the configured size. Development uses that measured vector in the Atlas probe. |
| `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_TRACE_CONTENT` | Required. Project access is checked with both keys. Development sends one content-free trace. Locate its reported ID in the dashboard. Production checks project access read-only and requires content tracing disabled. |
| `AUTH_LOGIN_LIMIT`, `AUTH_LOGIN_WINDOW_SECONDS`, `CHAT_GENERATION_LIMIT`, `CHAT_GENERATION_WINDOW_SECONDS`, `UPLOAD_RESERVATION_LIMIT`, `UPLOAD_RESERVATION_WINDOW_SECONDS` | Required positive integers. Wave 01 onward exercises rate-limit behavior through the app. |

Record the GitHub target branch, baseline SHA and push route separately. Verify Render can see the repo, confirm the service plan and origin, and allowlist the approved outbound ranges in Atlas. Check Chrome, the recording destination and the accessibility walkthrough setup. Repeat deployment-dependent checks from Render after the app is deployed.
