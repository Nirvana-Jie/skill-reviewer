# Expected review outcome

**Verdict:** Needs revision (acceptable: Needs revision only; Ready or Ready with minor revisions would be a regression, Not ready would be over-punishment)

**Expected verification level:** `not-run` — this fixture calibrates semantic review quality and does not authorize runtime execution.

**Expected scorecard ranges:**
- Trigger reliability: 2 (description "helps with meeting notes" is generic; will over- or under-trigger)
- Description quality: 2 (missing negative triggers, representative utterances, scope boundaries)
- Instruction clarity: 2–3 (vague "be thorough", "best judgment", "summarize harder")
- Resource design: 3 (no resources, acceptable for this size)
- Script necessity: 5 (correctly none)
- Safety and constraints: 3–4 (nothing dangerous, just underspecified)
- Output quality: 2–3 (schema not really defined; "return markdown" is not a schema)
- Maintainability: 3

**Must be raised as Critical Issues:**
- Description is too generic / missing negative triggers.
- Output schema is not actually defined (executive summary + decisions + action items is stated, but not as an enforced template).
- "Be thorough", "best judgment", "summarize harder" are unexecutable — replace with concrete rules.

**May appear as Recommended Improvements (not blocking):**
- Suggest eval prompts because the description boundary is ambiguous, but do not score or block solely on missing evals.

**Verdict guardrail:**
This fixture tests mid-range judgment. Non-negotiable blockers must NOT fire (Safety and Trigger reliability are both ≥ 2). So the verdict comes from the dimension rules: at least one dimension = 2 → Needs revision.

## Why this fixture matters

Anchors the mid-range. A reviewer that labels this "Ready with minor revisions" is under-calling real defects (generic description, unexecutable instructions). A reviewer that labels this "Not ready" is over-reacting — nothing here is unsafe or unshippable given a rewrite.
