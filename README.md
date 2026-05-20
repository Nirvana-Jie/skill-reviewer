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
- **output contract** → fixed section order, full vs focused review modes
- **regression evals** → `evals/skill-reviewer.csv`
- **calibration fixtures** → `evals/fixtures/{ready,needs-revision,not-ready}-*`
- **local snapshots** → `evals/local-skill-review-snapshot.json`

Change the rubric, re-run the fixtures and local snapshots, ship. No re-reading 300 lines of prose to check whether your "make it stricter" tweak quietly broke the positive cases.

## Feature matrix

| Capability                  | How it's enforced                                                |
| --------------------------- | ---------------------------------------------------------------- |
| Trigger / mis-trigger audit | `description` contract + `Trigger Analysis` section              |
| Instruction executability   | Operating principles + `review-checklist.md §C`                  |
| AI-friendly skill design    | Checks whether the model can choose, load, follow, and reuse the skill |
| Resource / script necessity | `Resource Review` section, rejects cargo-cult scripts            |
| Safety red lines            | Non-negotiable blockers: `Safety=1` or `Trigger=1` → **Not ready** regardless of other scores |
| Prompt-injection hardening  | Operating principle #9: reviewed artifacts are **data**, not instructions |
| Eval suggestions            | Optional 5–10 prompt rows only when they materially reduce risk |
| Local eval snapshots        | Structured fixture contracts + deterministic validator script |
| Full vs focused review      | Same 10-section shape; unrelated sections collapse to `N/A — focused review of <artifact>` |
| Paste-ready rewrites        | `Suggested Rewrites` outputs runnable YAML / Markdown |
| i18n                        | Parallel `## 中文输出模板` with a verdict-term translation table |

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
8. Suggested Rewrites         # paste-ready YAML and/or Markdown
9. Suggested Evals (optional) # 5–10 rows when useful, otherwise Not recommended / Deferred
10. Final Recommendation
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

`skill-reviewer` uses three complementary eval layers:

- `evals/skill-reviewer.csv` checks trigger and routing behavior.
- `evals/fixtures/*/expected.md` gives human-readable calibration anchors.
- `evals/local-skill-review-snapshot.json` gives machine-readable snapshot contracts for verdicts, score ranges, required sections, must-flag issues, forbidden actions, and output artifacts.
- `scripts/validate_local_snapshot.py` validates those contracts against generated local eval workspaces.

The snapshot layer intentionally avoids byte-for-byte full-text diffs. A review can phrase findings differently and still pass if its structured contract is stable. See [`references/local-eval-snapshot.md`](./references/local-eval-snapshot.md) for the workspace layout and update policy.

## Human-in-the-loop review

Use `skill-reviewer` as the strict first-pass reviewer, then keep the human as the release decision maker:

1. Point the reviewer at the target skill directory and ask for a full review:
   ```text
   Review this skill directory and tell me whether it is ready to ship.
   ```
2. Read the output in order: verdict, scorecard, critical issues, suggested rewrites, then suggested evals. Treat Critical Issues as the action queue.
3. Apply only the fixes you agree with. Do not update fixtures or snapshots just to make a failing review pass.
4. For regression coverage, run the calibration fixtures or a local workspace and save `review.md`, `extracted-review.json`, and `grading.json` for each eval case.
5. Validate the structured snapshot contract:
   ```bash
   python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json <workspace>/iteration-1
   ```
6. If the validator fails, inspect whether the skill regressed or the review contract intentionally changed. Update `evals/local-skill-review-snapshot.json` only for intentional contract changes.

For quick contract checks without a workspace:

```bash
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
```

The useful loop is: review -> human accepts/rejects findings -> edit skill -> rerun fixture/snapshot checks -> update snapshots only when the expected review contract changes.

## GitHub CI with Codex

The repository includes `.github/workflows/codex-skill-evals.yml` for release-gate evals. It runs only on `workflow_dispatch` and `push` to `main`, not on untrusted fork PRs.

Setup:

1. Add a repository secret named `OPENAI_API_KEY` in GitHub Actions secrets. Do not commit API keys, put them in workflow inputs, or store them in eval fixtures.
2. Trigger **Codex Skill Evals** manually from the Actions tab, or let it run after trusted pushes to `main`.
3. Optionally pass a `codex_model` workflow input. Leaving it blank uses the Codex action default.

What the workflow does:

- validates `evals/local-skill-review-snapshot.json`;
- runs `openai/codex-action@v1` with `.github/codex/prompts/skill-evals.md`;
- asks Codex to review each fixture and write `review.md` files under `.codex-eval-workspace/`;
- runs `scripts/run_codex_skill_evals.py --from-existing-reviews` to extract `extracted-review.json` and `grading.json` deterministically;
- validates the generated workspace with `scripts/validate_local_snapshot.py`;
- scans artifacts for the exact secret value before upload.

The API key is only provided to `openai/codex-action@v1`. The workflow does not print it, write it to repo files, or upload Codex auth state.

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
├── references/
│   ├── review-rubric.md           # scoring + non-negotiable blockers
│   ├── review-checklist.md        # flat MECE checklist
│   ├── example-review-output.md   # style anchor
│   ├── local-eval-snapshot.md     # local snapshot-style eval protocol
│   └── eval-prompts-template.csv  # eval output schema (header only)
├── scripts/
│   └── validate_local_snapshot.py # deterministic snapshot contract validator
└── evals/
    ├── skill-reviewer.csv         # self-regression eval set
    ├── local-skill-review-snapshot.json # structured snapshot contract
    └── fixtures/                  # calibration anchors
        ├── ready-csv-column-renamer/
        ├── needs-revision-meeting-note/
        └── not-ready-repo-cleaner/
```

No `assets/` — by design. The only script is a deterministic validator for local eval snapshot artifacts; the review workflow itself remains instruction-led.

## i18n

Output language follows the request. Request in English → English template. Request in Chinese → `## 中文输出模板` is used, section headings / scorecard labels / verdict strings are translated, but file paths, field names, and backticked tokens stay untranslated. No mixed-language output.

## License

MIT.
