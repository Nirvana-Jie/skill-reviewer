# skill-reviewer

`skill-reviewer` is an agent skill for reviewing other agent skills. It audits trigger quality, instruction clarity, resource design, safety, eval coverage, and maintainability, then returns concrete, copy-pasteable fixes instead of generic advice.

简体中文说明见 [README.zh-CN.md](README.zh-CN.md).

## What This Skill Does

This skill helps an agent review an existing skill package such as a Codex Skill, Claude Skill, ChatGPT Skill, or other agent skill built around a `SKILL.md` file.

When activated, it is designed to:

- review the skill's `name`, `description`, and instruction quality
- identify over-triggering and under-triggering problems
- inspect supporting resources such as `references/`, `scripts/`, and `assets/`
- evaluate safety constraints and operational robustness
- assess eval coverage and propose missing eval prompts
- produce a structured review with rewrites the author can paste back into the skill

## When To Use It

This skill is a good fit when you want an agent to help with requests like:

- "Review this `SKILL.md` and tell me if it's ready to merge."
- "Why is my skill triggering too often?"
- "Why doesn't my skill trigger when users ask for dashboards?"
- "Can you audit this skill directory and suggest fixes?"
- "Is this skill production-ready?"
- "Help me tighten the description field."

## When Not To Use It

This skill is not meant for:

- creating a brand-new skill from scratch
- executing the skill's underlying business task instead of reviewing the skill itself
- generic prompt rewriting unrelated to skill packaging
- traditional software code review for an app or library

## Installation

This repository is structured as a single-skill package at the repository root and can be installed with the [`vercel-labs/skills`](https://github.com/vercel-labs/skills) CLI.

GitHub repository: [Nirvana-Jie/skill-reviewer](https://github.com/Nirvana-Jie/skill-reviewer)

Install from GitHub:

```bash
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

List available skills in the repository before installing:

```bash
npx skills add Nirvana-Jie/skill-reviewer --list
```

Install from a local checkout:

```bash
npx skills add . --skill skill-reviewer
```

Install globally instead of per-project:

```bash
npx skills add -g Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

## How To Use It

Once installed, use normal requests that describe a skill-review task. The agent should activate `skill-reviewer` when the request matches its trigger description.

Example prompts:

- "Please review this `SKILL.md` and tell me whether it's ready to install."
- "My skill fires on every PDF request. Help me debug the trigger."
- "Audit this skill directory and tell me which files are unnecessary."
- "Can you grade this skill on trigger reliability and eval coverage?"
- "I think this skill is over-scoped. Review it and suggest a rewrite."

## Expected Output

The skill is designed to return a structured review with sections such as:

- Executive Summary
- Verdict
- Scorecard
- Critical Issues
- Recommended Improvements
- Trigger Analysis
- Resource Review
- Suggested Description Rewrite
- Suggested Instruction Rewrite
- Eval Prompt Set
- Final Recommendation

The goal is to give the skill author a review they can act on immediately, not just high-level commentary.

## Repository Layout

```text
SKILL.md
references/
  eval-prompts-template.csv
  example-review-output.md
  review-checklist.md
  review-rubric.md
README.md
README.zh-CN.md
```

## Included References

This skill ships with a small reference set to keep `SKILL.md` focused:

- `review-rubric.md`: scoring guidance and verdict thresholds
- `review-checklist.md`: a flat review checklist to reduce missed defects
- `example-review-output.md`: a concrete example of the expected review style
- `eval-prompts-template.csv`: the output schema for proposing eval prompts
