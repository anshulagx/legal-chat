# QA 04 · Indexing and policy publication

**Decision to make.** A ready version is searchable and a failed replacement leaves the previous policy available.

**Sources.** Administrator experience · queued through ready, failed retry and replacement. Acceptance 5. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§3–5, 7–8](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Confirm phase 03 passed. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **04.1** Verify the configured embedding model and index dimensions match the preflight record. Bootstrap twice. Compare counts, versions and active pointers. For a digital PDF with cross-page text and a TXT with an emoji before the target, compare extracted anchors to original page text and the exact UTF-16 substring. Check both Atlas branches return the expected IDs before ready.

2. **04.2** Upload encrypted, malformed, image-only and 51-page PDF fixtures. Inspect failed state and a readable reason. Simulate a transient embedding outage separately, restore the provider and use retry on the same pinned version. Observe ready with no duplicate passages.

3. **04.3** Pause indexing mid-job, stop its worker, expire the lease and resume with another worker. Attempt a late write via the old worker test harness. Only the current lease can publish, and passage/chunk counts match the expected generation.

4. **04.4** Publish policy V1, stage V2 and inspect active ID during indexing and after failure. V1 stays active until a valid V2 is ready. Race two replacements from the same base and archive a separate document during indexing. Check only the eligible winner activates, archived documents stay archived, and audit entries identify the transitions.

**Required automated evidence.** Run `npm run test:wave-04` from the repository root. Require a passing assertion for each of these cases: malformed files, expired and stale worker leases, replacement races and archive during indexing. Record the case names and results.

### Command for this gate

```sh
curl -sS -b "$ADMIN_COOKIE" "$BASE/admin/documents"
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
