# Subagent Eval Workflow

Use this workflow only when the user asks to verify a skill's runtime effect,
benchmark a revision, or support a production-readiness claim with behavioral
evidence. Ordinary static or semantic reviews should report `not-run` and avoid
spending subagent runs that cannot change the decision.

## Verification contract

Subagents provide independent execution evidence; they do not replace the lead
reviewer's judgment. A valid verification run must identify the exact subject,
retain outputs, grade explicit assertions, and compare against the right
baseline when a regression claim is made.

Use exactly one final level:

- `not-run` — no runtime eval was executed.
- `inconclusive` — execution was attempted, but required evidence is missing,
  inconsistent, timed out, or refers to the wrong subject.
- `behavior-verified` — all required assertions passed for the tested
  `with_skill` cases; no baseline claim is made.
- `regression-verified` — required assertions passed for `with_skill`, the
  paired baseline completed, and no required assertion regressed.

## Preconditions

Before spawning workers, the lead agent must:

1. Read the target `SKILL.md` and every target resource needed to understand the
   behavior under test.
2. Confirm that runtime verification is in scope. Do not infer permission to run
   target business scripts, install packages, make network calls, or mutate the
   target repository.
3. Freeze the subject under test and record a digest. For an existing skill,
   freeze the pre-change version as `old_skill`; for a new skill, use
   `without_skill` as the baseline.
4. Define 2–3 realistic eval cases and objective assertions before looking at
   the outputs. Subjective qualities may remain human-reviewed.
5. Create a workspace outside the target skill directory. Never write generated
   eval state into the reviewed package.

If any precondition fails, do not improvise a pass. Report `inconclusive` with
the missing prerequisite.

## Worker launch

Launch `with_skill` and its paired baseline in the same turn. This reduces bias
from model, environment, or instruction drift between configurations.

Respect the environment's concurrency limit. Prefer one bounded worker per
case/configuration. When there are fewer slots than runs, batch cases by
configuration, but still start the `with_skill` and baseline workers together.
Do not exceed three concurrent eval workers.

Each worker prompt must include:

- immutable skill path or `without_skill` marker;
- subject digest and configuration name;
- one or more explicit eval prompts;
- input file paths, if any;
- exact output directory;
- assertions to preserve for grading;
- read-only and no-network constraints;
- a prohibition on editing the target skill, fixtures, snapshots, or git state.

Workers may create only their assigned workspace artifacts. They must not decide
the overall verdict or recursively invoke the complete `skill-reviewer`
workflow.

## Workspace contract

```text
<workspace>/iteration-N/
├── eval-<case-name>/
│   ├── eval_metadata.json
│   ├── with_skill/
│   │   ├── outputs/
│   │   ├── transcript.md
│   │   ├── timing.json
│   │   └── grading.json
│   └── old_skill/                 # or without_skill/
│       ├── outputs/
│       ├── transcript.md
│       ├── timing.json
│       └── grading.json
├── verification-evidence.json
└── benchmark.json
```

Timing fields may be `null` when the subagent runtime does not expose them; do
not fabricate values.

## Grading and aggregation

After execution:

1. Check that every output reports the expected subject digest and
   configuration.
2. Grade deterministic assertions with code when possible. Use a separate
   grader subagent only for evidence that requires semantic judgment.
3. Store every assertion as `{text, passed, evidence}`. A process exit code alone
   is never a passing grade.
4. Compare `with_skill` with the paired baseline. Always-pass assertions are
   non-discriminating and do not prove skill value.
5. Treat missing outputs, forbidden actions, digest mismatches, timeouts, and
   grader disagreement as failures or `inconclusive` evidence.
6. Let the lead agent aggregate the results and assign the verification level.

Use this evidence shape:

```json
{
  "schema_version": "skill-reviewer.verification.v1",
  "subject": {"path": "...", "digest": "..."},
  "baseline": {"kind": "old_skill", "path": "...", "digest": "..."},
  "level": "regression-verified",
  "cases": [
    {
      "id": "descriptive-case",
      "with_skill": {"passed": true, "artifacts": ["..."]},
      "old_skill": {"passed": false, "artifacts": ["..."]},
      "regressed": false
    }
  ],
  "limitations": []
}
```

## Release interpretation

- `not-run` is acceptable for an ordinary review and must be stated plainly.
- `behavior-verified` supports only the tested cases, not a general regression
  claim.
- `regression-verified` requires a completed paired baseline and recorded
  subject digests.
- `inconclusive` never becomes passing evidence through majority vote.
- A failed required eval or a claim of verification without retained evidence
  is a Critical Issue. It caps a requested production-readiness verdict at
  `Needs revision` until resolved.
