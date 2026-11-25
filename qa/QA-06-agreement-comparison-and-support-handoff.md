# QA 06 · Agreement comparison and support handoff

**Decision to make.** The customer can verify both sides of a change and copy a draft for an unresolved question.

**Sources.** Customer experience · compare clauses and handle incomplete evidence. Acceptance 2–3. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§2, 5–7, 9](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Confirm phase 05 passed. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **06.1** Upload the provided pair, wait for ready and ask naturally what changed. Compare the notice period on each side to the fixture key. Inspect both original pages and one term present on only one side. Capture a sanitized surface and registration plus Network timing showing exactly one complete comparison event. Reject an unknown catalog component in a renderer test.

2. **06.2** Add a third relevant attachment and ask an ambiguous comparison. Expect a request to identify the pair. Select two and verify both cited versions match that selection. Reload, check the same rows and two suggestions, then inspect at mobile width for term-to-side grouping.

3. **06.3** Ask one supported and one absent question together. Expect a cited partial answer, a named gap and an offer. Before accepting there is no draft. Accept twice, check the same persisted subject/body, copy into a local text field, then reopen the thread. Assert two suggestions and no outbound email delivery.

### Command for this gate

```sh
curl -sS -b "$A_COOKIE" -X POST -H "Origin: $BASE" "$BASE/chat/messages/$ASSISTANT_TURN/email-draft"
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
