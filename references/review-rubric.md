# Skill Review Rubric

This rubric defines what "good" looks like for each dimension scored in the review. Use it to justify every score and to decide the final verdict. Scores are 1–5.

## Scoring scale (applies to every dimension)

- **5 — Production-ready.** No material issues. Could be installed by a stranger today.
- **4 — Usable; minor polish only.** One or two non-blocking nits.
- **3 — Direction is right, but visible gaps.** Will degrade reliability in real use.
- **2 — Structural problems.** Triggering, instructions, or safety are broken enough to block install.
- **1 — Do not install.** Likely to misfire, leak, or cause harm.

Never hand out a 5 without at least one concrete positive observation. Never hand out a 1 without naming the specific failure mode.

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

**Red flags:**
- Every run invents a new format.
- Output mixes narration and data with no delimiter.

## 8. Eval coverage

**Good looks like:**
- 10–20 prompts covering explicit, implicit, negative, boundary, adjacent-not-trigger, and complex-realistic cases.
- Each prompt has: `prompt`, `should_trigger`, `expected_behavior`, `failure_modes_to_watch`.
- Negative cases are genuinely tricky (share keywords with the skill), not trivial.
- Triggers tested at realistic prompt length, not toy one-liners.

**Red flags:**
- Only positive prompts.
- Negative prompts are obviously unrelated ("write a fibonacci function" for a PDF skill).
- All prompts are one-word queries.
- No expected-behavior column, so pass/fail is a vibe.

## 9. Maintainability

**Good looks like:**
- Clear versioning, changelog, or at least a stable structure.
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

## Verdict decision rules

- **Ready** — All dimensions ≥ 4, no Critical Issues, eval set present and realistic.
- **Ready with minor revisions** — All dimensions ≥ 3, ≤ 2 Critical Issues all with one-line fixes, description and instructions are executable.
- **Needs revision** — Any dimension = 2, or ≥ 3 Critical Issues, or triggering is fundamentally ambiguous.
- **Not ready** — Any dimension = 1, or safety issues unaddressed, or the skill should not exist as a skill.

A skill with a great description but broken instructions is **Needs revision**, not **Ready with minor revisions**. Triggering without executability is worse than not triggering.
