# Executable Eval Manifest

Read this file when a reviewed skill contains `evals/evals.json`, when a full
review must execute declared behavior checks, or when the user asks whether a
revision is measurably better.

`evals/evals.json` is an executable contract, not documentation. The lead agent
compiles it into an immutable execution plan, dispatches the plan through the
native agent surface, then gives retained artifacts to deterministic and
semantic graders. The Python runtime never assumes a specific agent provider.

## Release rule

Only `skill-reviewer.evals.v2` is supported. Do not translate or silently skip a
legacy manifest. If `evals/evals.json` exists but cannot compile:

- do not start eval workers;
- report verification level `inconclusive`;
- raise a structural Critical Issue with the exact manifest error;
- cap a requested release/readiness verdict at `Needs revision`.

The manifest may be absent in an ordinary review. Absence is not a scoring
defect. Invalid declared verification is a release defect because it creates a
false quality gate.

## Minimal schema

```json
{
  "schema_version": "skill-reviewer.evals.v2",
  "skill_name": "example-skill",
  "defaults": {
    "permissions": {
      "network": "deny",
      "writable_roots": ["outputs", "semantic"]
    },
    "repeats": {"deterministic": 1, "stochastic": 3},
    "evolution": {"max_rounds": 3}
  },
  "evals": [
    {
      "id": "descriptive-case-id",
      "purpose": "The falsifiable behavior this case protects.",
      "split": "selection",
      "prompt": "A realistic user request.",
      "files": ["evals/fixtures/input.md"],
      "determinism": "deterministic",
      "assertions": [
        {
          "id": "response-exists",
          "type": "file_exists",
          "artifact": "outputs/response.md",
          "severity": "must_pass"
        }
      ],
      "objectives": [
        {
          "id": "contract-pass-rate",
          "metric": "required_pass_rate",
          "direction": "maximize",
          "primary": true,
          "min_material_delta": 0.1,
          "non_regression_tolerance": 0
        }
      ]
    }
  ]
}
```

Case IDs, assertion IDs, and objective IDs are stable strings. Fixture paths
must stay inside the skill package and must exist when the plan is compiled.
Every selected case needs at least one assertion and one objective.

## Splits and information boundaries

- `development` is visible to the optimizer and may be used for targeted fast
  screening.
- `selection` decides whether a candidate may advance. It may be run after the
  development screen but must not be rewritten to fit a candidate output.
- `audit` is hidden from the optimizer, runs once after selection acceptance,
  and is never fed back into another optimization round.

These are information-flow roles, not a claim that files committed in a public
skill package are secret. A genuinely hidden audit must be resolved by a
trusted runner outside the optimizer-visible package. If that is unavailable,
record `holdout visibility: public` as a limitation and narrow the
generalization claim.

Compile only the split needed for the current stage:

```bash
python3 scripts/skill_eval_runtime.py compile \
  --manifest <skill>/evals/evals.json \
  --subject <candidate-skill> \
  --baseline-kind old_skill \
  --baseline-path <accepted-skill> \
  --split selection \
  --case <optional-targeted-case-id> \
  --workspace <outside-skill-workspace>
```

Repeat `--case` for a targeted fast screen. The manifest and its digest remain
unchanged; the selected case IDs are recorded in the plan and run ID.

For an audit with an `old_skill` baseline, the compiler creates three arms:
`with_skill`, `old_skill`, and `without_skill`. A case may declare
`"without_skill": {"applicable": false, "reason": "..."}` when the third arm
is not meaningful. The reason is retained in the plan; omission is never
silent.

## Frozen execution plan

Compilation writes:

- `execution-plan.json` — cases, repeats, permissions, digested fixture records,
  arms, subject, and baseline;
- `run-lock.json` — digests for the plan, manifest, subject, baseline, and every
  selected fixture and executor assignment;
- `assignments/<case>/<arm>/repeat-N.json` — sanitized executor identity,
  prompt, declared inputs, permissions, writable root, and required artifact
  paths; assertion expectations and objectives are intentionally absent;
- `inputs/<case>/package/` — read-only copies of only the declared executor
  files, preserving their relative layout without adjacent answer keys.

The grader re-checks the lock before reading outputs. A changed or missing
source fixture, isolated input, or assignment stops grading. Recompile instead
of mutating the lock.

Repeat policy is fixed:

- deterministic case: one paired repeat;
- stochastic case: three paired repeats;
- both positive and negative paired directions across repeats: `inconclusive`.

Do not replace a direction disagreement with a majority vote.

## Assertion registry

Deterministic assertions run first and may be `must_pass` or `should_pass`:

| Type | Required fields | Meaning |
|---|---|---|
| `file_exists` | `artifact` | Artifact is a regular file |
| `text_contains` | `artifact`, `expected` | Every declared string is present |
| `text_not_contains` | `artifact`, `expected` | No declared string is present |
| `text_matches` | `artifact`, `pattern` | Multiline regular expression matches |
| `json_path` | `artifact`, JSON Pointer `path`, `operator` | Structured JSON assertion |
| `numeric_range` | `artifact`, optional `path`, `minimum` and/or `maximum` | Numeric bound |
| `event_absent` | JSONL `artifact`, `event` | Forbidden event was not recorded |
| `digest_equals` | `artifact`, `expected_sha256` | Exact artifact identity |

`semantic_pair` is supplemental. It cannot replace a deterministic hard gate.
Its artifact is relative to `cases/<case-id>/` and must contain two blind,
order-swapped judgments:

```json
{
  "schema_version": "skill-reviewer.semantic-judgment.v1",
  "blind": true,
  "judgments": [
    {"mapping": {"A": "with_skill", "B": "old_skill"}, "winner": "A"},
    {"mapping": {"A": "old_skill", "B": "with_skill"}, "winner": "B"}
  ]
}
```

`winner` is `A`, `B`, or `tie`. Invalid swapping or disagreement becomes
`inconclusive`; never take a two-vote majority.

## Executor output

Each worker gets exactly one writable repeat root and writes:

```text
cases/<case-id>/<arm>/repeat-<N>/
├── execution.json
├── outputs/
│   └── response.md
└── events.jsonl                 # only when an assertion declares it
```

`execution.json` has this minimum shape:

```json
{
  "status": "completed",
  "forbidden_actions": [],
  "metrics": {},
  "agent_provenance": null
}
```

`agent_provenance` is optional evidence. Model or subagent version is not a
release requirement. The worker must not infer the overall verdict. A lead
agent records a timeout or worker failure as a non-completed status and keeps
partial artifacts.

## Grade and project

```bash
python3 scripts/skill_eval_runtime.py grade \
  --plan <workspace>/execution-plan.json \
  --workspace <workspace>

python3 scripts/skill_eval_runtime.py decide \
  --plan <workspace>/execution-plan.json \
  --evidence <workspace>/verification-evidence.json \
  --workspace <workspace> \
  --iteration 1 \
  --phase selection

python3 scripts/skill_eval_runtime.py project-dashboard \
  --workspace <workspace> \
  --output <workspace>/dashboard-data.json
```

The commands compile, grade, decide, and project. They do not spawn agents,
modify the candidate skill, apply a patch, change evals, or approve a release.
Those responsibilities stay with the lead agent and user.
