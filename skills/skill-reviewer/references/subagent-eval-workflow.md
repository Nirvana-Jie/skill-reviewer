# Native-Agent Eval Orchestration

Read this workflow only for explicit behavior/regression verification or
explicit evolution. A default Review may inspect the manifest but must not
dispatch workers. Read
`references/executable-evals.md` first for the manifest, assertion, and artifact
contracts, then read `references/agent-trace-contract.md` for the
provider-neutral adapter boundary. If the user explicitly asks to improve the skill, also read
`references/evolution-workflow.md`.

## Boundary

The lead agent dispatches native subagents. `scripts/skill_eval_runtime.py` is
agent-agnostic: it compiles a plan, verifies locks, grades artifacts, makes a
mechanical acceptance decision, and projects a dashboard read model. It does
not know how to create a worker.

Subagents supply isolated execution evidence. They do not own the final review,
release verdict, skill edits, eval edits, or snapshot updates.

For Trace purposes, the dispatched subagent is the **Eval worker** and therefore
the evaluated actor. The lead Agent is only the dispatcher. Preserve one real
Trace for every locked `case × arm × repeat` assignment even when the same
subagent processes several assignments; never concatenate multiple repeats or
mix lead-Agent planning events into a worker Trace.

Bundled provider adapters are dispatch surfaces, not second graders.
`scripts/run_codex_eval_executor.py` and
`scripts/run_claude_eval_executor.py` each accept exactly one sanitized, locked
assignment and normalize observable provider events into the same Trace. The
lead Agent still owns decisions and evolution state. For a complete local
Codex plan, `scripts/run_codex_eval_plan.py` mechanically owns paired
case/repeat fan-out and invokes grading after all cells finish. Other Agents
integrate through the same contract without Dashboard changes.

For local Codex execution, bind this profile shape before compile:

```json
{
  "target": "codex-cli",
  "harness": "codex-exec-jsonl",
  "dispatch_observation": "process_spawn",
  "trace": {
    "capture_source": "provider_stream",
    "source": {
      "artifact": "agent-source-events.jsonl",
      "format": "codex-exec-jsonl-v1"
    }
  },
  "capabilities": [
    "filesystem-read",
    "filesystem-write",
    "shell",
    "jsonl-agent-events",
    "source-event-stream"
  ],
  "isolation": "local-unattested",
  "sampling": {"mode": "codex-default", "paired": true}
}
```

Then dispatch the locked plan. The runner starts every arm for one case/repeat
batch before waiting for any arm:

```bash
python3 scripts/run_codex_eval_plan.py \
  --workspace <workspace>
```

`--full-access` is a separate, explicit local execution choice. Use it only when
the user authorizes `danger-full-access`, and add that capability to the locked
profile before compile. The adapter keeps the profile as `local-unattested`,
disables ambient Skills, and points the assigned arm directly at its frozen
snapshot. An isolation failure blocks execution instead of contaminating the
baseline. The resulting Trace is evidence of observable Agent behavior, not
proof that the host enforced network denial or prevented every out-of-root
write.

## When to execute

- Default Review, including full readiness and focused review: do not execute;
  report `not-run` and name what explicit Verify could establish.
- Explicit Verify request: execute the relevant locked verification path.
- Explicit static-only / no-subagent request: do not execute even if Verify-like
  wording is present; report `not-run`.
- Explicit Evolve request: follow the bounded evolution workflow.

An absent manifest is not a defect. An invalid present manifest is a release
blocker and stops before worker launch.

## Lead preflight

1. Read the target `SKILL.md` and every resource needed by the selected cases.
2. Place the workspace outside candidate and baseline directories.
3. Choose `old_skill` for selection/audit revision comparison; development may
   use `without_skill`. Freeze the accepted baseline before candidate edits.
4. Create or select a canonical execution profile outside subject, baseline,
   and run roots. It declares target, harness, dispatch observation, Trace
   adapter/source, capabilities, isolation, and sampling. Do not ask a worker
   to add self-reported identity or build fields.
5. Compile exactly one required split into a fresh, empty workspace. For an
   opaque audit, also pass the trusted holdout pack; never expose it to the
   optimizer or executor. Treat `execution-plan.json` and `run-lock.json` as
   immutable.
