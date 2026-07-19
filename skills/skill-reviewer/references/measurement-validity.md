# Measurement Validity Contract

Read this file before creating or changing deterministic text assertions,
sampling policy, acceptance decisions, evolution accounting, or the Dashboard
release summary.

## First-principles decision order

An Eval is a measuring instrument. A candidate result is meaningful only after
the instrument and the retained observation have been validated. Apply these
three gates in order:

1. **Evidence integrity** — the locked inputs, dispatch receipt, Trace,
   execution metadata, artifacts, and digests are complete and mutually bound.
2. **Measurement validity** — the oracle distinguishes known-good from
   known-bad behavior and paired sampling does not produce contradictory
   directions.
3. **Candidate quality** — only then evaluate required assertions, safety,
   Pareto non-regression, and material primary improvement.

Never infer candidate quality from an invalid or unverified instrument. A
failed candidate under a valid oracle is a real candidate failure. An oracle
that rejects a known-good example or accepts a known-bad example is an invalid
experiment, regardless of the observed candidate score.

## Oracle calibration

Every `must_pass` text assertion in selection or audit authority declares at
least one positive and one negative calibration example. The runtime applies
the exact production predicate to those examples before compiling workers:

```json
{
  "id": "created-lifecycle-allows-state-update",
  "type": "text_matches",
  "artifact": "outputs/response.md",
  "pattern": "(?i)created.{0,80}(may|can).{0,40}(setData|update state)",
  "severity": "must_pass",
  "calibration": {
    "pass_examples": [
      "The created lifecycle may call this.setData() after initialization."
    ],
    "fail_examples": [
      "Do not call this.setData() in created, although later hooks can."
    ]
  }
}
```

Calibration examples are test vectors for the assertion, not prompts or answer
keys for the worker. They remain in Eval authority and are excluded from
assignments and runtime snapshots. Projection retains counts, failed example
indices, and reasons, but not the example text.

Compilation fails before dispatch when:

- a required text assertion has no non-empty `pass_examples` or
  `fail_examples` set;
- the production predicate rejects any positive example;
- the production predicate accepts any negative example; or
- the regex itself is invalid.

This is intentionally stricter for selection, public audit, and opaque audit
packs. Development-only diagnosis may report an unverified oracle, but it
cannot authorize candidate acceptance or release.

Calibration proves only the declared examples. It does not prove semantic
completeness. Prefer structured artifacts and exact typed fields over prose
regex whenever the executor can produce them. For meaning that cannot be
encoded reliably, use a frozen task-specific `semantic_pair` rubric as
supplemental evidence; do not stretch one regex into a semantic oracle.

## Sampling is independent of determinism

`determinism` classifies expected output variability. `sampling` controls how
many paired observations are collected. They are different decisions:

```json
{
  "determinism": "deterministic",
  "sampling": {"repeats": 3, "pairing": "paired"}
}
```

A deterministic contract may still need repeated measurement to detect
harness, model, or baseline instability. A stochastic contract requires at
least three repeats. Candidate and baseline always use the same repeat and
batch cell. Explicit sampling accepts 1–10 repeats; legacy manifests fall back
to one deterministic or three stochastic repeats and record that source.

Do not majority-vote contradictory paired directions. If retained repeats
contain both improvement and regression, sampling validity is `invalid` and
the experiment cannot judge the candidate. The individual observations remain
available for diagnosis.

## Runtime states

Measurement status is one of:

| Status | Meaning | Candidate attribution |
|---|---|---|
| `valid` | Required oracle calibration passed and paired sampling is coherent | Allowed |
| `invalid` | Calibration failed or paired directions disagree | Forbidden |
| `unverified` | Positive measurement evidence is absent, including migrated legacy projections | Forbidden |
| `pending` | The locked measurement has not completed | Forbidden |

Evidence integrity failure remains `inconclusive`; it routes to the execution
environment or missing-evidence owner. Measurement failure produces an
`invalid` acceptance decision and routes to the Eval owner. Neither state is a
Skill regression.

## Evolution accounting

An invalid experiment is quarantined under `invalid_experiments` with its plan,
decision, and measurement reason. It does not:

- append a rejected candidate;
- enter the optimizer rejection buffer;
- advance `current_round`; or
- consume the three-candidate budget.

The physical query remains in the audit journal because an Agent was actually
dispatched. Reusing the same authorization is forbidden. The next action is
`propose_eval_change`; changing the Eval still requires explicit user approval
and a new locked run.

This distinction prevents an invalid instrument from either punishing the
candidate or erasing the fact that a real external execution occurred.

## Artifact ownership

Assertions may read both worker and framework artifacts, but only worker-owned
artifacts are requested from the worker:

| Owner | Examples | Created by |
|---|---|---|
| Worker | `outputs/response.md`, task-specific JSON or files | Evaluated Agent |
| Framework dispatch | `dispatch-receipt.json` | Bound harness |
| Framework Trace | `agent-trace.jsonl`, provider source stream | Adapter/finalizer |
| Framework execution | `execution.json` | Finalizer after Trace closure |

Assignments project this partition as `artifact_ownership`. Framework-owned
artifacts are never listed as worker `expected_artifacts`; otherwise the
worker would be required to create evidence that can only exist after the
framework finalizes its execution.

## Dashboard invariants

Review Overview is validity-first:

1. show measurement validity before candidate verdict;
2. when invalid or unverified, say that the Skill was not judged;
3. route the next action to Eval repair and keep candidate failure language
   suppressed;
4. keep lifecycle completion, evidence quality, measurement validity, and
   business result as independent states; and
5. reject schema-v3 projections that omit measurement data.

Schema-v2 and complete unversioned projections migrate only to explicit
`unverified` measurement. Migration clears release eligibility, candidate
attribution, and available actions; it must never invent a passing oracle.
Raw round decisions are represented once by digest-bound Audit spine nodes,
not duplicated in an unused top-level `iterations` collection.
