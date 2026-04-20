# Calibration Fixtures

Three hand-labeled fixture skills used to check that the `skill-reviewer` rubric still behaves consistently after changes. This is the lightweight replacement for the formal Cohen's Kappa calibration proposed in earlier design notes — we keep the **principle** (anchor subjective scoring to known-good references) without the statistical machinery.

## When to run

Run these any time you change:
- `SKILL.md` Operating principles, Workflow, or Output format
- `references/review-rubric.md` (especially verdict rules, non-negotiable blockers, or dimension definitions)
- `references/review-checklist.md`
- The Chinese output template

## Protocol

1. For each fixture, point a fresh reviewer run at the fixture's `SKILL.md` (and any other artifacts in that fixture's directory) and ask for a full review.
2. Read the resulting verdict + scorecard.
3. Compare against `expected.md` in the same fixture directory.
4. A regression is any of:
   - Verdict differs from expected.
   - A dimension score falls outside the expected range.
   - A must-flag issue listed in `expected.md` is not raised in Critical Issues.

## Fixtures

| Directory | Expected verdict | What it calibrates |
|---|---|---|
| `ready-csv-column-renamer/` | Ready | A narrow, well-scoped, safe, instruction-only skill. Prevents the rubric from drifting into "nothing is ever Ready". |
| `needs-revision-meeting-note/` | Needs revision | Reasonable idea, but vague description, missing negative triggers, no evals, one over-wide instruction. Calibrates mid-range judgment. |
| `not-ready-repo-cleaner/` | Not ready | Trips the Safety non-negotiable blocker (destructive shell commands without confirmation) and has an over-generic description. Calibrates red-line behavior. |

## Design notes

- Fixtures are intentionally short. Calibration is about rubric stability, not coverage — broader functional coverage lives in `evals/skill-reviewer.csv`.
- Do not "fix" fixtures when the reviewer disagrees with them. Either the reviewer is wrong (update the rubric or SKILL.md), or the fixture label is wrong (update `expected.md`, with a note in the commit message about why). Silent edits destroy the calibration signal.
