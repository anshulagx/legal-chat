# QA 03 · Direct uploads and immutable originals

**Decision to make.** The browser uploads a private original and the server pins the exact bytes for processing.

**Sources.** Customer experience · conversation-scoped uploads. Administrator experience · shared file management. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§2–4, 8](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Confirm phase 02 passed. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **03.1** Upload a small PDF as A in a fresh chat. Capture only Network method, hostname, status and size for reservation, S3 POST and completion. Expect file bytes only in the S3 request, 202 at first completion, one listed attachment in queued or subsequent state, and a private original.

2. **03.2** With two simultaneous completions and a repeated reservation ID, verify one reservation, one pinned version and one queued job. In an isolated bucket reuse the still-valid form for different fixture bytes. Assert the worker input still resolves to the first pinned checksum.

3. **03.3** Attempt six concurrent reservations in one empty thread, a >5 MiB original and an unsupported MIME. Assert at most five live slots, documented 413/415 on the corresponding API validations and rejection of out-of-policy S3 uploads. Expire an unused reservation with a test clock, run cleanup and reserve a released slot. Previously pinned originals still resolve.

4. **03.4** Check B cannot list A’s attachments or complete A’s reservation (404). Customer shared-document management returns 403. An expired reservation without bytes requires a new upload. Exceed the configured reservation limit and record the retry delay.

**Required automated evidence.** Run `npm run test:wave-03` from the repository root. Require a passing assertion for each of these cases: duplicate completion, signed form replay, oversized uploads, reservation expiry and slot recovery. Record the case names and results.

### Command for this gate

```sh
curl -si -b "$B_COOKIE" "$BASE/conversations/$THREAD/attachments"
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
