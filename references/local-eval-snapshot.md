# Local Skill Eval Snapshots

Use this reference when reviewing or designing evals for a local skill package, especially when the user wants "snapshot-like" regression coverage similar to code snapshot tests.

## Positioning

Do not treat LLM output as a byte-for-byte snapshot by default. Skill outputs often contain valid wording variance, so full-text diffs are noisy and easy to overfit. Prefer a layered snapshot:

1. **Trigger/router evals** — prompt-level checks for whether the skill should load.
2. **Behavior assertions** — objective statements about the output or actions taken.
3. **Calibration fixtures** — hand-labeled examples that anchor subjective verdicts.
4. **Artifact snapshots** — selected output files or extracted fields that should remain stable.

The best snapshot is usually a small machine-readable contract plus retained artifacts for human review, not a frozen transcript.

## Recommended schema

Store local review snapshots as JSON in `evals/`, for example `evals/local-skill-review-snapshot.json`.

```json
{
  "schema_version": "skill-reviewer.local-snapshot.v1",
  "skill_name": "skill-reviewer",
  "snapshot_policy": {
    "compare_mode": "structured",
    "avoid_full_text_diff": true,
    "review_required_for_snapshot_updates": true
  },
  "common_required_sections": [
    "Executive Summary",
    "Verdict",
    "Scorecard",
    "Critical Issues",
    "Recommended Improvements",
    "Trigger Analysis",
    "Resource Review",
    "Suggested Rewrites",
    "Suggested Evals",
    "Final Recommendation"
  ],
  "common_forbidden_actions": [
    "execute reviewed scripts",
    "install packages",
    "mutate the fixture",
    "commit or push changes"
  ],
  "evals": [
    {
      "id": "ready-csv-column-renamer",
      "type": "review-output-snapshot",
      "mode": "full_review",
      "prompt": "Review this skill and decide whether it is ready to ship.",
      "input_fixture": "evals/fixtures/ready-csv-column-renamer/",
      "expected": {
        "verdict": ["Ready", "Ready with minor revisions"],
        "score_ranges": {
          "Trigger reliability": [4, 5],
          "Description quality": [4, 5],
          "Instruction clarity": [4, 5],
          "Resource design": [4, 5],
          "Script necessity": [5, 5],
          "Safety and constraints": [4, 5],
          "Output quality": [4, 5],
          "Maintainability": [4, 5]
        },
        "must_flag": [],
        "must_not_flag": [
          "Description too narrow",
          "Should have scripts",
          "Should support xlsx"
        ]
      },
      "snapshot_artifacts": [
        "review.md",
        "extracted-review.json"
      ]
    }
  ]
}
```

## Workspace layout

Use the `skill-creator` iteration layout when running local skill evals:

```text
<skill-name>-workspace/
├── skill-snapshot/                  # old version or baseline
├── iteration-1/
│   ├── eval-ready-csv-column-renamer/
│   │   ├── eval_metadata.json
│   │   ├── with_skill/
│   │   │   ├── outputs/review.md
│   │   │   ├── outputs/extracted-review.json
│   │   │   └── grading.json
│   │   └── old_skill/
│   │       ├── outputs/review.md
│   │       ├── outputs/extracted-review.json
│   │       └── grading.json
│   └── benchmark.json
└── snapshots/
    └── ready-csv-column-renamer.expected.json
```

For first-time skill creation, the baseline can be `without_skill/`. For improving an existing skill, snapshot the old skill directory before edits and compare against `old_skill/`.

## Grading rules

Grade structured fields before reading prose:

- `verdict` must match an accepted value.
- Every score in `score_ranges` must be present and in range.
- Every `required_sections` item must appear exactly once unless the output format allows focused-review `N/A` sections.
- Every `must_flag` item must appear in Critical Issues or an equivalent blocking section.
- No `must_not_flag` item should appear as a Critical Issue.
- No `forbidden_actions` may happen during review.

Then do a short analyst pass for qualitative regressions: vague fixes, missing paste-ready rewrites, over-punitive verdicts, under-called safety issues, and language-template drift.

## Validator script

After a runner has generated a workspace with `review.md`, `extracted-review.json`, and `grading.json`, validate the structured snapshot contract with:

```bash
python3 scripts/validate_local_snapshot.py \
  evals/local-skill-review-snapshot.json \
  <skill-reviewer-workspace>/iteration-1
```

Run without the workspace path to validate only the contract shape:

```bash
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
```

The script expects `extracted-review.json` to contain:

```json
{
  "verdict": "Ready",
  "scorecard": {
    "Trigger reliability": 5,
    "Description quality": 5
  },
  "sections": ["Executive Summary", "Verdict", "Scorecard"],
  "critical_issues": [],
  "observed_actions": []
}
```

## Snapshot update policy

Update snapshots only when the review contract intentionally changes. A valid snapshot update should say which contract changed:

- scoring dimension name or range changed
- verdict rule changed
- output section changed
- fixture label changed
- a new forbidden action or must-flag issue was added

Do not update snapshots just because wording changed. If wording quality matters, encode it as a structured assertion such as "contains paste-ready YAML description rewrite" instead of freezing the entire paragraph.
