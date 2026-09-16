# Self-eval runbook

Maintainer procedure for running `skills/skill-reviewer/evals/evals.json`
against the skill-reviewer package itself and recording the result in the
[validation ledger](./validation.md). It is deliberately outside the installable
Skill so it never enters an Agent's decision context.

Static tests already compile every split and push realistic responses through
every `must_pass` predicate (`pnpm test`). Nothing in this runbook is optional
for an effect claim: a compile, a lint, or a green Vitest run is not behavior
evidence.

## 0. Prerequisites

- Node.js `^20.19.0 || >=22.12.0`, `pnpm install --frozen-lockfile`.
- One registered Agent CLI installed and authenticated on this machine. Check
  the compatible range and the canary-verified version:

```bash
node skills/skill-reviewer/scripts/run_agent_eval.mjs adapters list
claude --version   # or: codex --version
```

  A version outside the range fails closed before dispatch. A version inside the
  range but different from the canary-verified one runs, and the difference is
  retained as a limitation in `verification-evidence.json`.
- Budget. Cell counts come from the manifest (`arms × repeats` per case). Read
  them from the compiled plan before dispatching; do not guess. Set
  `--cost-limit-usd` per cell.
- Fresh directories outside the repository, for example
  `/tmp/skill-reviewer-self-eval/$(date +%F)/`. Compiled workspaces bind
  absolute paths; never move or copy one, recompile instead.

## 1. Execution profile

```bash
run=/tmp/skill-reviewer-self-eval/$(date +%F) && mkdir -p "$run" && cd "$run"
cat > profile.json <<'JSON'
{"adapter_id":"anthropic.claude-code.stream-json",
 "isolation":"local-unattested",
 "sampling":{"mode":"claude-default","paired":true}}
JSON
```

Use `openai.codex-cli.exec-jsonl` for Codex. The profile is retained verbatim
in the plan and its digest binds every cell.

## 2. Development split (diagnosis, `without_skill` baseline)

```bash
repo=/Users/you/skill-reviewer
skill=$repo/skills/skill-reviewer
node $skill/scripts/skill_eval_runtime.mjs compile \
  --manifest $skill/evals/evals.json --subject $skill \
  --execution-profile profile.json --baseline-kind without_skill \
  --split development --workspace ./dev
node -e 'const p=require("./dev/execution-plan.json");console.log(p.run_id,p.cases.map(c=>c.id+":"+c.arms.length*c.repeats).join(" "))'
node $skill/scripts/run_agent_eval.mjs plan --workspace ./dev \
  --adapter anthropic.claude-code.stream-json --cost-limit-usd 1
node $skill/scripts/skill_eval_runtime.mjs grade \
  --plan ./dev/execution-plan.json --workspace ./dev > dev-grade.json
```

`decide` does not apply to development; read `dev/verification-evidence.json`
for per-case pass rates and limitations.

## 3. Selection split (`old_skill` baseline = last accepted package)

The accepted baseline is the skill package at the last tag whose ledger entry
records a `selection` decision status of `accepted` for this package. As of
the newest ledger entry no tag is accepted, so use the copy-of-current-package
path described after the commands. Materialize a tagged baseline outside the
run workspace without touching `.git`:

```bash
mkdir -p /tmp/skill-reviewer-self-eval/baseline
git -C $repo archive <accepted-tag> skills/skill-reviewer | tar -x -C /tmp/skill-reviewer-self-eval/baseline
node $skill/scripts/skill_eval_runtime.mjs compile \
  --manifest $skill/evals/evals.json --subject $skill \
  --execution-profile profile.json --baseline-kind old_skill \
  --baseline-path /tmp/skill-reviewer-self-eval/baseline/skills/skill-reviewer \
  --split selection --workspace ./sel
node $skill/scripts/run_agent_eval.mjs plan --workspace ./sel \
  --adapter anthropic.claude-code.stream-json --cost-limit-usd 1
node $skill/scripts/run_semantic_judge.mjs --workspace ./sel \
  --adapter anthropic.claude-code.stream-json --cost-limit-usd 1 > sel-judge.json || true
# exit 0 = every semantic assertion judged; 1 = some skipped or malformed
# (see results[].reason in sel-judge.json; semantic evidence is advisory);
# 2 = refused before any judgment. Re-run `grade` after judging.
node $skill/scripts/skill_eval_runtime.mjs grade \
  --plan ./sel/execution-plan.json --workspace ./sel > sel-grade.json
node $skill/scripts/skill_eval_runtime.mjs decide \
  --plan ./sel/execution-plan.json --evidence ./sel/verification-evidence.json \
  --workspace ./sel --iteration 1 --phase selection > sel-decide.json
```

For the very first run there is no accepted baseline: compile selection against
a copy of the current package. Every paired delta is then zero by construction;
the run establishes absolute pass rates only and the ledger entry must say so.

## 4. Audit split

The shipped audit fixtures are public, so the audit run grades as
`public-calibration` and can never be release-eligible. Run it the same way with
`--split audit`; for a release decision compile with `--holdout-pack` pointing at
an opaque pack kept outside the repository (format in
`references/verification-workflow.md`).

## 5. Inspect

```bash
node $skill/scripts/skill_eval_runtime.mjs project-dashboard \
  --workspace ./sel --output ./sel/dashboard-data.json
node $skill/scripts/start_skill_dashboard.mjs --workspace ./sel \
  --user-approved-dashboard --open
```

## 6. Record the ledger entry

Append one entry to `docs/validation.md` under `## Ledger`, newest first:

- package version and commit; date and timezone;
- adapter id, CLI version observed, canary-verified version, model as reported
  in the retained trace;
- per split: run id, cell count, per-case `with_skill` and baseline
  `required_pass_rate`, paired deltas, and the `decide` status
  (`accepted` / `no-change` / `rejected` / `inconclusive` / `invalid`);
- every limitation string from `verification-evidence.json`;
- what was NOT run.

Never commit the run workspaces (they contain Agent state and, for audits,
holdout material). Digests, run ids, counts, and decisions are the retained
record.
