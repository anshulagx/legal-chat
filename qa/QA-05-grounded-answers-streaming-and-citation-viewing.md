# QA 05 · Grounded answers, streaming and citation viewing

**Decision to make.** A suggested question streams an answer whose claims can be checked in the original source.

**Sources.** Customer experience · business questions, evidence beside each claim and streamed prose. Acceptance 1 and 4. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§2, 5–8](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Confirm phase 04 passed. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **05.1** Use the ready export pill and curl -N with Accept: text/event-stream on separate turns. Record order and arrival times for accepted, progress, paragraph and complete. In a delayed two-paragraph fixture the first paragraph must be visible before completion. Split a multibyte character and an SSE delimiter across network chunks in a parser test. Expect intact text.

2. **05.2** Check every demo claim against the independent answer key. Hover and focus each anchor, then open by keyboard and touch. Confirm the named version, exact PDF page or highlighted TXT substring. Verify a fresh answer uses the revised policy and a saved answer opens the superseded original. Check the archived source label on historical replay.

3. **05.3** Run exact ID, paraphrase, exception, amendment and cross-page fixtures against all three retrieval modes. Record hit rate at six and first relevant rank, plus chosen model IDs. Each known demo claim must resolve its expected evidence. Inspect an injected invalid citation via a test adapter and confirm no invalid paragraph is emitted or persisted as supported.

4. **05.4** Use a unique fact present only in A’s uploaded file. A’s original thread can answer it, A’s fresh thread lacks it, and B cannot read A’s passage or file route (404). Repeat A’s filtered history, passage and file requests as the seeded admin and expect 404. In a test-only retrieval observation, compare the keyword and vector candidate version IDs before fusion against the allowed snapshot. A’s private version must be absent for B and in A’s fresh thread, including when explicitly selected. Check JSON fields match the streaming contract on a deterministic fixture. Click a suggestion and reload to verify durable history and two suggestions per completed answer.

**Required automated evidence.** Run `npm run test:wave-05` from the repository root. Require a passing assertion for each of these cases: private history, file and passage access for a second customer and the seeded admin, and per-branch candidate scope. Record the case names and results.

### Command for this gate

```sh
curl -N -sS -b "$A_COOKIE" -H "Origin: $BASE" -H 'Accept: text/event-stream' -H 'Content-Type: application/json' --data '{"message":"How do I export my contracts?"}' "$BASE/chat/send"
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
