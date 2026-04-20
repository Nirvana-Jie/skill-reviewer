# Skill Review Checklist

Walk this top-to-bottom. Tick each item. If an item cannot be assessed from the provided material, mark it `N/A — missing input` and list it at the end of the review.

## A. Intake

- [ ] SKILL.md is present and readable.
- [ ] YAML front matter parses.
- [ ] `name` is present, kebab-case, unique-looking.
- [ ] `description` is present and non-trivial.
- [ ] Body (markdown instructions) is present.
- [ ] Directory tree known (references / scripts / assets / evals).
- [ ] Eval set known or confirmed absent.

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

## K. Evals

- [ ] ≥ 10 eval prompts present or proposed.
- [ ] Coverage includes: explicit / implicit / negative / boundary / adjacent-not-trigger / complex-realistic.
- [ ] Each prompt has: prompt, should_trigger, expected_behavior, failure_modes_to_watch.
- [ ] Negative prompts are genuinely near-miss, not trivially unrelated.

## L. Maintainability

- [ ] SKILL.md ≤ ~500 lines or uses progressive disclosure.
- [ ] No dead files.
- [ ] File responsibilities are single and describable.
- [ ] Dependencies (if any) are minimal and named.

## M. Review emission

- [ ] Emitted all 11 sections of the output format.
- [ ] Each Critical Issue has: Problem, Why it matters, Suggested fix, Example rewrite.
- [ ] Suggested Description Rewrite is a paste-ready YAML value (or justified as "no change").
- [ ] Suggested Instruction Rewrite is paste-ready.
- [ ] Eval Prompt Set has ≥ 10 rows in the CSV columns.
- [ ] Final Recommendation is an ordered action list, not prose.
- [ ] Any unassessable items are explicitly listed.
