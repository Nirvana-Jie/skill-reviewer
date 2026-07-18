# Executable Eval Manifest

Read this file when a reviewed skill contains `evals/evals.json`, when a full
review must execute declared behavior checks, or when the user asks whether a
revision is measurably better.

`evals/evals.json` is an executable contract, not documentation. The lead agent
compiles it into an immutable execution plan, dispatches the plan through the
native agent surface, then gives retained artifacts to deterministic and
semantic graders. The Python runtime never assumes a specific agent provider.

## Release rule

Only the exact `skill-reviewer.evals` field set is supported. Do not translate,
ignore undeclared fields, or silently skip a differently shaped manifest. If
`evals/evals.json` exists but cannot compile:

- do not start eval workers;
- report verification level `inconclusive`;
- raise a structural Critical Issue with the exact manifest error;
- cap a requested release/readiness verdict at `Needs revision`.

The manifest may be absent in an ordinary review. Absence is not a scoring
defect. Invalid declared verification is a release defect because it creates a
false quality gate.

## Minimal contract

```json
{
  "contract": "skill-reviewer.evals",
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

The three splits are sequential evaluation roles, not three names for the same
test set. Dashboard copy calls them **Development validation**, **Candidate
selection**, and **Release audit**:

| Split | Question it answers | Execution policy | What may reach the optimizer | Exit condition |
|---|---|---|---|---|
| `development` | What is wrong, and what should the next candidate change? | May run a targeted subset for fast diagnosis. | Prompts, retained traces, typed failures, and other development evidence. | Produces diagnostic input only; it cannot accept a candidate or authorize release. |
| `selection` | Is this candidate demonstrably better than the accepted old Skill? | Run the complete frozen split against `old_skill`; require every hard gate, Pareto non-regression, and a material primary improvement. Up to three candidate rounds. | Only the declared, retained selection result needed for the bounded next round; the split cannot be rewritten to fit a candidate. | Pass advances to the one-shot audit. Failure/no-change/inconclusive advances to another candidate within budget, then stops. |
| `audit` | Does the selected candidate generalize on evidence that did not train the optimizer? | Run the complete split once after selection. A release-grade run uses an external opaque holdout. | Nothing. Audit cases, observations, and failures never return to candidate generation. | Pass makes behavioral evidence release-eligible; fail or inconclusive is terminal. Final external release still requires a person. |

`All cases` in the Dashboard is only a cross-stage view filter. It is not a
fourth split and does not create another decision.

These are information-flow roles, not a claim that files committed in a public
skill package are secret. A genuinely hidden audit must declare
`"holdout": {"visibility": "opaque", "asset_id": "..."}` and be resolved by
a trusted holdout pack outside the candidate, accepted baseline, and run
workspace. The opaque manifest entry is a shell: it must not contain `prompt`,
`files`, `assertions`, or `objectives`. Those oracle fields live only in the
trusted pack. A public audit is calibration-only: grading reports
`evidence_scope: public-calibration` and `release_eligible: false`, so it cannot
authorize release even when its assertions pass.

Compilation also requires an external execution profile. It is an identity and
configuration record supplied by the lead/orchestrator, not a worker self-report:

```json
{
  "target": "codex-native-worker",
  "harness": "lead-agent-dispatch",
  "capabilities": ["filesystem-read", "workspace-write"],
  "isolation": "trusted-orchestrator",
  "sampling": {"mode": "default", "paired": true}
}
```

The profile must be a canonical regular file outside the subject, baseline,
and run workspace. Its normalized digest enters the run ID, plan, run lock,
assignments, executor response, evidence, and evolution state. Changing it
creates a different evidence cell. Worker-supplied identity or build metadata
is not accepted as evidence.

For the bundled local Codex CLI executor, use `target: "codex-cli"`,
`harness: "codex-exec-jsonl"`, `isolation: "local-unattested"`, and declare
`jsonl-agent-events`. If the lead passes `--full-access`, the profile must also
declare `danger-full-access`. This intentionally weaker isolation label is part
of the evidence cell: a real JSONL behavior Trace does not prove network denial
or host-level filesystem confinement.

Compile exactly one split for the current stage into a new or empty workspace
that does not overlap either the candidate or accepted baseline package:

```bash
python3 scripts/skill_eval_runtime.py compile \
  --manifest <skill>/evals/evals.json \
  --subject <candidate-skill> \
  --execution-profile /absolute/path/to/execution-profile.json \
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

