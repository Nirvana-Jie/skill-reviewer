# Validation record

This record preserves the current result boundary for the evidence-first
Dashboard and repeat-consistent decision/runtime governance change. It is
maintainer evidence and is not installed as Agent context.

## Code under test

- Branch: `codex/mjs-dashboard-evidence-audit`
- Date: 2026-07-20 (Asia/Shanghai)
- Execution API: `scripts/run_agent_eval.mjs`
- Registry: `assets/agent-adapter-registry.json`

Generated Eval workspaces and Agent state were ephemeral and are intentionally
not committed. Repository policy forbids retaining credentials, CLI state, or
generated run workspaces.

## Deterministic quality gates

The worktree passed:

- `pnpm test`: 28 files; 27 passed, 1 explicitly skipped; 365 tests; 363 passed,
  2 explicitly skipped;
- Dashboard TypeScript checking and production build;
- all native ESM runtime files through `node --check`;
- Skill package lint, Eval Manifest JSON parsing, and `git diff --check`;
- deterministic Dashboard packaging and committed-manifest comparison.

The installable Skill contains one native ESM runtime and no language bridge;
neither no-op nor deleted commands are represented as quality evidence.

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
create Dashboard blockers. Mixed repeat directions remain valid measurement
evidence, are attributed to candidate variability, and are rejected by the
same all-repeat objective gate. Projection and UI tests prove that a
repeat-level regression remains visible in the case flag and attention filter.

## Real Agent canary

The opt-in `dashboard/src/real-agent-trace.e2e.test.ts` was run for both
implemented adapters in one invocation:

```bash
SKILL_REVIEWER_REAL_AGENT_E2E=codex,claude \
  pnpm exec vitest run dashboard/src/real-agent-trace.e2e.test.ts
```

Result: 1 file passed, 2/2 tests passed, total duration 58.80 seconds.

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

## Real end-to-end Skill evolution

A separate, ignored Git repository exercised the installed Skill in Evolve mode
through Codex CLI YOLO execution. The proposal session
`019f7be4-bda6-76b1-99f5-44b8eb43f656` read the Skill and its four references,
changed only the candidate `meeting-note-helper/SKILL.md`, retained its static
review, and left the accepted baseline, Eval authority, execution profile, and
opaque holdout unchanged.

The first public selection run (`run-75172fb4c33312c723f7`) completed all 12
planned Agent cells with no framework failures, but retained output exposed a
measurement defect: two negative regular expressions crossed the next Markdown
section and a table assertion assumed label/value adjacency. The candidate
outputs respected the intended decision boundary. That run was quarantined as
invalid measurement rather than counted as a rejected candidate. The Oracle was
repaired with boundary-bearing passing examples, then frozen under a new
authority digest; the candidate was applied only after that freeze.

Under repaired authority `af814d8c4e38a2ca74b473d5a96248106defd04f6b5a61ad4f406379e7b11621`:

- selection run `run-1810897178677f8e861c` completed 12/12 cells with zero
  framework failures; both public objectives improved in every paired repeat
  (`+0.667 × 3` and `+0.6 × 3`);
- the one authorized opaque audit run `run-0d1987a5b4b399efbed1` completed 9/9
  cells across candidate, old-Skill, and no-Skill arms with zero framework
  failures;
- the audit candidate scored `1.0 × 3`, the old Skill scored `0.4 × 3`, and all
  paired deltas were `+0.6` against a predeclared `+0.3` material threshold;
- measurement was valid, the plan and lock verified, 6/6 release gates passed,
  no forbidden action or external side effect was observed, and evolution
  terminated at `audit-passed / request_user_release`.

The generated workspaces remain ignored because they contain local Agent state
and opaque evaluation material. Run IDs, digests, counts, and decision values
above are the retained review record; they do not widen the local holdout
issuer's trust boundary.

## Real Dashboard inspection

The current production build opened an existing real Codex canary projection
through the authenticated loopback server. Review and Runs were inspected at
1440×1000 and 390×844. The narrow layout had no horizontal overflow
(`scrollWidth = innerWidth = 390`) and the Review page was 1453 px tall. The
decision and next state appeared in the hero, followed by validity, three
evidence entry points, and one primary blocker. Runs ordered anomaly summary,
execution matrix, technical provenance, then the event timeline.

The check also caught and prevented an accidental schema-v3 break: legacy
`pareto` remains a wire compatibility token while the UI and algorithm call it
objective non-regression. The Dashboard exposes no task ledger; server tests
confirm write methods return 405 and the old action-ledger routes return 404.

The final opaque-audit projection was also opened through the authenticated
loopback server at 1440×1000 and 1024×768. Review, Runs, and Evidence archive
loaded with zero browser console errors or warnings. The page showed 6/6 gates,
9/9 retained Agent executions, the three-by-three arm/repeat matrix, hidden
holdout content, and the human release boundary. This inspection found a real
attention-ranking defect: an absolute five-second cap labeled all nine normal
17–42 second Codex executions as slow. A median/MAD fence raised the observed
threshold to 53.7 seconds and reduced false slow flags from 9 to 0; Vitest keeps
both the real-duration sample and a genuine 6-second outlier fixture.

## Claim boundary

The adapter canary proves execution and presentation plumbing. The separate
meeting-note demonstration additionally proves one locally issued, one-shot
opaque audit under its recorded authority; it does not authorize release,
generalize to arbitrary Skills, or turn three repeats into statistical
confidence. A future Agent version, source-format change, or authority change
must be revalidated before its claims are retained.
