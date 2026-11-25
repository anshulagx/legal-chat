# QA 08 · Hosted release and recorded acceptance

**Decision to make.** A reviewer can reproduce the application and follow the complete hosted demonstration.

**Sources.** Assignment and release requirements · handoff. Acceptance and demo 1–6. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§7–9](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Confirm phase 07 passed. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **08.1** From a clean checkout of the handoff revision, follow only the README and example environments, run the documented bootstrap and docker compose up. Check readiness, suggested question and first citation. Record any undocumented manual step as a failure.

2. **08.2** Open the README’s deployed URL in a clean browser profile. Verify public signup, then run the six acceptance flows across the public and isolated demo origins. Compare deployed image digests to the candidate build before testing. Verify hosted streaming, the browser-to-S3 POST, private sources, policy version switch and denied customer admin actions. On the demo origin, exercise provider and indexing failure, low quotas and wake/restart. Verify history and jobs survive, and record the origin and digest beside each result.

3. **08.3** Open repository and video links with reviewer-level access. Watch the recording end to end. Match the recording and deployment evidence to the candidate digest and record timestamps for all six TRD scenes, including direct upload host/status/size, agent-selected A2UI plus renderer, corresponding Langfuse trace, email draft, isolation, superseded source, retry delay and Compose startup. Redact any sensitive recording before handoff.

4. **08.4** Reconcile the run with the six-flow matrix in the plan. Attach observed URL, tested revision, model IDs, retrieval report, accessibility results and one evidence reference per flow. A missing link, required scene or unresolved prior gate prevents release.

### Command for this gate

```sh
docker compose up --build
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
