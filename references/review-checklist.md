# Skill Review Checklist

Walk this top-to-bottom. Tick each item. If an item cannot be assessed from the provided material, mark it `N/A — missing input` and list it at the end of the review.

This file is a coverage aid, not a second rubric. Normative score thresholds,
blockers, and verdict rules live only in `review-rubric.md`; if the two files
drift, follow the rubric and flag the checklist mismatch.

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
- [ ] If runtime quality claims are in scope, whether the skill needs evals is explicit.
- [ ] The skill improves a recurring agent behavior, not just human-facing documentation.
- [ ] Any dependency contract is explicit and stable (what another skill, evaluator, or downstream agent can rely on).

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
- [ ] Instructions are AI-friendly: at important forks, the agent knows whether to inspect, ask, act, or stop.
- [ ] For evaluator skills, rubric/checklist/template/fixtures agree on score dimensions, verdict rules, and output sections.
- [ ] Explains *why* key rules exist.
- [ ] Not a wall of uppercase MUST/NEVER.
- [ ] Does not expect the LLM to "figure it out" at critical forks.

## F. References

- [ ] Each reference file is pointed to from SKILL.md with a "read when" cue.
- [ ] No duplication of SKILL.md content.
- [ ] No tiny files that should be inlined.
- [ ] Large reference files have a table of contents.
- [ ] Naming is descriptive.
- [ ] Calibration or example resources do not contradict the output contract in `SKILL.md`.

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
- [ ] Output can be consumed by the user or a downstream agent without reinterpreting ambiguous prose.

## K. Evals (optional)

Evals are not scored and their absence is never a blocker. Only propose them when they would materially reduce risk for this skill.

- [ ] Decided whether evals are worth recommending for this skill (or deferring).
- [ ] If recommended: 5–10 prompts covering explicit / implicit / negative / boundary / adjacent-not-trigger.
- [ ] If recommended: each prompt has prompt, should_trigger, expected_behavior, failure_modes_to_watch.
- [ ] If recommended: negative prompts are genuinely near-miss, not trivially unrelated.
- [ ] If deferring: reason stated in one line (e.g. rapid iteration, unambiguous trigger surface).
- [ ] If reviewing local skill evals: trigger/router evals, behavior assertions, calibration fixtures, and artifact snapshots are separated.
- [ ] If reviewing snapshot-style evals: snapshots compare structured fields, not full prose by default.
- [ ] If reviewing snapshot-style evals: baseline (`old_skill` / `without_skill`), run artifacts, forbidden actions, and snapshot update policy are explicit.
- [ ] If runtime effect verification is requested: the reviewed subject and baseline are frozen and identified by digest.
- [ ] If runtime effect verification is requested: paired `with_skill` and baseline subagents start in the same turn.
- [ ] If runtime effect verification is requested: workers are read-only, bounded, and cannot edit the target, update snapshots, or own the final verdict.
- [ ] If runtime effect verification is requested: assertions are graded against retained outputs; exit code alone is not a pass.
- [ ] If `evals/evals.json` is present: it uses the strict `skill-reviewer.evals` contract; invalid manifests block worker launch and release rather than being skipped.
- [ ] If behavior evals execute: `execution-plan.json` and `run-lock.json` freeze plan, subject, baseline, external execution-profile digest, holdout identity, and selected fixtures before dispatch.
- [ ] If behavior evals execute: deterministic cases run once and stochastic cases run three paired repeats; opposite paired directions are `inconclusive`.
- [ ] If semantic grading is declared: deterministic assertions run first; A/B outputs are blind and order-swapped; disagreement stays `inconclusive`.
- [ ] If evolution is requested: development / selection / audit roles are separated, selection uses hard gates + Pareto improvement, and audit runs once without feedback to the optimizer.
- [ ] If evolution is requested: authoritative selection/audit evals, fixtures, snapshots, graders, and accepted baseline stay immutable; a development surrogate has a separate digest; proposed authoritative eval changes wait for user confirmation and a new run.
- [ ] If evolution is requested: every later selection and the only audit are explicitly authorized; candidate lineage, rejected candidates, query counts, and continuity resets are retained.
- [ ] If audit is used for release: its holdout is opaque and resolved outside candidate/baseline/run roots; public audit remains calibration-only.
- [ ] If a Dashboard is produced: it consumes contract-bound retained evidence and is read-only; it does not become an executor or approval authority.
- [ ] Verification level is exactly one of `not-run`, `inconclusive`, `behavior-verified`, or `regression-verified`.

## L. Maintainability

- [ ] SKILL.md ≤ ~500 lines or uses progressive disclosure.
- [ ] No dead files.
- [ ] File responsibilities are single and describable.
- [ ] Dependencies (if any) are minimal and named.

## M. Review emission

- [ ] Emitted every section of the output format (Executive Summary, Verdict, Scorecard, Critical Issues, Recommended Improvements, Trigger Analysis, Resource Review, Verification Evidence, Suggested Rewrites, Suggested Evals, Final Recommendation). Empty sections explicitly marked (e.g. "None" or "N/A — focused review of <artifact>").
- [ ] Scorecard has 8 dimensions, each with a one-line justification.
- [ ] Each Critical Issue has: Problem, Why it matters, Fix (copy-pasteable).
- [ ] Suggested Rewrites block is paste-ready (YAML `description:` value and/or instruction blocks), or explicitly marked "No change recommended".
- [ ] Suggested Evals: either 5–10 targeted rows with the CSV column schema, or a one-line `Not recommended — <reason>` / `Deferred — <reason>`.
- [ ] Verification Evidence identifies level, subject, runs, baseline, artifacts/evidence, and limitations without claiming work that did not happen.
- [ ] Final Recommendation is an ordered action list, not prose.
- [ ] Any unassessable items are explicitly listed.
