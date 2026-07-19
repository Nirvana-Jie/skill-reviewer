# Validation record

This record preserves the result boundary for the script and Dashboard
governance change. It is maintainer evidence and is not installed as Agent
context.

## Code under test

- Commit: `a4915dc4483c36038cce014d0484b33ef798cbbb`
- Branch: `codex/dashboard-decision-first-ui`
- Date: 2026-07-19 (Asia/Shanghai)
- Local retained root:
  `/private/tmp/skill-reviewer-real-canary-a4915dc`

The retained workspace is intentionally not committed: repository policy
forbids generated Eval workspaces and provider state. The digests below make
the local record independently checkable while it remains present.

## Deterministic quality gates

The repository passed the pinned pnpm install, full Vitest suite, Dashboard
typecheck and production build, Skill package lint, Eval Manifest JSON parse,
all-script Python compilation, diff hygiene, deterministic Dashboard packaging,
committed-manifest comparison, and safe extraction check.

- Vitest: 28 files; 27 passed, 1 skipped; 338 tests; 336 passed, 2 skipped.
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

### Codex — passed

- Test duration: 40.77 seconds; provider duration: 21.215 seconds.
- Run: `run-de6910536aaa5641b5ea`.
- Execution status / exit code: `completed` / `0`.
- Source events / normalized events: `10` / `10`.
- Credential leak count: `0`.
- Source SHA-256:
  `4432ff731e359716af352d5eb73cab8162e113467557462ee927aec161bcab03`.
- Trace SHA-256:
  `377482c3265ec445ea1c095339138292d40feacaac94563386465b6a5fe1d7ea`.
- Verification evidence SHA-256:
  `59298db9b14ac4cd902147b86ddecf5a4c061a8798d61067dcb86ef75de6b29d`.
- Dashboard data SHA-256:
  `7a63107a5040ab4333bab6495ff86f7645ff49b33b78111fd000b641de6f471a`.

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
It proves the Codex end-to-end path and Claude fail-closed behavior on this
machine. It is not an opaque audit, release authorization, or general Skill
quality claim.
