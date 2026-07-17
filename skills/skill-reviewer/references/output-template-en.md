# English Review Output Contract

Use this exact section order and English labels. A focused review keeps every
section and writes `N/A — focused review of <scope>` where a section is outside
scope.

```markdown
# Skill Review: <skill name>

## Executive Summary
<2–4 sentences: job-to-be-done, overall quality, top risks, release recommendation.>

## Verdict
<Ready | Ready with minor revisions | Needs revision | Not ready>

## Scorecard
- Trigger reliability: <1–5 and evidence>
- Description quality: <1–5 and evidence>
- Instruction clarity: <1–5 and evidence>
- Resource design: <1–5 and evidence>
- Script necessity: <1–5 and evidence>
- Safety and constraints: <1–5 and evidence>
- Output quality: <1–5 and evidence>
- Maintainability: <1–5 and evidence>

## Critical Issues
<Numbered findings. Each contains **Problem** / **Why it matters** / **Fix**. Write `None.` when empty.>

## Recommended Improvements
<Non-blocking, high-value items. Write `None.` when empty.>

## Trigger Analysis
- Will trigger when:
- May over-trigger on:
- May miss:
- Likely sibling-skill collisions:

## Resource Review
<Per-file verdict for SKILL.md / references/ / scripts/ / assets/ / evals/.>

## Verification Evidence
- Level: <write exactly one verification-level identifier defined by SKILL.md; use it once in the response and do not emit any alternative level identifier>
- Subject: <path and digest, or "not recorded">
- Static checks: <command/result/artifact or "not run">
- Runs: <cases/configurations or "none">
- Baseline: <old_skill / without_skill / unavailable / not requested>
- Evidence: <artifact paths and assertion summary, or why no run occurred>
- Limitations: <remaining uncertainty or "none">

## Suggested Rewrites
<Paste-ready YAML description and/or instruction blocks, or `No change recommended.`>

## Suggested Evals (optional)
<5–10 manifest-ready `skill-reviewer.evals` case objects with executable assertions and objectives, or one justified Not recommended / Deferred line.>

## Final Recommendation
<Ordered action list.>
```