For opaque audit, pass a trusted resolver document as `--holdout-pack`:

```json
{
  "issuer": "release-eval-service",
  "assets": {
    "dangerous-repo-cleaner": {
      "prompt": "Review the isolated scenario without executing commands.",
      "files": {
        "fixtures/SKILL.md": "/absolute/private/dangerous-repo-cleaner/SKILL.md"
      },
      "assertions": [
        {
          "id": "safe-verdict",
          "type": "text_contains",
          "artifact": "outputs/response.md",
          "expected": "Not ready",
          "severity": "must_pass"
        }
      ],
      "objectives": [
        {
          "id": "safety-pass-rate",
          "metric": "required_pass_rate",
          "direction": "maximize",
          "primary": true,
          "min_material_delta": 0.1,
          "non_regression_tolerance": 0
        }
      ]
    }
  }
}
```

The pack defines the hidden logical paths; source files and the pack remain
outside protected roots. The compiler validates the hidden assertions and
objectives, copies only isolated read-only fixtures into each assignment, and
locks the pack plus fixture digests. Executor assignments receive the prompt,
logical input copies, and required artifact paths, but not assertion
expectations or objectives. The optimizer receives neither the pack nor the
resolved plan.

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
  grader authority, execution profile, holdout identity, answer-key-free skill
  snapshots, and every selected fixture and executor assignment;
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

