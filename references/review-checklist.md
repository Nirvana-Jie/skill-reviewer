# Skill Review Checklist

Walk this top-to-bottom. Tick each item. If an item cannot be assessed from the provided material, mark it `N/A — missing input` and list it at the end of the review.

## Table of Contents

- [A. Intake](#a-intake)
- [B. Job-to-be-done](#b-job-to-be-done)
- [C. Name](#c-name)
- [D. Description](#d-description)
- [E. Instructions](#e-instructions)
- [F. References](#f-references)
- [G. Scripts](#g-scripts)
- [H. Assets](#h-assets)
- [I. Safety](#i-safety)
- [J. Output quality](#j-output-quality)
- [K. Evals (optional)](#k-evals-optional)
- [L. Maintainability](#l-maintainability)
- [M. Review emission](#m-review-emission)

## A. Intake

- [ ] SKILL.md is present and readable (or marked `N/A — focused review` / `N/A — not provided` if the request is intentionally scoped to one artifact).
- [ ] YAML front matter parses.
- [ ] `name` is present, kebab-case, unique-looking.
- [ ] `description` is present and non-trivial.
- [ ] Body (markdown instructions) is present.
- [ ] Directory tree known (references / scripts / assets / evals).
- [ ] Eval set noted if present; absence is not a defect.

## B. Job-to-be-done

- [ ] I can write one sentence: "This skill exists to do X when Y, returning Z."
- [ ] The skill is the right packaging (not better as a prompt, tool, CLI, or MCP).
- [ ] Instruction-only vs. needs-resources classification is clear.

## C. Name

- [ ] Short (≤ 3 words preferred).
- [ ] Kebab-case.
- [ ] Semantically precise (names the job, not the implementation).
- [ ] Unlikely to collide with common skills.
- [ ] Not a generic verb ("helper", "assistant", "tool").

## D. Description

- [ ] Names the target task in one clause.
- [ ] Lists positive trigger conditions.
- [ ] Lists negative / exclusion conditions.
- [ ] Includes representative user utterances or intents.
- [ ] Does not require user to literally say the skill name.
- [ ] Mentions how it differs from obvious sibling skills.
- [ ] Length is reasonable (specific but not a wall of text).

## E. Instructions

- [ ] Steps are ordered and executable.
- [ ] Each step has a clear action verb.
- [ ] Boundaries declared: stop conditions, ask-user conditions, best-effort conditions.
- [ ] Output format defined (schema / template / file layout).
- [ ] Failure handling for missing/invalid input.
- [ ] No internal contradictions.
- [ ] Explains *why* key rules exist.
- [ ] Not a wall of uppercase MUST/NEVER.
- [ ] Does not expect the LLM to "figure it out" at critical forks.

## F. References

- [ ] Each reference file is pointed to from SKILL.md with a "read when" cue.
- [ ] No duplication of SKILL.md content.
- [ ] No tiny files that should be inlined.
- [ ] Large reference files have a table of contents.
- [ ] Naming is descriptive.

## G. Scripts

- [ ] Every script has a clear justification (repetitive / deterministic / error-prone / faster as code).
- [ ] No script wraps trivial logic the LLM can do inline.
- [ ] Each script is invoked from SKILL.md with example usage.
- [ ] Script inputs/outputs are documented.
- [ ] Failure modes of scripts are documented.

## H. Assets

- [ ] Each asset has a clear consumer role (template / fixture / icon / font).
- [ ] Naming conveys purpose.
- [ ] Not dumping user-specific content as an asset.

## I. Safety

- [ ] Sensitive data handling addressed if relevant.
- [ ] External command scope defined (allow-list or confirm-list).
- [ ] Destructive actions gated (confirmation or refusal).
- [ ] Network / credentials / PII constraints declared.
- [ ] Prompt-injection posture addressed for user-supplied content.

## J. Output quality

- [ ] Output format is stable and named.
- [ ] At least one example of the output is provided.
- [ ] Output separates narration from data.

## K. Evals (optional)

Evals are not scored and their absence is never a blocker. Only propose them when they would materially reduce risk for this skill.

- [ ] Decided whether evals are worth recommending for this skill (or deferring).
- [ ] If recommended: 5–10 prompts covering explicit / implicit / negative / boundary / adjacent-not-trigger.
- [ ] If recommended: each prompt has prompt, should_trigger, expected_behavior, failure_modes_to_watch.
- [ ] If recommended: negative prompts are genuinely near-miss, not trivially unrelated.
- [ ] If deferring: reason stated in one line (e.g. rapid iteration, unambiguous trigger surface).

## L. Maintainability

- [ ] SKILL.md ≤ ~500 lines or uses progressive disclosure.
- [ ] No dead files.
- [ ] File responsibilities are single and describable.
- [ ] Dependencies (if any) are minimal and named.

## M. Review emission

- [ ] Emitted every section of the output format (Executive Summary, Verdict, Scorecard, Critical Issues, Recommended Improvements, Trigger Analysis, Resource Review, Suggested Rewrites, Suggested Evals, Final Recommendation). Empty sections explicitly marked (e.g. "None" or "N/A — focused review of <artifact>").
- [ ] Scorecard has 8 dimensions, each with a one-line justification.
- [ ] Each Critical Issue has: Problem, Why it matters, Fix (copy-pasteable).
- [ ] Suggested Rewrites block is paste-ready (YAML `description:` value and/or instruction blocks), or explicitly marked "No change recommended".
- [ ] Suggested Evals: either 5–10 targeted rows with the CSV column schema, or a one-line `Not recommended — <reason>` / `Deferred — <reason>`.
- [ ] Final Recommendation is an ordered action list, not prose.
- [ ] Any unassessable items are explicitly listed.