6. Check permissions. Default to no network and no writes outside each repeat
   root. Ask before any external dependency or permission expansion.
7. Count runs from case × arm × repeat. Respect the environment concurrency
   limit; batch by configuration when needed.

## Dispatch contract

Start paired configurations in the same lead-agent turn. If there are fewer
worker slots than logical runs, give one worker several repeats for one arm,
but launch candidate and baseline workers together. Use at most three eval
workers concurrently unless the environment explicitly permits more.

Each executor prompt includes:

- exact sanitized assignment path, run ID, case ID, arm, and repeat numbers;
- locked execution-profile digest from the assignment;
- answer-key-free candidate/baseline snapshot path, or the `without_skill`
  marker;
- source/snapshot digest and declared input paths from the assignment;
- the realistic user prompt, not a paraphrased success criterion;
- exact writable repeat root and required artifact paths;
- declared permissions and timeout;
- only the declared executor input files; never calibration `expected.md`,
  assertion expected values, audit content, or grader references;
- prohibition on editing candidate, baseline, manifest, fixtures, snapshots,
  grader, git state, or another worker directory;
- prohibition on making the overall release decision or recursively invoking
  the complete review/evolution loop.

For `with_skill`, tell the executor to follow the frozen candidate skill. For
`old_skill`, use only the frozen accepted baseline snapshot. For `without_skill`, do not
load either package; solve from the user prompt and provided fixture only.

The harness or lead records every observable action in the repeat's append-only
`agent-trace.jsonl`: file reads, tool calls, commands with exit codes, observable
Agent messages, errors, and written artifacts. It must not record hidden model
reasoning. Failed, timed-out, or interrupted runs still end with an
`execution_finished` event and retain partial outputs. Never reconstruct a
missing event or output from memory.

Before the first native worker event, retain the real host dispatch observation:

```bash
python3 scripts/skill_eval_runtime.py record-dispatch \
  --workspace <workspace> \
  --assignment <workspace>/assignments/<case>/<arm>/repeat-1.json \
  --dispatch-id <host-dispatch-id> \
  --worker-id <host-worker-or-thread-id> \
  --batch-id <paired-batch-id>
```

The command derives provider, harness, and observation mode from the locked
execution profile; caller-supplied identity cannot replace those fields. The
receipt is trusted lead/harness provenance and detects later drift, but without
a provider-signed host API it is not cryptographic proof against the same OS
owner. A profile without a valid receipt remains declared configuration rather
than being displayed as a native subagent. All arms for one case/repeat must
share the batch ID and be dispatched within five seconds; the grader rejects a
serialized or mismatched pair.

This record covers what the Eval worker actually did while using the assigned
frozen Skill snapshot. If that Skill internally dispatches another Agent, the
child is not a second Eval worker or a new repeat. Retain its observable events
only when the native harness binds them to the parent assignment and the locked
execution profile declares `nested-agent-events`. Otherwise mark nested-agent
coverage unavailable and do not use presumed child behavior as grading
evidence.

If one Eval worker needs several visible interaction turns to finish the same
assignment, append those observable events to the same Trace in capture order.
Do not count turns as repeats. Conversely, continuous-evolution round N+1 is a
new locked run with its own workspace and Case matrix; retain round N unchanged
and inspect it through that run's permalink/workspace rather than appending new
events to an old Trace.

Any profile with a non-null `trace.source` retains the declared source artifact
plus adapter, format, digest, retained/source event counts, and the digest of
the observed source bytes. The bundled Codex and Claude adapters both use
`agent-source-events.jsonl`. `execution.json` binds that descriptor and grading
revalidates the file and its `artifact_written` event. Any reasoning item and
reasoning-named field is removed before the source file or
`agent-trace.jsonl` is written. Provider stderr may be retained separately.
These support artifacts explain how normalized events map back to a provider;
they are not assertion answers and do not replace required outputs.

Use `skill_eval_runtime.py trace-event` when the native harness has no trace
adapter, after `record-dispatch`; then use `finalize-execution` to append
missing `artifact_written` provenance and create `execution.json`. Every
execution record binds the dispatch receipt, Trace digest, and metadata in
addition to run/case/arm/repeat, assignment digest,
execution-profile digest, forbidden actions, side effects, and produced
artifact digests. A missing, stale, mismatched, non-contiguous, or unfinalized
Trace is incomplete evidence.

