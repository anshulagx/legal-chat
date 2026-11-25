# QA 02 · Conversations and durable turns

**Decision to make.** A user turn has one durable identity, including when the first request is repeated.

**Sources.** Customer experience · fresh chat and conversation ownership. Assignment · chat and persistence. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§2, 4, 6–7](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Confirm phase 01 passed. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **02.1** With accounts A and B, send a uniquely tagged message as A, restart the server, log in again and inspect the fresh composer. Select A’s sidebar thread and compare question, order and title to GET /chat/history?conversationId=<id>.

2. **02.2** Using the test adapter, issue two concurrent POST /chat/send requests with the same clientMessageId and message and no conversationId. Poll history until terminal. Expect one thread, one user turn, one generation and matching IDs. Replay after completion returns the stored result. Reuse the key with changed text and expect 409.

3. **02.3** Create enough threads and turns to fetch two pages at limit=1. Follow nextCursor and check stable, distinct IDs. Create an empty thread and check the sidebar omits it. B’s list excludes A’s thread and B’s filtered history request returns 404.

**Required automated evidence.** Run `npm run test:wave-02` from the repository root. Require a passing assertion for each of these cases: concurrent first sends and idempotency conflicts. Record the case names and results.

### Command for this gate

```sh
curl -sS -b "$A_COOKIE" --get "$BASE/chat/history" --data-urlencode "conversationId=$THREAD" --data-urlencode 'limit=1'
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
