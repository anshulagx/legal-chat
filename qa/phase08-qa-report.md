# Phase 08 QA report

Date: 2026-11-27. **Phase gate: ACCEPTED WITH USER-APPROVED DEVIATIONS.** The release is reproducible from a clean checkout, the hosted service passes the security, streaming and isolation checks, and the narrated recording covers all six TRD scenes. Four requirements of the plan were changed by Anshul's explicit decisions during the phase (listed below); one hosted observation, durable job resume after a sleep/wake cycle, was not induced and rests on regression coverage. **Tested commit `e3b48de00aec7bce146bdc4c054a4632609af2df`**, exported with `git archive`: build, typecheck and 83/83 regression tests pass, and `docker compose up --build` from that export reaches a healthy app with a cited answer. GitHub checkpoint PASS: [`main`](https://github.com/anshulagx/legal-chat/tree/main) verified at the same SHA. Details: [checkpoint record](phase08-checkpoint.json).

## Approved deviations

| Plan requirement | Decision (Anshul, 2026-11-27) | Consequence |
|---|---|---|
| Build one image, record its digest and deploy that digest | Render builds from the repository Dockerfile | Hosted and recorded evidence is associated by Git commit, not image digest. The hosted service was redeployed from `08c2478`; `e3b48de` adds only `README.md`, `.dockerignore` and `docs/demo.mp4`, all excluded from the image, so the runtime tree is identical. |
| Separate credentials and data for the public and demo services | Keep the shared database `legal_chat_dev` | Production and local runs share one Atlas database with a separate S3 prefix (`legal-chat/prod/`). Local runs must disable indexing or stay stopped while hosted jobs are queued. The README still recommends a separate production database. |
| Isolated hosted demo origin for provider failure, throttling and restart | Record scene 6 on a local isolated container | Faults were induced locally through a Compose override (`INDEXING_ENABLED=false`, an unavailable chat model, `CHAT_GENERATION_LIMIT=2`), not on a second hosted origin. |
| Show the corresponding Langfuse trace | Skip the Langfuse dashboard sign-in; mention tracing | Scene 3 shows the comparison's real trace read back through the Langfuse public API (span names, candidate counts, model, tokens, timings), not the Langfuse UI. |

## Environment

Node 22.22.0; Docker Compose v2; Chrome headless driven by Playwright-core for the recording. Hosted origin <https://legal-chat-wuxo.onrender.com> (Render free instance, Docker runtime). Models: chat `openai/gpt-4o-mini`, embeddings `openai/text-embedding-3-small` (1536 dimensions), both through OpenRouter. Regression database: local replica set `mongodb://127.0.0.1:27028/?replicaSet=legalChatQA`. Compose and hosted runs use Atlas with Search and Vector indexes. Accounts are fictional `@example.test` addresses; cookies, credentials and signed URLs are excluded from evidence.

## Results

| Check | Expected and actual observation | Evidence | Result |
|---|---|---|---|
| 08.1 Clean Compose startup | From a `git archive` export of `e3b48de`, with `.env` filled from `.env.example` and no other steps, `docker compose up --build` built image `sha256:7e1ab9e5eb5d…`. Bootstrap exited 0 (`bootstrap_ready`, two active shared documents); the app reported healthy and `/health/ready` returned `{"status":"ok"}`. Signup returned 201; the first suggested question “How do I export my contracts?” completed with a help-guide citation (passage `…:p:2`, exact quote). Every key the app reads is documented in `.env.example`. | Commands below | PASS |
| 08.2 Hosted release | Signup 201 with an `HttpOnly; Secure; SameSite=Lax` cookie. `POST /chat/send` with `Accept: text/event-stream` returned `text/event-stream`, seven chunks, first after 1.0 s, events `accepted, progress, paragraph, complete`, citing the 90-day policy. Customer B received 404 for customer A's history and attachments and 403 for `/admin/documents`; A read its own history (200). Logout 204, then 401. CSP and `nosniff` headers present. Recorded scenes add the browser-to-S3 POST (status and size, no signed fields), private sources, the policy switch and the superseded citation. The gap answer completed with a handoff offer 4/4 times after the `08c2478` redeploy. | Commands below; recording scenes 1–5 | PASS with deviations above |
| 08.3 Repository and video | Repository and video are public at [docs/demo.mp4](../docs/demo.mp4), linked from the README (8 min 20 s, ElevenLabs narration, captions). Watched end to end via a timestamped contact sheet and spot frames. No credentials, cookies or signed URLs in frame; the S3 panel shows host, status and size only. | [Contact sheet](phase08-video-contact-sheet.png), scene table below | PASS |
| 08.4 Six-flow reconciliation | All six flows observed on the hosted origin or the isolated local container (table below), with model IDs above, retrieval evaluation in the README's Phase 08 section and accessibility evidence from the [phase 7.2 report](phase07.2-qa-report.md). | Tables below | PASS |
| Regression | `npm run build` and `npm run typecheck` pass on the export; 83/83 tests across phases 01–07, client stream, grounding (including the passage-ID stripping test), telemetry and 7.2 backend. | [Regression log](phase08-regression.log) | PASS |