Do not hand the executor the full plan when it contains assertion expectations.
Pass a sanitized assignment derived from the locked plan: identity, prompt,
declared input files, permissions, and writable root only. Keep the plan itself
with the lead and graders.

## Workspace

```text
<workspace>/
├── execution-plan.json
├── run-lock.json
├── skill-snapshots/
│   └── <case>/<arm>/repeat-N/          # independent; no evals or answer keys
├── inputs/<case>/<arm>/repeat-N/package/...
├── assignments/<case>/<arm>/repeat-N.json
├── cases/
│   └── <case-id>/
│       ├── with_skill/
│       │   ├── repeat-1/
│       │   │   ├── dispatch-receipt.json
│       │   │   ├── agent-trace.jsonl
│       │   │   ├── agent-source-events.jsonl # when declared by the profile
│       │   │   ├── execution.json
│       │   │   └── outputs/...
│       │   └── grading.json
│       ├── old_skill/                 # or without_skill/
│       │   └── repeat-1/...
│       └── semantic/
│           └── <assertion-id>.json
├── verification-evidence.json
├── codex-dispatch-summary.json               # local paired runner only
├── iteration-<N>/
│   ├── acceptance-decision.json
│   └── audit-decision.json             # only for the one-shot audit
└── dashboard-data.json
```

For explicit evolution, keep `evolution-state.json` in a separate control
workspace. Each candidate round and audit has its own immutable run workspace;
the state joins them by authority, baseline, execution-profile, and lineage
digests rather than one run ID. Initialization authorizes the first selection;
the lead must call `evolution-authorize` before every later selection and before
the only audit. Executors receive neither state nor authorization paths.
The control workspace must start empty and must not overlap the candidate or
accepted baseline package. It also contains a digest-chained `transitions/`
journal; executors receive neither the state nor journal path. This local
journal is recoverable after a partial state write, but it assumes the lead's
control workspace is trusted. Same-owner anti-replay requires an external
append-only anchor.

Generated state never belongs inside the reviewed skill package.

## Semantic grader dispatch

Run deterministic grading first. Only assertions declared `semantic_pair` may
invoke a semantic grader. Give the grader anonymized output A and B plus the
frozen task-specific rubric and `semantic-grader-contract.md`; withhold
configuration names, candidate age, mappings, and the optimizer's rationale.
Run the same judgment again with A/B order swapped.

The blind worker writes only raw anonymous winners. The lead resolves the hidden
mappings and creates the official artifact described in
`references/executable-evals.md`, including the runtime-projected binding over
run, case, authority, rubric, declared inputs, repeats, and output digests. If
the resolved winners disagree or the binding is stale, retain both judgments
and mark the case `inconclusive`. Do not add a third vote.

## Lead aggregation

After all workers finish:

1. Run deterministic `grade`; it revalidates frozen inputs before inspecting
   outputs.
2. Apply evidence integrity, measurement validity, then candidate quality.
   Inspect every incomplete arm, forbidden action, failed `must_pass`
   assertion, direction disagreement, and semantic disagreement. A paired
   direction disagreement invalidates measurement; it is not a Skill failure.
3. Use one verification level:
   - `not-run` — no behavior run;
   - `inconclusive` — attempted evidence cannot support the claim;
   - `behavior-verified` — candidate assertions passed without a baseline;
   - `regression-verified` — paired baseline completed and declared objectives
     did not regress.
4. Keep design scores, static facts, runtime evidence, and release decision as
   separate axes. None may average away another axis's blocker.
5. Project `dashboard-data.json` for inspection, but cite retained JSON/output
   paths as the evidence of record.

The lead-supplied execution profile defines the intended executor surface. The
validated harness dispatch receipt plus artifact, assignment, and input
identity bind the observed execution cell. Worker-supplied identity/build
metadata is outside the accepted evidence schema, and a receipt is still only
as strong as its trusted harness boundary.

A public audit is calibration-only even if every case passes. Report its
`release_eligible: false` limitation and do not advance to release without a
trusted opaque holdout pack.
