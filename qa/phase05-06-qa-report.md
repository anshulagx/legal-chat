# Phase 05–06 implementation QA

Reviewed on 26 November 2026. Independent QA subagent exercised the shared implementation working tree based on `5e2ada52a788dfcda5f503f5f771fe760d620366`; frozen-candidate verification is recorded below when available. Node 22.22.0, local isolated MongoDB replica set, separate fictional customer A/customer B/admin sessions. Deterministic provider and storage injection is restricted to `NODE_ENV=test`. Live retrieval and model trials are separate from those deterministic tests.

**Functional verdict: PASS for the exercised cases.** This is not an exhaustive retrieval/answer-quality evaluation. The five-case retrieval dataset is small and deliberately uses fictional documents. The live model trials provide a small smoke sample, not proof that arbitrary cited prose is entailed by its source. Full phase gate/checkpoint status also depends on the external verification and candidate-checkpoint notes below.

| Check | Expected and observed evidence | Result |
|---|---|---|
| 05.1 | Accepted → progress → validated paragraph → complete. The HTTP delayed fixture verifies the first paragraph is persisted while the attempt is still generating and arrives at least 100 ms before completion. Fragmented UTF-8, CRLF/delimiters and heartbeats are covered by client parser tests. Browser showed streamed paragraphs while validation was still in progress. | PASS |
| 05.2 | TXT viewer returns the exact half-open UTF-16 range and immutable original. PDF source HTTP test returns the exact fixture bytes with PDF MIME, page 2 and `#page=2`. Shared historical citations change to Superseded then Archived without losing source access; an exact selected-source send replay returns its original answer after both transitions. Browser keyboard activation opens the exact TXT excerpt; Escape returns focus to the anchor. Actual PDF rendering was not separately inspected in the initial browser run. | PASS for API/source anchors; PDF browser check remains limited |
| 05.3 | All five labeled queries (exact clause ID, paraphrase, exception, amendment, cross-page continuation) retrieve the expected chunk in the first six across keyword/vector/hybrid against real Atlas and OpenRouter embeddings. Hybrid and keyword first relevant rank: 1 for all five. Vector: 1 for four, 2 for cross-page. Invalid anchors are withheld; one correction is bounded; a correction changing an already emitted paragraph is rejected. | PASS |
| 05.4 | Customer B and seeded admin each receive 404 for A’s private filtered history, passage and file. Explicit selected IDs cannot grant access in A’s fresh thread or B’s thread. Both keyword and vector branch scopes are checked before fusion; unauthorized/stale hits fail closed. Real Atlas original-thread queries return authorized candidates; fresh/B queries return zero. JSON/SSE contracts, durable citations/suggestions, and suggestion submission are exercised. | PASS |
| 06.1 | One complete comparison event carries the pinned A2UI v0.8 messages and closed ClauseComparison catalog. Notice row resolves the 30-day agreement and 60-day amendment; one-sided export evidence is explicitly missing. Unknown component/catalog/protocol/mismatched rows fail renderer validation. Browser rendered the complete card and source quotes. | PASS |
| 06.2 | Adding a third file produces pair clarification. Selecting two constrains candidate branches and comparison references to those versions. History restores the same surface and two suggestions. At 390×844, comparison passages stack beneath the term; document scroll width 375 px stays within the 390 px viewport. | PASS |
| 06.3 | Mixed question returns a cited supported paragraph, named liability-cap gap and handoff offer. No draft exists before acceptance. Two concurrent acceptances return the identical persisted subject/body, verified source excerpts, unresolved question and two follow-ups. Customer B/admin cannot accept A’s offer. Browser Copy places the unresolved liability question on the clipboard; reopen restores the draft. No email-send route exists. | PASS |

## Repeatable automated checks

Build with `npm run build`, then run the following with Node 22 and the isolated replica set documented in README:

| Command | Passing tests |
|---|---:|
| `npm run test:phase01` | 6 |
| `npm run test:wave-02` | 10 |
| `npm run test:wave-03` | 9 |
| `npm run test:wave-04` | 12 |
| `npm run test:wave-05` | 27 |
| `npm run test:wave-06` | 4 |

Total: **68 passing tests**, zero failures/skips. Root-local logs are `/private/tmp/legal-chat-phase05-final-regression01.log` through `04.log`, `/private/tmp/legal-chat-phase05-final-tests.log` and `/private/tmp/legal-chat-phase06-final-tests.log`.

Source isolation case names are `05.4 second customer cannot read private history, passage or original file`, `05.4 seeded admin cannot read private history, passage or original file`, `05.4 explicit selected IDs cannot grant private evidence in another or fresh thread`, and `05.3/05.4 keyword and vector candidate scopes exclude private source before fusion`.

## Live evidence and browser evidence

- [Retrieval evaluation](phase05-retrieval-evaluation.json): actual Atlas text/vector indexes and `openai/text-embedding-3-small`, 1536 dimensions. Isolated randomly prefixed collections were dropped after evaluation. Run with `QA_RETRIEVAL_ENV_FILE=/path/to/private-qa.env node scripts/phase05-live-retrieval.mjs` after building; the command never logs credentials.
- [Model trial](phase05-live-model-trial.json): chosen `openai/gpt-4o-mini` candidate; streaming structured output, factual citations, comparison rows, mixed evidence and ambiguity observations are recorded individually.
- [Telemetry verification](phase05-live-telemetry.json): authoritative current ingestion/readback result, including any external timeout/blocker.
- [Desktop comparison](phase05-06-desktop.jpg) and [mobile comparison](phase05-06-mobile.jpg): browser evidence from an isolated deterministic fictional fixture. Browser QA used real HTTP/SSE and DOM behavior, with model/storage doubles.

## Remaining gate/checkpoint observations

Langfuse export code is covered by masking/allowlist tests. The final [live telemetry evidence](phase05-live-telemetry.json) records **PASS** for ingestion and readback with six observations. Earlier probes had a timeout and an unavailable legacy read endpoint; the final verification uses the supported readback route and confirms the trace is present.

The implementation plan also requires a clean checkout of a committed candidate and a verified remote GitHub checkpoint after PASS. These are distinct from the functional checks above. Do not interpret a working-tree test pass as a completed remote checkpoint. No production deployment, outbound email, or broad real-world legal-answer validation was performed in this QA run.
