# Validation ledger

Append-only record of what has actually been verified for each version of the
skill-reviewer package. It is maintainer evidence and is not installed as Agent
context. Newest entry first. Each entry separates deterministic gates (tests,
lint, compile) from real Agent execution, because only the latter is behavior
evidence.

Entries are written by following [docs/self-eval-runbook.md](./self-eval-runbook.md).

## Ledger

### v0.1.1 + eval-governance hardening (branch `governance/eval-hardening`, 2026-09-16, Asia/Shanghai)

Scope of the change: rendering-tolerant bilingual oracle (12 cases), bilingual
label table and review-summary block in the output contract, compatible-range
CLI version policy with drift recorded as a limitation, `event_absent` on the
canonical trace, per-cell model provenance, semantic judge executor, and the
eval-risk process (PR template, runbook, this ledger).

Deterministic gates: recorded at merge time by the pull request (`pnpm test`,
typecheck, Dashboard build, skill lint, strict manifest parse, `node --check`).
`pnpm test` compiles all three splits of the shipped manifest and grades
realistic responses through every `must_pass` predicate.

Real Agent execution: **not run**. No cell of the shipped manifest has been
dispatched against this package yet. Until an entry below this line records
run ids, CLI version, model, cell counts, and pass rates, every claim about
this package's own Evals is structural, not observed.

### v0.1.1 (branch `codex/mjs-dashboard-evidence-audit`, 2026-07-20, Asia/Shanghai)

Historical entry, preserved as written at the time. Execution API:
`scripts/run_agent_eval.mjs`; registry: `assets/agent-adapter-registry.json`.
The manifest used by the "real end-to-end Skill evolution" section below was
the meeting-note-helper demo manifest in a separate ignored repository, not
`skills/skill-reviewer/evals/evals.json`; the numbers do not describe the
reviewer's own five cases of that date.

#### Deterministic quality gates

The worktree passed:

- `pnpm test`: 28 files; 27 passed, 1 explicitly skipped; 365 tests; 363 passed,
  2 explicitly skipped;
- Dashboard TypeScript checking and production build;
- all native ESM runtime files through `node --check`;
- Skill package lint, Eval Manifest JSON parsing, and `git diff --check`;
- deterministic Dashboard packaging and committed-manifest comparison.

- Skill package lint digest:
  `5082851b63385b431949505b429e0a66aab09383ba5c560182a289df764a8d3b`
- Dashboard tree SHA-256:
  `fd342c25abe5ad77dbb11f9b33a97e8513bf3d4b070fd91bbd5ca4079768454f`
- Dashboard archive SHA-256:
  `ccdd2a3798bf7e9d0a523f268afd9342b7c8b964aa1061cd45a59d5e176cef18`

Decision tests additionally prove that a favorable mean cannot hide a
repeat-level regression or claim material improvement when any paired repeat
misses its threshold. Three repeats remain a conservative consistency gate,
not a statistical-confidence claim. Supplemental semantic judgments add
limitations but do not overrule complete deterministic paired evidence or
create Dashboard blockers.

#### Real Agent canary

The opt-in `dashboard/src/real-agent-trace.e2e.test.ts` was run for both
implemented adapters in one invocation:

```bash
SKILL_REVIEWER_REAL_AGENT_E2E=codex,claude \
  pnpm exec vitest run dashboard/src/real-agent-trace.e2e.test.ts
```

Result: 1 file passed, 2/2 tests passed, total duration 58.80 seconds. Each test
compiled a fresh locked development case (a synthetic marker case, not a
reviewer case) from a minimal registry-based profile, invoked the real local
CLI, retained and normalized the source stream, graded the output, projected
Dashboard data, validated adapter/source/digest bindings, rendered the Trace
UI, and expanded the real marker event. Codex CLI `0.144.5` and Claude Code
`2.1.215` are therefore the canary-verified versions recorded in the registry.

Gemini CLI, GitHub Copilot CLI, and OpenCode remain `not-implemented` execution
entries.

#### Real end-to-end Skill evolution (demo manifest, not the reviewer's own)

A separate, ignored Git repository exercised the installed Skill in Evolve mode
through Codex CLI YOLO execution. The proposal session
`019f7be4-bda6-76b1-99f5-44b8eb43f656` changed only the candidate
`meeting-note-helper/SKILL.md` and left the accepted baseline, Eval authority,
execution profile, and opaque holdout unchanged.

The first public selection run (`run-75172fb4c33312c723f7`) completed all 12
planned Agent cells with no framework failures, but retained output exposed a
measurement defect: two negative regular expressions crossed the next Markdown
section and a table assertion assumed label/value adjacency. That run was
quarantined as invalid measurement rather than counted as a rejected candidate.
The Oracle was repaired with boundary-bearing passing examples, then frozen
under a new authority digest.

Under repaired authority `af814d8c4e38a2ca74b473d5a96248106defd04f6b5a61ad4f406379e7b11621`:

- selection run `run-1810897178677f8e861c` completed 12/12 cells with zero
  framework failures; both public objectives improved in every paired repeat
  (`+0.667 × 3` and `+0.6 × 3`);
- the one authorized opaque audit run `run-0d1987a5b4b399efbed1` completed 9/9
  cells across candidate, old-Skill, and no-Skill arms with zero framework
  failures;
- the audit candidate scored `1.0 × 3`, the old Skill scored `0.4 × 3`, and all
  paired deltas were `+0.6` against a predeclared `+0.3` material threshold;
- measurement was valid, 6/6 release gates passed, no forbidden action or
  external side effect was observed, and evolution terminated at
  `audit-passed / request_user_release`.

#### Real Dashboard inspection

The production build opened a real Codex canary projection through the
authenticated loopback server at 1440×1000 and 390×844 with no horizontal
overflow and zero console errors. The inspection found and fixed an
attention-ranking defect (an absolute five-second cap flagged all nine normal
17–42 second executions as slow; a median/MAD fence reduced false slow flags
from 9 to 0).

## Claim boundary

A canary proves execution and presentation plumbing. A demo-manifest evolution
proves the governance chain on that manifest. Neither authorizes release of the
reviewer package, generalizes to arbitrary Skills, or turns three repeats into
statistical confidence. A future Agent version, source-format change, or
authority change must be revalidated before its claims are retained.
