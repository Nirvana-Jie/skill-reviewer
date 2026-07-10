# Expected review outcome

**Verdict:** Ready (acceptable: Ready, Ready with minor revisions)

**Expected verification level:** `not-run` — this fixture calibrates semantic review quality and does not authorize runtime execution.

**Expected scorecard ranges:**
- Trigger reliability: 4–5
- Description quality: 4–5
- Instruction clarity: 4–5
- Resource design: 4–5 (instruction-only is correct here)
- Script necessity: 5 (no scripts is the right call; flagging this as missing would be a regression)
- Safety and constraints: 4–5
- Output quality: 4–5
- Maintainability: 4–5

**Must NOT be raised as Critical Issues:**
- "Description too narrow" (narrow scope is a feature here).
- "Should have scripts" (instruction-only is correct).
- "Should support xlsx" (out-of-scope by design).

**May appear as Recommended Improvements (not blocking):**
- Suggest a tiny eval set, but only as optional regression protection.
- Mention `.csv.gz` or BOM edge cases.

## Why this fixture matters

Anchors the rubric's upper end. If this skill comes back as "Needs revision" the reviewer is being too punitive — likely manufacturing issues to avoid a positive verdict. That pattern was explicitly ruled out in SKILL.md's Notes on working style.
