# Validation record

This record preserves the result boundary for the script and Dashboard
governance change. It is maintainer evidence and is not installed as Agent
context.

## Code under test

- Final deterministic gates and Codex canary commit:
  `9ef9972be0f1f81cccb4b6f096ff4bae7555cfc4`.
- Claude fail-closed canary commit:
  `a4915dc4483c36038cce014d0484b33ef798cbbb`.
- Branch: `codex/dashboard-decision-first-ui`
- Date: 2026-07-19 (Asia/Shanghai)
- Local retained roots:
  `/private/tmp/skill-reviewer-real-canary-9ef9972` and
  `/private/tmp/skill-reviewer-real-canary-a4915dc`.

The retained workspace is intentionally not committed: repository policy
forbids generated Eval workspaces and provider state. The digests below make
the local record independently checkable while it remains present.

## Deterministic quality gates

The repository passed the pinned pnpm install, full Vitest suite, Dashboard
typecheck and production build, Skill package lint, Eval Manifest JSON parse,
all-script Python compilation, diff hygiene, deterministic Dashboard packaging,
committed-manifest comparison, and safe extraction check.

- Vitest: 28 files; 27 passed, 1 skipped; 339 tests; 337 passed, 2 skipped.
- Skill package lint digest:
  `16528f9861d994ca3955db6f51fb349f4843a80f681d3f2523d8ab28259e7c65`.
- Dashboard tree SHA-256:
  `0c2878b18325f09ff8bc4249a0b6694279c6a50660e3974addea28d80071ade4`
- Dashboard archive SHA-256:
  `5156276022e9b1d60889ce70d8c27207878af79ebe08f8b1790e72452cbab41d`

## Real provider canary

The opt-in `dashboard/src/real-agent-trace.e2e.test.ts` was run separately for
each provider against the commit above. It compiles a fresh locked development
case, invokes the real local CLI, retains the provider stream and canonical
Trace, grades the result, projects Dashboard data, validates the schema, and
renders the Trace UI.

### Codex — passed on the final script boundary

- Test duration: 43.95 seconds; provider duration: 15.101 seconds.
- Run: `run-b8f11cf7bd0f3b386690`.
- Execution status / exit code: `completed` / `0`.
- Source events / normalized events: `9` / `9`.
- Credential leak count: `0`.
- Source SHA-256:
  `3076ab0d6911ecd99230773942923750b92886c5523acbee9b2ce1f3b5e64c0a`.
- Trace SHA-256:
  `7545dab997e58ed91f910181b3c7283d5096745c3dfc2e6e99336652818f332d`.
- Verification evidence SHA-256:
  `297cacaf787906a2fbab987abe764c8c545886236deca890eddd733f8efb96df`.
- Dashboard data SHA-256:
  `9be96390df673ee773cc0d348e873a4ef8cdf7cdf9e50808d6bf51745f0af50c`.

### Claude — external authentication blocked, failed closed

- Provider duration: 5.367 seconds.
- Run: `run-8e0d6cbbb2ab9d583c32`.
- Execution status / exit code: `failed` / `1`.
- Provider init reported `apiKeySource: none`; provider result reported HTTP
  `401`, `terminal_reason: api_error`, invalid authentication credentials, and
  total cost USD `0`.
- Source events / normalized events: `5` / `4`.
- Credential leak count: `0`.
- Source SHA-256:
  `abe6c021b84f6dc9fd34e54baf276682e8856e8f49fefe282eeef0b5275f3010`.
- Trace SHA-256:
  `6d5a0bd238db138a7441fa3b296176d6ed4963ae43bf6c0d6f8d4de0401a5301`.

The adapter retained a complete, bound failure Trace and returned non-zero; it
did not manufacture output, grading evidence, or Dashboard success. A real
Claude success canary requires the user to restore local Claude authentication.

## Claim boundary

This is a public development canary for execution and presentation plumbing.
It proves the final Codex end-to-end path on this machine. The Claude record
proves fail-closed behavior on the stated earlier commit; the final boundary
refactor received deterministic coverage but was not presented as a successful
Claude run. Neither record is an opaque audit, release authorization, or
general Skill quality claim.
