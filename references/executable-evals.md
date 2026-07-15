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
      "external_side_effects": "deny",
      "writable_roots": ["outputs", "semantic"]
    },
    "repeats": {"deterministic": 1, "stochastic": 3},
    "evolution": {"max_rounds": 3},
    "case_timeout_seconds": 300
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

Case IDs are path-safe lowercase kebab-case slugs; assertion and objective IDs
are stable strings. Fixture paths are unique canonical relative paths (no
absolute path or `..`), must stay inside the skill package, and must exist when
the plan is compiled. `case_timeout_seconds` is a positive integer; a case may
override it with its own positive `timeout_seconds`. Permission objects accept
only `network`, `network_allowlist`, `external_side_effects`, and
`writable_roots`, so extension fields cannot carry answer keys into worker
assignments. Every selected case needs at least one
assertion and one objective. A primary objective needs a strictly positive
`min_material_delta`; equal scores are not material improvement. External side
effects remain denied for every case.

## Splits and information boundaries

- `development` is visible to the optimizer and may be used for targeted fast
  screening.
- `selection` decides whether a candidate may advance. It may be run after the
  development screen but must not be rewritten to fit a candidate output.
- `audit` is withheld from optimizer feedback, runs once after selection
  acceptance, and is never fed back into another optimization round.

These are information-flow roles, not a claim that files committed in a public
skill package are secret. A genuinely hidden audit must be resolved by a
trusted runner outside the optimizer-visible package. If that is unavailable,
record `holdout visibility: public` as a limitation and narrow the
generalization claim.

Compile exactly one split for the current stage into a new or empty workspace
that does not overlap either the candidate or accepted baseline package:

```bash
python3 scripts/skill_eval_runtime.py compile \
  --manifest <skill>/evals/evals.json \
  --subject <candidate-skill> \
  --baseline-kind old_skill \
  --baseline-path <accepted-skill> \
  --split selection \
  --workspace <outside-skill-workspace>
```

Use repeated `--case` only with the `development` split for a targeted fast
screen. Selection and audit always execute their complete split and require an
`old_skill` baseline; a partial release split is rejected. The manifest and its
digest remain unchanged, and selected development case IDs are recorded in the
plan and run ID. Multi-split plans and workspace reuse are rejected before any
worker is launched.

For an audit with an `old_skill` baseline, the compiler creates three arms:
`with_skill`, `old_skill`, and `without_skill`. A case may declare
`"without_skill": {"applicable": false, "reason": "..."}` when the third arm
is not meaningful. The reason is retained in the plan; omission is never
silent.

## Frozen execution plan

Compilation writes:

- `execution-plan.json` — cases, repeats, permissions, digested fixture records,
  arms, subject, and baseline;
- `run-lock.json` — digests for the plan, manifest, subject, baseline, eval and
  grader authority, answer-key-free skill snapshots, and every selected
  fixture and executor assignment;
- `assignments/<case>/<arm>/repeat-N.json` — sanitized executor identity,
  prompt, timeout, declared inputs, permissions, writable root, and required
  artifact paths; assertion expectations and objectives are intentionally
  absent;
- `skill-snapshots/<case>/<arm>/repeat-N/` — independent read-only runtime
  views containing only `SKILL.md`, `references/`, `scripts/`, and `assets/`;
  source `evals/`, answer keys, tests, and repository metadata are absent, and
  no worker shares a writable snapshot directory with another worker;
- `inputs/<case>/<arm>/repeat-N/package/` — arm/repeat-specific read-only copies
  of only the declared executor files, preserving their relative layout
  without adjacent answer keys.

The grader does not treat `run-lock.json` as a self-authenticating source. Before
reading outputs it reconstructs the normalized cases, full release split,
baseline rule, run ID, snapshots, isolated inputs, sanitized assignments, and
the complete lock from the pinned manifest, candidate, baseline, and grader
authority. Coordinated edits to plan + lock + assignment therefore still stop
grading. Recompile instead of mutating any retained contract.

Snapshot and input authority locks the complete readable tree: canonical path,
file/directory kind, read/execute permission bits, file bytes, and empty
directories. Snapshot and isolated-input trees must remain read-only. Symlinks,
hard links, special files, undeclared entries, and mode drift are rejected.

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
Every case must therefore declare at least one deterministic `must_pass`
assertion; a semantic-only or all-`should_pass` case is structurally invalid.
It requires a non-empty task-specific `rubric` plus a non-empty unique `inputs`
array of executor output paths. Those fields are frozen in eval authority. Read
`semantic-grader-contract.md` before dispatch. Its official artifact is
relative to `cases/<case-id>/` and must contain two blind, order-swapped
judgments plus the exact binding projected by the lead:

```json
{
  "schema_version": "skill-reviewer.semantic-judgment.v1",
  "blind": true,
  "binding": {
    "run_id": "run-…",
    "case_id": "ready-skill-calibration",
    "assertion_id": "blind-rubric-quality",
    "authority_digest": "<sha256>",
    "semantic_grader_contract_digest": "<sha256>",
    "rubric_digest": "<sha256>",
    "inputs": ["outputs/response.md"],
    "artifacts": {
      "with_skill": [
        {"repeat": 1, "digests": {"outputs/response.md": "<sha256>"}}
      ],
      "old_skill": [
        {"repeat": 1, "digests": {"outputs/response.md": "<sha256>"}}
      ]
    }
  },
  "judgments": [
    {"mapping": {"A": "with_skill", "B": "old_skill"}, "winner": "A"},
    {"mapping": {"A": "old_skill", "B": "with_skill"}, "winner": "B"}
  ]
}
```

`winner` is `A`, `B`, or `tie`. The blind worker must not see or write the arm
mapping; it returns anonymous winners to the lead, which owns the official
mapped and bound artifact. Invalid swapping, disagreement, or any stale
run/case/rubric/output digest becomes `inconclusive`; never take a two-vote
majority.

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
  "schema_version": "skill-reviewer.executor-execution.v1",
  "run_id": "run-…",
  "case_id": "ready-skill-calibration",
  "arm": "with_skill",
  "repeat": 1,
  "assignment_digest": "<sha256-of-assignment>",
  "status": "completed",
  "forbidden_actions": [],
  "side_effects": [],
  "metrics": {},
  "artifact_digests": {
    "outputs/response.md": "<sha256>"
  },
  "agent_provenance": null
}
```

The grader rejects stale or edited execution metadata, assignment mismatches,
and artifact-digest mismatches. Forbidden actions or external side effects in
either candidate or baseline make the evidence `inconclusive`.

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

`decide` accepts only the canonical evidence path in the run workspace and
re-grades retained artifacts before applying hard gates and Pareto rules. Later
state transitions recompute the full decision core from its digested plan and
evidence, so editing either evidence or decision JSON cannot authorize release.

The commands compile, grade, decide, and project. They do not spawn agents,
modify the candidate skill, apply a patch, change evals, or approve a release.
Those responsibilities stay with the lead agent and user.

Dashboard projection accepts only the canonical
`<workspace>/dashboard-data.json` output path. If retained execution/evidence
exists, projection computes a fresh grade in memory without rewriting arm
grading or `verification-evidence.json`. An explicit cross-run state must
identify the current run as the latest journal transition (or as the
initialization run while history is empty); historical and foreign state is
rejected rather than rendered under a current label.