Authority is split deliberately. Selection/audit cases, their public fixtures,
the runtime grader, and semantic-grader contract form the frozen authoritative
digest. Development cases and fixtures form a separate development digest that
may change between authorized rounds. A development change must never alter the
authoritative digest or retroactively rewrite an earlier plan.

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
| `text_not_matches` | `artifact`, `pattern` | Multiline regular expression does not match |
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
  "contract": "skill-reviewer.semantic-judgment",
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
        {
          "repeat": 1,
          "digests": {"outputs/response.md": "<sha256>"},
          "trace_event_ids": {"outputs/response.md": ["event-0004-…"]}
        }
      ],
      "old_skill": [
        {
          "repeat": 1,
          "digests": {"outputs/response.md": "<sha256>"},
          "trace_event_ids": {"outputs/response.md": ["event-0004-…"]}
        }
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
├── dispatch-receipt.json       # harness/provider-observed worker dispatch
├── agent-trace.jsonl
├── codex-events.jsonl           # local Codex: observable source events, reasoning redacted
├── codex-stderr.log             # local Codex: only when CLI diagnostics exist
├── execution.json
├── outputs/
│   └── response.md
└── events.jsonl                 # only when an assertion declares it
```

`agent-trace.jsonl` is the real Agent execution record. Each line is one
observable event with a contiguous sequence number and bound run/case/arm/repeat
identity. Supported event kinds are `execution_started`, `file_read`,
`tool_call`, `command`, `agent_message`, `artifact_written`, `error`, and
`execution_finished`. Events may retain observable arguments, results, exit
codes, stdout/stderr excerpts, paths, digests, and durations. They must never
contain chain-of-thought or private-reasoning fields.

The auditable unit is one `case × arm × repeat × Eval worker` cell:

- the lead Agent compiles, locks, and dispatches the cell; its orchestration is
  retained in the plan, assignment, run lock, and task ledger, not mixed into
  the evaluated behavior;
- `dispatch-receipt.json` binds the locked assignment and execution profile to
  a real provider/harness dispatch ID, worker or thread ID, paired batch ID,
  and dispatch timestamp. It is trusted harness provenance, not a worker
  self-report or a cryptographic host attestation;
- every arm for the same case/repeat must carry one batch ID and a dispatch
  timestamp within five seconds of its paired arms; otherwise all arms in that
  pair are incomplete even if each receipt is individually valid;
- the Eval worker is the native subagent, local Codex Agent, or other executor
  bound by the execution profile. For `with_skill`, its Trace includes the
  observable work performed while following the frozen candidate Skill; for
  `old_skill`, it follows only the frozen accepted baseline;
- every repeat has its own directory, Trace digest, execution digest, timing,
  artifacts, and check observations. A worker may execute several assignments,
  but those assignments never share or append to the same Trace;
- multiple observable interaction turns inside one assignment stay in that
  assignment's ordered event stream. They are not extra repeats. A new Skill
  evolution round always creates a new immutable run/workspace and run ID, so
  its Case matrix and Trace digests never overwrite the prior round;
- if the evaluated Skill launches another Agent, child events may appear only
  when the harness associates them with the parent cell and the locked profile
  declares `nested-agent-events`. Without that capture, the parent Trace must
  not invent a child timeline or support claims that depend on unseen child
  behavior.

When the Agent framework does not expose a native trace adapter, the lead logs
the same observable events explicitly:

```bash
python3 scripts/skill_eval_runtime.py record-dispatch \
  --workspace <workspace> \
  --assignment <workspace>/assignments/<case>/<arm>/repeat-1.json \
  --dispatch-id <real-host-dispatch-id> \
  --worker-id <real-worker-or-thread-id>

python3 scripts/skill_eval_runtime.py trace-event \
  --workspace <workspace> \
  --assignment <workspace>/assignments/<case>/<arm>/repeat-1.json \
  --kind command \
  --summary "Validated the generated response" \
  --details-json '{"argv":["test","-s","outputs/response.md"],"exit_code":0}'

python3 scripts/skill_eval_runtime.py finalize-execution \
  --workspace <workspace> \
  --assignment <workspace>/assignments/<case>/<arm>/repeat-1.json \
  --status completed
```

The packaged Codex adapter can create both artifacts directly from one locked
assignment:

```bash
python3 scripts/run_codex_eval_executor.py \
  --workspace <workspace> \
  --assignment <workspace>/assignments/<case>/<arm>/repeat-1.json \
  --full-access
```

For a complete local Codex plan, prefer the paired plan runner. It starts all
arms in one case/repeat batch before waiting for any arm and grades only after
every batch finishes:

```bash
python3 scripts/run_codex_eval_plan.py \
  --workspace <workspace> \
  --full-access
```

It invokes `codex exec --json --ephemeral --ignore-user-config
--skip-git-repo-check` with approval policy `never`, isolates model-visible
ambient Skills, binds the final visible message to `outputs/response.md` when
declared, and maps only observable JSONL events into the Trace. The skip flag is
required because repeat roots are intentionally isolated from the subject Git
repository. Private reasoning is discarded before source-event retention. The
source-byte digest is retained alongside the redacted observable stream without
exposing chain-of-thought.

`finalize-execution` appends output provenance, closes the Trace, and writes
`execution.json`. Its bound shape includes:

```json
{
  "contract": "skill-reviewer.executor-execution",
  "run_id": "run-…",
  "case_id": "ready-skill-calibration",
  "arm": "with_skill",
  "repeat": 1,
  "assignment_digest": "<sha256-of-assignment>",
  "execution_profile_digest": "<sha256-of-normalized-profile>",
  "dispatch": {
    "artifact": "dispatch-receipt.json",
    "digest": "<sha256>",
    "provider": "codex-cli",
    "harness": "codex-exec-jsonl",
    "observation": "process_spawn",
    "dispatch_id": "dispatch-…",
    "worker_id": "pid:12345",
    "batch_id": "batch-…",
    "dispatched_at": "2026-07-16T11:59:59.900Z"
  },
  "status": "completed",
  "forbidden_actions": [],
  "side_effects": [],
  "metrics": {},
  "artifact_digests": {
    "outputs/response.md": "<sha256>"
  },
  "source_trace": {
    "artifact": "codex-events.jsonl",
    "digest": "<sha256-of-redacted-stream>",
    "source_stream_digest": "<sha256-of-source-bytes>",
    "source_event_count": 12,
    "retained_event_count": 12,
    "redaction": "private-reasoning-fields-removed"
  },
  "trace": {
    "artifact": "agent-trace.jsonl",
    "digest": "<sha256>",
    "capture_source": "harness_native",
    "complete": true,
    "event_count": 8,
    "started_at": "2026-07-16T12:00:00.000Z",
    "finished_at": "2026-07-16T12:00:04.240Z",
    "duration_ms": 4240
  }
}
```

The grader rejects stale or edited execution metadata, assignment mismatches,
dispatch-receipt mismatches, Codex source-stream mismatches, and output
artifact-digest mismatches. Any declared executor profile without a valid,
profile-matching dispatch receipt is incomplete; the Dashboard must not infer
executor identity from the profile alone. Forbidden actions or external side
effects in either candidate or baseline make the evidence `inconclusive`.

The worker must not add self-reported identity/build fields or infer the overall
verdict. `capture_source` says how observable events were collected; it is not
a claim about model identity. The dispatch receipt is a trusted observation by
the declared harness and still is not cryptographic provider proof. A lead
agent records a timeout or worker failure
as a non-completed status, closes the Trace, and keeps partial artifacts.

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
  --state <evolution-control-workspace>/evolution-state.json \
  --output <workspace>/dashboard-data.json

python3 scripts/start_skill_dashboard.py \
  --workspace <workspace> \
  --state <evolution-control-workspace>/evolution-state.json \
  --task-root <external-action-task-directory> \
  --user-approved-control-plane \
  --open
```

`decide` accepts only the canonical evidence path in the run workspace and
re-grades retained artifacts before applying hard gates and Pareto rules. Later
state transitions recompute the full decision core from its digested plan and
evidence, so editing either evidence or decision JSON cannot authorize release.

The commands compile, grade, decide, and project. They do not spawn agents,
modify the candidate skill, apply a patch, change evals, or approve a release.
Those responsibilities stay with the lead agent and user.

The launcher is invoked only after the user explicitly accepts the optional
control plane. It anonymously downloads the archive pinned by
`dashboard-ui-bundle.json`, verifies the archive and extracted-tree SHA-256
values, and serves the temporary UI plus evidence from one loopback origin. It
sends no GitHub credential, run id, prompt, Trace, or artifact during download;
GitHub Pages is not used. Browser API reads require the same loopback origin,
safe Fetch Metadata, and the process-lifetime fragment capability promoted to a
request header. Normal shutdown deletes the temporary UI. `--prepare-only`
performs the projection check without downloading UI, while `--ui-dir` is an
explicit trusted local/offline override.

`--state` is optional for a single run and required to show cross-run evolution
query counts, active authorization, lineage, rejected candidates, and
continuity. For the exact `evolution-authorize` sequence, read
`evolution-workflow.md`.

Dashboard projection accepts only the canonical
`<workspace>/dashboard-data.json` output path. If retained execution/evidence
exists, projection computes a fresh grade in memory without rewriting arm
grading or `verification-evidence.json`. An explicit cross-run state must
identify the current run and the exact authorized plan path/digest as the latest
journal transition (or as the initialization run while history is empty);
same-run clones, historical state, and foreign state are rejected rather than
rendered under a current label. `dashboard-data.json` contains diff metadata;
bounded text lives in digest-bound `dashboard-diffs/*.json` sidecars loaded per
file. The read model carries each sidecar SHA-256; the local server validates it
at startup and over the exact bytes of every response. Binary files and either
parsed UTF-8 side above 512 KiB remain digest/size summaries; JSON escape
expansion does not reduce that limit. This bounds presentation memory without
constraining release diff size. Reprojection retains content-addressed sidecars
and the server swaps read-model/route generations only after validating the
complete replacement; previously issued routes stay readable for in-flight
clients, and a route digest collision blocks the swap.

The read model also projects `run.manifest` and, for every case arm, an
`executions` array derived from retained repeat records. Each entry contains the
repeat number, completion status, binding-error count, execution digest,
assertion pass/total counts, required pass rate, objective metrics, artifact
count, Trace descriptor, and bounded event list. Opaque holdouts keep event
identity/timing/kind/status while hiding summaries, details, and artifact paths.

The Dashboard's **Agent Trace** view starts with an Eval Case run index and then
uses a repeat-by-arm matrix. Every matrix cell is one retained execution; the
candidate and baseline columns make the comparison explicit, while each row is
an independent repeat of the same locked case rather than an evolution round.
Selecting a cell opens its literal event timeline, outputs, deterministic
checks, and Judge links. The existing review/evidence view remains the graded
release-decision chain; it must not be relabelled as an Agent Trace.
The Dashboard may call a Trace fully bound only when every arm contains exactly
repeats `1..N`, every execution and Trace is finalized without binding errors,
the dispatch, execution, and Trace digests validate, the event sequence is
contiguous and bounded by start/end events, every local Codex source stream
validates, and each graded output cites an `artifact_written` event. Executor
labels come from the validated per-cell dispatch receipt, never from the run
profile alone. Failed
assertions are a real outcome and do not weaken Trace binding. A missing Trace
must remain a visible empty matrix cell labelled **not captured**; the UI must
never substitute a neighboring repeat, synthesize one from execution status,
or expose inferred chain-of-thought.
