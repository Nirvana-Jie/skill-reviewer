# Validation record

This record preserves the current result boundary for the generic Agent runner,
adapter registry, and Dashboard provenance change. It is maintainer evidence and
is not installed as Agent context.

## Code under test

- Branch: `codex/dashboard-decision-first-ui`
- Date: 2026-07-19 (Asia/Shanghai)
- Execution API: `scripts/run_agent_eval.mjs`
- Registry: `assets/agent-adapter-registry.json`

Generated Eval workspaces and Agent state were ephemeral and are intentionally
not committed. Repository policy forbids retaining credentials, CLI state, or
generated run workspaces.

## Deterministic quality gates

The worktree passed:

- `pnpm test`: 30 files; 29 passed, 1 explicitly skipped; 360 tests; 358 passed,
  2 explicitly skipped;
- Dashboard TypeScript checking and production build;
- all current Python scripts through `py_compile` and all MJS runtime files
  through `node --check`;
- Skill package lint, Eval Manifest JSON parsing, and `git diff --check`;
- deterministic Dashboard packaging and committed-manifest comparison.

The repository contains no Python unittest cases and no local snapshot validator;
neither no-op nor deleted commands are represented as quality evidence.

- Skill package lint digest:
  `e54261fd81d26c4220ec7856f901d2dfb09608f7469dd59311f6360c793035c9`
- Dashboard tree SHA-256:
  `fa8b1f1fad2a386b3fdb679ddf6df0918dff6a8f14387b8b59e630709b5997e5`
- Dashboard archive SHA-256:
  `0d2ff7aa65bf38277bfe856c78518c51d245103211113139e94f0fd4ad392040`

## Real Agent canary

The opt-in `dashboard/src/real-agent-trace.e2e.test.ts` was run for both
implemented adapters in one invocation:

```bash
SKILL_REVIEWER_REAL_AGENT_E2E=codex,claude \
  pnpm exec vitest run dashboard/src/real-agent-trace.e2e.test.ts
```

Result: 1 file passed, 2/2 tests passed, total duration 62.36 seconds after the
version-policy, runtime-binding, paired-cancellation, and tool-correlation fixes.

Each test compiled a fresh locked development case from a minimal registry-based
profile, invoked the real local CLI, retained and normalized the source stream,
graded the output, projected Dashboard data, validated adapter/source/digest
bindings, rendered the Trace UI, and expanded the real marker event. The
executable adapters now fail closed outside Codex CLI `0.144.5` and Claude Code
`2.1.215`; a per-run binding also holds all paired cells to one executable
digest and operational envelope. Codex and Claude Code are therefore marked
`canary-verified` only for these exact adapter/version contracts.

Gemini CLI, GitHub Copilot CLI, and OpenCode remain `not-implemented` execution
entries. Their registry records preserve researched source identity, protocol
stability, and evidence limits; they are not presented as executable support.
OpenTelemetry GenAI is telemetry rather than an executing Agent and therefore
stays outside the execution registry.

## Claim boundary

This is a public development canary for execution and presentation plumbing. It
does not prove opaque-audit behavior, authorize release, or establish that any
arbitrary Skill is high quality. A future Agent version or source-format change
must be revalidated before its adapter maturity is retained.
