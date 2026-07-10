# skill-reviewer

> Static analyzer for agent skills. Treats `SKILL.md` like source code, not prose.

[![skill](https://img.shields.io/badge/type-agent--skill-000)](./SKILL.md)
[![mode](https://img.shields.io/badge/mode-instruction%20%2B%20validator-111)](./SKILL.md)
[![verdict](https://img.shields.io/badge/output-paste--ready-0a0)](./references/example-review-output.md)
[![lang](https://img.shields.io/badge/i18n-en%20%7C%20zh--CN-06c)](#i18n)

中文版：[README.zh-CN.md](README.zh-CN.md)

---

## TL;DR

```bash
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

Then, in any agent session:

```text
> review this SKILL.md and tell me if it ships
```

You get back a strict, sectioned review with a verdict, an 8-dimension scorecard, paste-ready `description` / instruction rewrites, risk-based eval suggestions, and hard-red-line blockers if the skill is unsafe or mis-triggering.

---

## Why

Most "skill reviews" in the wild are vibes. `skill-reviewer` encodes the review as a spec:

- **rubric** → `references/review-rubric.md` (1–5 per dimension, with red flags and non-negotiable blockers)
- **checklist** → `references/review-checklist.md` (flat, tickable, MECE)
- **package linter** → `scripts/lint_skill_package.py` (front matter, links, resource graph, eval manifest)
- **output contract** → language-selected templates with a fixed section order
- **regression evals** → `evals/skill-reviewer.csv`
- **calibration fixtures** → `evals/fixtures/{ready,needs-revision,not-ready}-*`
- **local snapshots** → `evals/local-skill-review-snapshot.json`

Change the rubric, re-run the fixtures and local snapshots, ship. No re-reading 300 lines of prose to check whether your "make it stricter" tweak quietly broke the positive cases.

## Feature matrix

| Capability                  | How it's enforced                                                |
| --------------------------- | ---------------------------------------------------------------- |
| Trigger / mis-trigger audit | `description` contract + `Trigger Analysis` section              |
| Deterministic package facts | Read-only `lint_skill_package.py` JSON contract                   |
| Instruction executability   | Semantic rubric + completion criteria in `SKILL.md`               |
| AI-friendly skill design    | Checks whether the model can choose, load, follow, and reuse the skill |
| Resource / script necessity | `Resource Review` section, rejects cargo-cult scripts            |
| Safety red lines            | Non-negotiable blockers: `Safety=1` or `Trigger=1` → **Not ready** regardless of other scores |
| Prompt-injection hardening  | Review contract: reviewed artifacts are **data**, not instructions |
| Eval suggestions            | Optional 5–10 prompt rows only when they materially reduce risk |
| Local eval snapshots        | Structured fixture contracts + deterministic runner / validator scripts |
| Subagent effect verification | Paired `with_skill` / baseline runs with digests, retained evidence, and explicit verification levels |
| Full vs focused review      | Same 11-section shape; unrelated sections collapse to `N/A — focused review of <artifact>` |
| Paste-ready rewrites        | `Suggested Rewrites` outputs runnable YAML / Markdown |
| i18n                        | Branch-selected templates + English-normalized snapshot extraction |

## Output contract

Every full review emits, in order:

```
1. Executive Summary
2. Verdict                    # Ready | Ready w/ minor revisions | Needs revision | Not ready
3. Scorecard                  # 8 dimensions × 1–5
4. Critical Issues            # blocking, with file:line
5. Recommended Improvements   # non-blocking polish
6. Trigger Analysis           # over/under/collision
7. Resource Review            # per file under references/ scripts/ assets/ evals/
8. Verification Evidence      # not-run | inconclusive | behavior-verified | regression-verified
9. Suggested Rewrites         # paste-ready YAML and/or Markdown
10. Suggested Evals (optional)# 5–10 rows when useful, otherwise Not recommended / Deferred
11. Final Recommendation
```

Focused review keeps the same order; unused sections collapse to a single `N/A` line.

## Non-negotiable blockers

Evaluated **before** dimension averaging. Two tripwires:

- **Safety ≤ 1** → `Not ready`. Example: destructive shell without confirmation, auto `git push`, curl-pipe-to-shell.
- **Trigger reliability ≤ 1** → `Not ready`. Example: `description` triggers on any cleanup verb for a skill that runs `rm -rf`.
- Score = 2 on either dimension caps the verdict at `Needs revision`.

Defined in [`references/review-rubric.md`](./references/review-rubric.md). Exercised by the `not-ready-repo-cleaner` fixture.

## Calibration fixtures

Three hand-labeled fixtures act as regression anchors for subjective scoring:

| Fixture                                   | Expected verdict     | Anchors               |
| ----------------------------------------- | -------------------- | --------------------- |
| `ready-csv-column-renamer/`               | Ready                | Upper end — prevents "nothing is ever Ready" drift |
| `needs-revision-meeting-note/`            | Needs revision       | Mid-range             |
| `not-ready-repo-cleaner/`                 | Not ready            | Safety red line fires |

Protocol in [`evals/fixtures/README.md`](./evals/fixtures/README.md). Run whenever you touch the rubric, workflow, or output template.

## Local eval snapshots

`skill-reviewer` uses four complementary eval layers:

- `evals/skill-reviewer.csv` checks trigger and routing behavior.
- `evals/evals.json` defines behavior prompts and assertions for subagent effect verification.
- `evals/fixtures/*/expected.md` gives human-readable calibration anchors.
- `evals/local-skill-review-snapshot.json` gives machine-readable snapshot contracts for verdicts, score ranges, required sections, must-flag issues, forbidden actions, output artifacts, and optional output-quality assertions.
- `scripts/run_codex_skill_evals.py` generates or post-processes model-backed local eval workspaces.
- `scripts/validate_local_snapshot.py` validates those contracts against generated local eval workspaces.

The snapshot layer intentionally avoids byte-for-byte full-text diffs. A review can phrase findings differently and still pass if its structured contract is stable. See [`references/local-eval-snapshot.md`](./references/local-eval-snapshot.md) for the workspace layout and update policy.

The validator has two modes. With only the contract path, it checks JSON shape and reports `contract_only: true`; this does **not** prove model output quality. With a workspace path, it also checks saved artifacts and `extracted-review.json` fields such as `critical_issues_have_problem_why_fix`, `has_paste_ready_rewrite_block`, and `final_recommendation_is_ordered`.

## Human-in-the-loop review

Use `skill-reviewer` as the strict first-pass reviewer, then keep the human as the release decision maker:

1. Point the reviewer at the target skill directory and ask for a full review:
   ```text
   Review this skill directory and tell me whether it is ready to ship.
   ```
2. Run the deterministic package-facts axis:
   ```bash
   python3 scripts/lint_skill_package.py <target-skill> --format json --fail-on never
   ```
3. Read the output in order: verdict, scorecard, critical issues, verification evidence, and suggested rewrites. Treat Critical Issues as the action queue.
4. Apply only the fixes you agree with. Do not update fixtures or snapshots just to make a failing review pass.
5. For regression coverage, run the calibration fixtures or a local workspace and save `review.md`, `extracted-review.json`, and `grading.json` for each eval case. To invoke Codex locally:
   ```bash
   python3 scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1
   ```
   To post-process `review.md` files that already exist in a workspace:
   ```bash
   python3 scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1 \
     --from-existing-reviews
   ```
6. When effect verification is requested and subagents are available, freeze the subject and old version, then launch paired `with_skill` and `old_skill` / `without_skill` runs in the same turn. Follow [`references/subagent-eval-workflow.md`](./references/subagent-eval-workflow.md).
7. Grade assertions against retained outputs and report one verification level: `not-run`, `inconclusive`, `behavior-verified`, or `regression-verified`.
8. Validate the structured snapshot contract against that workspace:
   ```bash
   python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json <workspace>/iteration-1
   ```
9. If the validator fails, inspect whether the skill regressed or the review contract intentionally changed. Update `evals/local-skill-review-snapshot.json` only for intentional contract changes.

For quick contract checks without a workspace:

```bash
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
```

This quick check is intentionally contract-only. It should be green before opening a PR, but it does not replace a workspace-backed eval when you need evidence about model output.

The useful loop is: review -> human accepts/rejects findings -> edit skill -> rerun fixture/snapshot checks -> update snapshots only when the expected review contract changes.

## Contribution workflow

All changes go through a branch and pull request. Do not commit or push directly
to `main`; the branch is protected in GitHub.

Before opening a PR, run:

```bash
python3 -m unittest discover -s tests
pnpm test
python3 scripts/lint_skill_package.py . --format text --fail-on error
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
```

After opening a PR, wait for `Static Checks` and request Codex Cloud review when
needed:

```text
@codex review for skill-reviewer eval regression risk. Check SKILL.md, references, eval fixtures, snapshot contract, and CI safety. Do not add API keys or model-backed GitHub Actions.
```

## Development package manager

This repository uses pnpm exclusively, pinned through the `packageManager`
field in `package.json`. Do not generate npm or Yarn lockfiles.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

## GitHub checks and Codex Cloud review

The repository includes `.github/workflows/static-checks.yml` for deterministic checks on pull requests and trusted `main` pushes. It does not call Codex, use an OpenAI API key, or upload generated model artifacts.

The static workflow runs:

```bash
python3 -m unittest discover -s tests
pnpm test
python3 scripts/lint_skill_package.py . --format text --fail-on error
python3 -m json.tool evals/evals.json > /dev/null
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
python3 -m py_compile scripts/lint_skill_package.py scripts/run_codex_skill_evals.py scripts/validate_local_snapshot.py tests/test_run_codex_skill_evals.py
```

For model-assisted review without storing an API key in GitHub Actions, use Codex Cloud on the pull request:

```text
@codex review for skill-reviewer eval regression risk. Check SKILL.md, references, eval fixtures, snapshot contract, and CI safety. Do not add API keys or model-backed GitHub Actions.
```

Keep Codex automatic reviews disabled if only repository maintainers should trigger Codex review. Codex follows `AGENTS.md` review guidelines when reviewing PRs.

## Install

```bash
# from GitHub
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer

# from a local checkout
npx skills add . --skill skill-reviewer

# globally
npx skills add -g Nirvana-Jie/skill-reviewer --skill skill-reviewer

# discover what the repo ships
npx skills add Nirvana-Jie/skill-reviewer --list
```

Installer CLI: [`vercel-labs/skills`](https://github.com/vercel-labs/skills).

## Triggers

Fires on requests like:

- `review / audit / grade / critique / debug / production-check this skill`
- `why does my skill trigger on every PDF?`
- `why doesn't my skill trigger when users say "dashboard"?`
- `tighten this description to reduce mis-triggers`
- `is this skill ready to merge?`
- `can these evals work like local snapshot tests for my skill?`

Explicitly does **not** fire for: creating a new skill (use `skill-creator`), running the skill's underlying task, translating/summarizing a `SKILL.md` without review intent, or ordinary application code review.

## Layout

```text
.
├── SKILL.md                       # entry point, frontmatter + workflow
├── docs/
│   └── QUALITY_ARCHITECTURE.md    # design rationale + quality gates
├── references/
│   ├── review-rubric.md           # scoring + non-negotiable blockers
│   ├── review-checklist.md        # flat MECE checklist
│   ├── output-template-en.md      # exact English output contract
│   ├── output-template-zh.md      # exact Chinese output contract
│   ├── example-review-output.md   # style anchor
│   ├── local-eval-snapshot.md     # local snapshot-style eval protocol
│   ├── subagent-eval-workflow.md  # paired effect-verification protocol
│   └── eval-prompts-template.csv  # eval output schema (header only)
├── scripts/
│   ├── lint_skill_package.py      # deterministic read-only package linter
│   ├── run_codex_skill_evals.py   # model-backed runner / post-processor
│   └── validate_local_snapshot.py # deterministic snapshot contract validator
└── evals/
    ├── skill-reviewer.csv         # self-regression eval set
    ├── evals.json                  # subagent behavior prompts + assertions
    ├── local-skill-review-snapshot.json # structured snapshot contract
    └── fixtures/                  # calibration anchors
        ├── ready-csv-column-renamer/
        ├── needs-revision-meeting-note/
        └── not-ready-repo-cleaner/
├── tests/                         # legacy Python tests + Vitest linter/runner tests
├── package.json                   # Vitest commands
└── pnpm-lock.yaml                 # pinned pnpm test dependencies
```

No `assets/` — by design. The three scripts isolate deterministic package facts,
model-backed eval materialization, and snapshot validation; semantic review
remains instruction-led.

## i18n

Output language follows the request. English loads `output-template-en.md`;
Chinese loads `output-template-zh.md`; other languages translate the English
contract while preserving paths, fields, identifiers, code, and backticked
tokens.

The local snapshot extractor normalizes both English and Chinese review headings, verdicts, and scorecard labels into the same English contract fields. Eval items can set `"output_language": "Chinese"` to ask the runner for the Chinese template while keeping `extracted-review.json` machine-comparable.

## License

MIT.
