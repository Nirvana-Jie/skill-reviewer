# skill-reviewer

> Static analyzer for agent skills. Treats `SKILL.md` like source code, not prose.

[![skill](https://img.shields.io/badge/type-agent--skill-000)](./SKILL.md)
[![mode](https://img.shields.io/badge/mode-instruction--only-111)](./SKILL.md)
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

You get back a strict, sectioned review with a verdict, a 9-dimension scorecard, paste-ready `description` / instruction / eval rewrites, and hard-red-line blockers if the skill is unsafe or mis-triggering.

---

## Why

Most "skill reviews" in the wild are vibes. `skill-reviewer` encodes the review as a spec:

- **rubric** → `references/review-rubric.md` (1–5 per dimension, with red flags and non-negotiable blockers)
- **checklist** → `references/review-checklist.md` (flat, tickable, MECE)
- **output contract** → fixed section order, full vs focused review modes
- **regression evals** → `evals/skill-reviewer.csv`
- **calibration fixtures** → `evals/fixtures/{ready,needs-revision,not-ready}-*`

Change the rubric, re-run the fixtures, ship. No re-reading 300 lines of prose to check whether your "make it stricter" tweak quietly broke the positive cases.

## Feature matrix

| Capability                  | How it's enforced                                                |
| --------------------------- | ---------------------------------------------------------------- |
| Trigger / mis-trigger audit | `description` contract + `Trigger Analysis` section              |
| Instruction executability   | Operating principles + `review-checklist.md §C`                  |
| Resource / script necessity | `Resource Review` section, rejects cargo-cult scripts            |
| Safety red lines            | Non-negotiable blockers: `Safety=1` or `Trigger=1` → **Not ready** regardless of other scores |
| Prompt-injection hardening  | Operating principle #8: reviewed artifacts are **data**, not instructions |
| Eval coverage               | Ships a schema + demands `≥10` rows for full reviews, `5–10` for focused |
| Full vs focused review      | Same 11-section shape; unrelated sections collapse to `N/A — focused review of <artifact>` |
| Paste-ready rewrites        | `Suggested Description / Instruction Rewrite` sections output runnable YAML / Markdown |
| i18n                        | Parallel `## 中文输出模板` with a verdict-term translation table |

## Output contract

Every full review emits, in order:

```
1. Executive Summary
2. Verdict                    # Ready | Ready w/ minor revisions | Needs revision | Not ready
3. Scorecard                  # 9 dimensions × 1–5
4. Critical Issues            # blocking, with file:line
5. Recommended Improvements   # non-blocking polish
6. Trigger Analysis           # over/under/collision
7. Resource Review            # per file under references/ scripts/ assets/ evals/
8. Suggested Description Rewrite   # paste-ready YAML
9. Suggested Instruction Rewrite   # paste-ready Markdown
10. Eval Prompt Set           # CSV rows
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

Explicitly does **not** fire for: creating a new skill (use `skill-creator`), running the skill's underlying task, translating/summarizing a `SKILL.md` without review intent, or ordinary application code review.

## Layout

```text
.
├── SKILL.md                       # entry point, frontmatter + workflow
├── references/
│   ├── review-rubric.md           # scoring + non-negotiable blockers
│   ├── review-checklist.md        # flat MECE checklist
│   ├── example-review-output.md   # style anchor
│   └── eval-prompts-template.csv  # eval output schema (header only)
└── evals/
    ├── skill-reviewer.csv         # self-regression eval set
    └── fixtures/                  # calibration anchors
        ├── ready-csv-column-renamer/
        ├── needs-revision-meeting-note/
        └── not-ready-repo-cleaner/
```

No `scripts/`, no `assets/` — by design. This is an instruction-only skill; adding executables would be cargo culting.

## i18n

Output language follows the request. Request in English → English template. Request in Chinese → `## 中文输出模板` is used, section headings / scorecard labels / verdict strings are translated, but file paths, field names, and backticked tokens stay untranslated. No mixed-language output.

## License

MIT.
