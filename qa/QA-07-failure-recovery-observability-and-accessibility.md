# QA 07 · Failure recovery, observability and accessibility

**Decision to make.** A failed or interrupted answer can be retried without losing the question, attachments or partial response.

**Sources.** Assignment and release requirements · failure recovery and bonuses. Acceptance 4–6. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§2, 4, 6–9](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Confirm phase 06 passed. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **07.1** Use an isolated test adapter to fail before headers, then after one validated paragraph. Expect 503 JSON in the first case and terminal SSE error in the second. Disconnect another stream, restart the service and reload. Verify interrupted text, status, original question and attachment IDs remain.

2. **07.2** Retry the failed user turn twice concurrently with the same retry ID. Count one original user message, one new attempt, preserved selections and two follow-ups on successful completion. B cannot retry A’s turn. Simulate stale active state and confirm the next valid generation can proceed.

3. **07.3** Set the generation limit low, exceed it, inspect 429, Retry-After and matching UI delay. Retry after expiry. B’s independent quota still works. Stop telemetry delivery and verify chat still completes. Inspect a real Cloud trace and retry link for timings, retrieval ranks, status and usage when available. Test default masking with a fictional marker, checking that no content, tokens or signed form fields appear.

4. **07.4** Run an accessibility scan on signup, login, chat, source viewer and admin. Exercise keyboard-only navigation, Escape/focus return, hover/focus preview dismissal, 320 CSS px reflow, zoom and a screen reader. Record announced stage and completion, stable focus, readable errors and comparison order. Unresolved WCAG 2.2 AA failures fail the gate. If a screen reader is unavailable, obtain an observed operator walkthrough before passing.

**Required automated evidence.** Run `npm run test:wave-07` from the repository root. Require a passing assertion for each of these cases: interrupted streams, stale attempts after restart and concurrent retries. Record the case names and results.

### Command for this gate

```sh
curl -sS -b "$A_COOKIE" --get "$BASE/chat/history" --data-urlencode "conversationId=$THREAD"
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
