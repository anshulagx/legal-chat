# QA 01 · Foundation and account sessions

**Decision to make.** An authenticated customer can enter and leave a running app.

**Sources.** Assignment and release requirements · authentication, configuration and handoff. [PRD](../Legal_Support_Chat_PRD.md) · [TRD §§1–2, 4, 8](../Legal_Support_Chat_TRD.md) · [Implementation plan](../Implementation_Plan.md)

## Set up the review

Use a clean checkout of the locally committed candidate SHA. Record the SHA with the evidence. Use the handoff’s documented startup command and fixture paths. Use isolated fictional records and distinct browser profiles for customers A and B and the seeded admin as needed. For shell examples, set BASE to the origin without a trailing slash. Set any referenced cookie variable to the path of a private authenticated curl cookie jar and replace record variables with IDs observed during your run. Keep cookie values, credentials and signed URLs out of evidence.

## Required checks

1. **01.1** Start using the README in a fresh checkout. GET /health/live and /health/ready return healthy. In an isolated run disconnect Atlas and check readiness becomes unhealthy while liveness remains healthy. Capture status codes.

2. **01.2** Use Chrome to sign up, log out, log in and reload. In Network inspect cookie attributes, recording attributes only. Anonymous /auth/me returns 401. After logout the former cookie also yields 401. Check browser Back cannot restore usable private content.

3. **01.3** POST /auth/signup with case variants of one address, an over-72-byte password and a requested admin role. Verify only one normalized account, long password rejected, and no privilege grant. Inspect a test account through a redacted server-side assertion for a bcrypt hash. Wrong credentials return a generic error. A foreign Origin mutation is rejected.

4. **01.4** Set a small auth limit in the test environment, exceed it and observe 429 and Retry-After. Repeat form submission by keyboard and check labels, errors and focus.

### Command for this gate

```sh
curl -si "$BASE/health/ready"
curl -si "$BASE/auth/me"
```

## Record the verdict

Report revision, environment and fixture versions, then one row per check with check ID, expected outcome, actual observation, evidence reference and result. Use sanitized HTTP status/body fields, browser observations, or named integration test output. Record a minimal reproduction for each failure. Mark **PASS** only when every check passes, **FAIL** for an observed mismatch, or **BLOCKED** when a required check cannot run. Both FAIL and BLOCKED keep the gate open. Send the report to the implementation agent for remediation and retest.

**After PASS.** Hand the reviewed revision and evidence to the implementation agent. The agent pushes the tested commit and verifies the target branch per the implementation plan. Record the GitHub link and tested SHA before advancing.
