# Skill Review Rubric

This rubric defines what "good" looks like for each dimension scored in the review. Use it to justify every score and to decide the final verdict. Scores are 1–5.

## Table of Contents

- [Scoring scale (applies to every dimension)](#scoring-scale-applies-to-every-dimension)
- [AI-friendly skill design (applies across dimensions)](#ai-friendly-skill-design-applies-across-dimensions)
- [1. Trigger reliability](#1-trigger-reliability)
- [2. Description quality](#2-description-quality)
- [3. Instruction clarity](#3-instruction-clarity)
- [4. Resource design](#4-resource-design)
  - [References](#references)
  - [Assets](#assets)
- [5. Script necessity](#5-script-necessity)
- [6. Safety and constraints](#6-safety-and-constraints)
- [7. Output quality](#7-output-quality)
- [Suggested evals (optional, not scored)](#suggested-evals-optional-not-scored)
  - [Local snapshot-style evals](#local-snapshot-style-evals)
  - [Subagent effect verification](#subagent-effect-verification)
- [8. Maintainability](#8-maintainability)
- [When a skill should NOT exist](#when-a-skill-should-not-exist)
- [Verdict decision rules](#verdict-decision-rules)

## Scoring scale (applies to every dimension)

- **5 — Production-ready.** No material issues. Could be installed by a stranger today.
- **4 — Usable; minor polish only.** One or two non-blocking nits.
- **3 — Direction is right, but visible gaps.** Will degrade reliability in real use.
- **2 — Structural problems.** Triggering, instructions, or safety are broken enough to block install.
- **1 — Do not install.** Likely to misfire, leak, or cause harm.

Never hand out a 5 without at least one concrete positive observation. Never hand out a 1 without naming the specific failure mode.

---

## AI-friendly skill design (applies across dimensions)

A skill is AI-friendly when the model that loads it can reliably decide when to use it, what to read, what to do next, and what shape to return. Judge this across the existing dimensions; do not add a separate score.

**Good looks like:**
- The job-to-be-done is narrow enough that a model can decide when to load it.
- The workflow is executable by an agent at runtime: inspect, ask, act, stop, or emit a known output.
- Resources use progressive disclosure and give "read when" cues instead of dumping context.
- Outputs are stable enough for a user, evaluator, or downstream skill to consume.
- Any scripts are deterministic helpers, not a substitute for clear instructions.

**Red flags:**
- The package is mostly human advice with no triggerable agent behavior.
- It asks the model to "use judgment" at load-bearing forks without criteria.
- README, rubric, fixtures, or examples describe a different contract than `SKILL.md`.
- The skill claims to be a reusable dependency, but its output shape or scoring dimensions drift across files.

---

## 1. Trigger reliability

**Good looks like:**
- The skill fires when it should, on realistic phrasings the user would actually type.
- It stays quiet on adjacent-but-different tasks.
- It does not require the user to literally name the skill.
- It coexists with sibling skills without collisions; the description says when it wins and when it yields.

**Red flags:**
- Description is a one-liner of the job title ("PDF helper.") with no trigger guidance.
- Description leans on a single keyword ("activate when the user says 'dashboard'").
- Positive conditions listed, but no negative/exclusion conditions.
- Obvious collision with another common skill (e.g., both `pdf-extractor` and `doc-reader` with identical triggers).

## 2. Description quality

A good `description:` contains **all four**:
1. **Target task** — what the skill actually does, in one clause.
2. **Positive triggers** — concrete conditions, phrasings, or intents that should activate it.
3. **Negative triggers** — what looks similar but should NOT activate it.
4. **User utterance patterns** — examples of how a real user phrases the request.

**Red flags:**
- Pure marketing ("Powerful PDF assistant.").
- Only positive conditions, no exclusions.
- Lists features instead of triggering conditions.
- Mentions internal implementation instead of user intent.

## 3. Instruction clarity

**Good looks like:**
- Ordered, executable steps — each step has a clear action verb.
- Boundaries specified: when to stop, when to ask, when to proceed best-effort.
- A defined output format (schema / template / file layout).
- Failure handling for missing or invalid input.
- AI-friendly decision points: the agent can tell whether to inspect, ask, act, or stop without hidden human interpretation.
- Explanations of *why* rules exist, not walls of MUST/NEVER.

**Red flags:**
- All-abstract principles, zero concrete steps.
- Contradictions between sections (e.g., "always ask before writing" + "never ask the user").
- Relies on the model to "use judgment" at every fork.
- No stopping criterion — skill could loop forever.
- No output schema, so every run formats differently.

## 4. Resource design

### References
Warranted when content is:
- Reused across multiple invocations.
- Large enough that inlining into SKILL.md would push it past ~500 lines.
- Domain-specific variant info where only one variant is needed per invocation (e.g., `aws.md`, `gcp.md`).

Unwarranted when:
- The file is 10 lines and never pointed to.
- It duplicates SKILL.md.
- It exists purely to look comprehensive.

### Assets
Warranted when the file is consumed as-is in the skill's output (templates, fixtures, icons, fonts).

**Red flags across all resources:**
- Files present but not referenced from SKILL.md.
- No "read this when X" pointer.
- Unclear naming (`notes.md`, `misc/`).
- Huge single file instead of structured subdirectories.

## 5. Script necessity

**Scripts are warranted when the task is:**
- Repetitive across many invocations.
- Deterministic (same input → same output).
- Error-prone or tedious when an LLM does it token-by-token (binary file manipulation, AST transforms, data parsing, packaging).
- Materially faster/cheaper/safer as code.

**Scripts are NOT warranted when:**
- The logic is a few lines of text judgment.
- The LLM can do it equally well inline.
- The script is a thin shell over a single library call with no added value.
- It exists only to "feel engineered".

**Default preference:** instruction-only. Adding a script is a cost; justify it.

## 6. Safety and constraints

**Good looks like:**
- Explicit handling of credentials, PII, and sensitive data.
- Explicit scope for external commands (what's allowed, what requires confirmation).
- Refusal / escalation rules for destructive actions (`rm -rf`, `git push --force`, network exfiltration, installing packages).
- Idempotency or safe-retry guidance where relevant.
- Guardrails for prompt-injection-prone inputs (user-supplied docs, web pages).

**Red flags:**
- Unrestricted shell access with no rules.
- "Auto-fix and commit" flows with no confirmation.
- No mention of sensitive data even though the skill clearly touches it.

## 7. Output quality

**Good looks like:**
- A stable, named output format.
- Examples of the output in SKILL.md or references.
- Deterministic file layout / schema the caller can rely on.
- Runtime verification claims identify the tested subject, baseline, retained
  artifacts, and verification level. `not-run` is preferable to an invented
  pass.

**Red flags:**
- Every run invents a new format.
- Output mixes narration and data with no delimiter.

## Suggested evals (optional, not scored)

Evals are **not a scorecard dimension** and their absence is never a blocker. Do not dock a skill for lacking evals. Only recommend them when they would materially reduce risk for this specific skill (fuzzy triggers, sibling collisions, or post-iteration regression risk).

**When evals are worth proposing, good looks like:**
- 5–10 `skill-reviewer.evals` cases covering explicit, implicit, negative,
  boundary, adjacent-not-trigger, and complex-realistic behavior.
- Every case has a purpose, split, prompt, determinism, at least one
  deterministic `must_pass` assertion, and at least one objective.
- Assertions verify retained artifacts; negative cases are genuinely tricky
  near misses rather than trivially unrelated prompts.

**When to explicitly defer/decline:**
- Skill is in rapid prototyping — description still churning.
- Trigger surface is unambiguous (e.g. tied to a specific file extension).
- The added maintenance cost clearly exceeds the regression risk.

### Local snapshot-style evals

For local skill evaluation, snapshot-style coverage is warranted when the skill's output contract must stay stable across edits, especially for reviewer, grader, formatter, or file-producing skills.

**Good looks like:**
- Trigger/router evals are separate from output snapshots.
- Fixtures have human-readable expectations and machine-readable assertions.
- Snapshots compare structured fields (verdict, score ranges, required sections, must-flag issues, forbidden actions) before prose.
- The workspace saves artifacts (`review.md`, extracted JSON, `grading.json`, benchmark data) so regressions can be inspected.
- There is an explicit update policy: snapshots change only when the contract changes, not because wording drifted.

**Red flags:**
- Full natural-language output is treated as a byte-for-byte snapshot.
- A single prompt with no baseline is called a benchmark.
- Snapshot files do not identify the input fixture, model/run context, expected verdict, or forbidden actions.
- Fixture `expected.md`, JSON snapshots, and README describe different dimensions or section names.

### Subagent effect verification

When the user explicitly asks whether a skill revision works better, subagents
are useful for independent execution, not as a substitute for evidence.

**Good looks like:**
- A present behavior manifest uses `skill-reviewer.evals`, compiles before
  worker launch, and locks the plan, subject, baseline, execution profile,
  holdout identity, and fixture digests.
- The reviewed subject and baseline are frozen and identified by digest.
- `with_skill` and `old_skill` / `without_skill` start in the same turn.
- Workers are read-only, bounded to one case or configuration, and cannot edit
  the target, update snapshots, or decide the final verdict.
- Assertions are graded against retained outputs; a zero exit code is not
  sufficient evidence.
- Missing baselines, digest mismatches, timeouts, or conflicting results become
  `inconclusive`, not passing evidence.
- Deterministic assertions are primary; semantic comparisons are anonymized,
  order-swapped, and supplemental.
- Deterministic cases run once, stochastic cases run three paired repeats, and
  opposite paired directions remain `inconclusive`.

**Red flags:**
- A present invalid or differently shaped eval manifest is silently skipped while the skill
  still claims a release check.
- "Subagents were launched" is presented as proof of quality.
- Only the new skill is run, but the report claims a regression improvement.
- Workers evaluate different subject digests or mutate shared fixtures.
- The lead agent delegates the final release decision to a worker or majority
  vote.
- An optimizer can edit evals, fixtures, snapshots, graders, or audit cases to
  make its candidate pass.

### Bounded evolution acceptance

When the user explicitly requests evolution, acceptance is not an average
score. Every required hard gate must pass, no declared objective may regress
beyond tolerance, and at least one primary objective must improve materially.
Development, selection, and audit data stay separated. Stop after three
selection rounds; audit runs once and its failure is terminal.

Authoritative selection/audit eval assets are immutable during a run; a
development surrogate may evolve under a separate digest. A proposed
authoritative eval change requires user confirmation and a new locked run. Each
later selection query and the one audit require explicit authorization and
lineage. Public audit fixtures are calibration-only; release requires an opaque
holdout. The optimizer may otherwise restructure the skill package without an
artificial diff-size limit; architecture rewrites reset continuity from the
accepted baseline. New dependencies, network access, or permission expansion
require user approval.

## 8. Maintainability

**Good looks like:**
- A stable structure or explicit changelog when changes affect callers.
- Small SKILL.md (~<500 lines) with progressive disclosure into references.
- Each file has a single, describable purpose.
- Reasonable dependency footprint.

**Red flags:**
- 1500-line SKILL.md.
- Dead files.
- Scripts with no tests and no docstring.

---

## When a skill should NOT exist

Recommend against shipping as a skill when:
- The behavior is a single prompt rewrite the user could just paste.
- The task is already covered by a built-in tool or first-class MCP.
- The skill is narrower than a single user would use repeatedly (one-shot job).
- The "skill" is really a library and would be better as a CLI or package.
- The workflow depends on mutable private infrastructure the skill cannot describe.
- The artifact is only static documentation or reviewer philosophy, with no clear trigger, executable workflow, or stable output contract for an agent.

## Verdict decision rules

**Non-negotiable blockers (evaluated first, before any other rule):**
- **Safety and constraints = 1** → **Not ready.** No other dimension score can override this. A skill with unaddressed safety issues (executes destructive commands without confirmation, leaks PII, has no guardrail against prompt injection in the data it processes, etc.) must not ship regardless of how elegant its triggering or instructions are.
- **Trigger reliability = 1** → **Not ready.** A skill that cannot reliably decide when to run is load-bearing broken; high scores elsewhere do not compensate.
- **Safety and constraints = 2** or **Trigger reliability = 2** → cannot be **Ready**; cap at **Needs revision** regardless of other scores.

Apply these rules first. Only if none of them trigger, fall through to the dimension rules below.

**Dimension rules:**
- **Ready** — All dimensions ≥ 4, no Critical Issues, description and instructions executable.
- **Ready with minor revisions** — All dimensions ≥ 3, ≤ 2 Critical Issues all with one-line fixes, description and instructions are executable.
- **Needs revision** — Any dimension = 2, or ≥ 3 Critical Issues, or triggering is fundamentally ambiguous.
- **Not ready** — Any dimension = 1, or safety issues unaddressed, or the skill should not exist as a skill.

A skill with a great description but broken instructions is **Needs revision**, not **Ready with minor revisions**. Triggering without executability is worse than not triggering.

Evals remain unscored, but evidence integrity is not optional. When runtime
verification was explicitly requested, a failed declared validation, a false
verification claim, or contradictory grading is a Critical Issue and caps the
verdict at **Needs revision** until resolved. Merely lacking evals does not
trigger this cap.

A present invalid `evals/evals.json` is also a Critical Issue in a full or
readiness review: it is a broken declared quality gate, not an absent optional
eval set. Do not start workers or silently downgrade it to `not-run`.