## Recording timestamps

| TRD scene | Starts | Required items and approximate times |
|---|---|---|
| 1. First cited answer (hosted) | 0:00 | Signup 0:10, streamed cited answer 0:30, source dialog with exact passage 0:40, follow-up 0:55 |
| 2. Direct upload to S3 (hosted) | 1:04 | Browser-to-S3 POST panel with host, status and size 1:10–1:40; queued, indexing and ready states |
| 3. Comparison, A2UI and tracing (hosted, GitHub) | 1:50 | ClauseComparison card 2:00, A2UI v0.8 message panel 2:20, validation and closed renderer catalog on GitHub 2:40–3:10, Langfuse trace panel 3:20–3:35 |
| 4. Evidence gap and privacy (hosted) | 3:45 | Named gap and email draft 3:55–4:10, second customer 4:30, denied history and admin 4:35–4:45 |
| 5. Admin policy revision (hosted) | 4:52 | Replacement queued → ready → published 5:00–5:35, failed corrupted file, retry and archive 5:35–5:50, new 90-day citation 5:52, old citation labelled Superseded 6:00 |
| 6. Recovery and Compose (local isolated container) | 6:10 | Compose startup 6:10–6:35, failed reply and Retry 6:40–7:05, 429 countdown 7:15–7:30, logout and protected route 7:35–7:45, README 7:50 |

## Six release flows

| Flow | Observation | Origin |
|---|---|---|
| 1. Suggested question and cited answer | Streamed answer, hover preview and exact passage (scene 1); API stream check above | Hosted |
| 2. Agreement and amendment | Direct S3 upload to ready, ClauseComparison A2UI card, both sources, renderer code (scenes 2–3) | Hosted |
| 3. Unsupported term | Named gap and copyable draft after acceptance (scene 4); 4/4 API runs completed with handoff | Hosted |
| 4. Fresh chat, restored thread, second account | Private files scoped to their chat, reopened thread, B denied with 404/403 (scene 4 and API) | Hosted |
| 5. Admin replacement | Status transitions, new citation, superseded old citation, failed file with retry (scene 5); customer admin denial 403 | Hosted |
| 6. Failed reply, throttling, logout, Compose | Failure and Retry, 429 countdown, logout (scene 6); clean Compose (08.1) | Local isolated container |

## Observations

- **Job resume after wake not induced on the hosted service.** The free instance was observed waking (`/health/ready` returned `unavailable`, then `ok`), and queued uploads reached ready after the redeploy, but no job was left queued across a sleep. Lease recovery and restart are covered by the phase 07 regression tests.
- **No `Strict-Transport-Security` header.** The TRD does not require it and Render serves HTTPS only; adding HSTS is a small hardening option.
- **Shared database residue.** The notice policy is now published as v3 (90 days). Earlier recording takes left extra notice-policy revisions in the admin version list and test chats on the seeded admin account, visible in scene 5's sidebar.
- **Same-agent verification.** The release was implemented, recorded and verified by the same agent; no independent reviewer ran this gate.

## Reproduction

```sh
git archive e3b48de | tar -x -C /tmp/legal-chat-phase08-clean
cd /tmp/legal-chat-phase08-clean
cp .env.example .env   # fill in the values
npm ci && npm run build && npm run typecheck
QA_MONGODB_URI='mongodb://127.0.0.1:27028/?replicaSet=legalChatQA' \
  node --test --test-concurrency=3 scripts/phase0[1-7].test.mjs scripts/client-stream.test.mjs \
  scripts/grounding.test.mjs scripts/phase07-telemetry.test.mjs scripts/phase07.2-backend.test.mjs
docker compose up --build   # then curl localhost:3000/health/ready
```

Clean-checkout build output: 268.23 kB JavaScript (82.46 kB gzip) and 34.93 kB CSS (8.14 kB gzip).
