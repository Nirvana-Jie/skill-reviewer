# Explicit Verification Workflow

Read this file only after `SKILL.md` selects explicit Verify or Evolve mode.
`SKILL.md` owns mode selection and verification-level semantics; this file owns
only the bounded execution path.

The Runtime is a deep module: the Agent supplies a manifest, subject, baseline,
execution profile, and workspace; the Runtime owns normalization, digests,
calibration, grading, decisions, and Dashboard projection. Use its commands and
retained outputs instead of reproducing schemas in prose.

## 1. Preflight

1. Validate `evals/evals.json` and stop before dispatch on any structural error.
2. Freeze the candidate. Freeze the accepted old Skill when an improvement or
   regression claim is requested.
3. Choose one stage: bounded `development` diagnosis, complete `selection`, or
   one `audit`. Selection and audit require the accepted old Skill.
4. Create a fresh workspace outside candidate and baseline roots.
5. Supply a canonical execution profile outside all three roots. For a
   registered process adapter, declare its exact `adapter_id`, isolation, and
   paired sampling; the compiler derives target, harness, source format, and
   minimum capabilities from the bundled registry. Native hosts declare those
   fields directly.
6. Confirm cost and permissions. Network, secrets, external writes, dependency
   installation, or `danger-full-access` require explicit authority.

Compile one split:

```bash
python3 scripts/skill_eval_runtime.py compile \
  --manifest <skill>/evals/evals.json \
  --subject <candidate> \
  --execution-profile <profile.json> \
  --baseline-kind old_skill \
  --baseline-path <accepted-skill> \
  --split selection \
  --workspace <fresh-workspace>
```

Compilation produces the immutable plan, run lock, sanitized assignments,
answer-key-free Skill snapshots, and isolated inputs. Never edit them in place.

## 2. Execute observed cells

Every `case × arm × repeat` is an independent evidence cell. It must bind:

- the sanitized assignment and execution-profile digest;
- a real harness/Agent dispatch receipt;
- one contiguous, source-neutral `agent-trace.jsonl` without private
  reasoning;
- source events when the profile requires them;
- finalized execution metadata and declared output artifacts.

For a complete local plan backed by an implemented registered adapter:

```bash
node scripts/run_agent_eval.mjs plan \
  --workspace <fresh-workspace>
```

The adapter and any full-access capability must already be authorized and
locked by compilation. Runtime options may assert `--adapter ID`, choose an
equivalent version-pinned executable with `--agent-bin`, or narrow cost and
timeout; they cannot add authority. The first cell freezes those operational
choices in the per-run runtime binding, and every paired cell must match it.
Agent authentication or service failure remains failed evidence; never convert
it into a pass.

Agent children inherit only a minimal safe environment. Use repeatable
`--pass-env NAME` for required non-secret controls and `--credential-env NAME`
for credentials. Never pass a secret through `--pass-env`: declared credential
values are redacted from retained artifacts and any observed leak fails the
cell.

The executor cannot edit the candidate, baseline, manifest, fixtures, grader,
or another cell, and cannot decide release. Candidate and baseline cells start
in the same paired batch when capacity permits.

## 3. Grade the measuring instrument first

Apply the validity chain in order:

1. **Evidence:** identity, locks, receipts, Trace, artifacts, and digests bind.
2. **Measurement:** required text predicates pass positive and negative
   calibration; paired repeats do not point in contradictory directions.
3. **Candidate:** required assertions pass, forbidden effects are absent,
   objectives do not regress, and any required primary delta is material.

An invalid Oracle or contradictory sampling quarantines the experiment and
routes to Eval repair. It does not reject the Skill or consume an evolution
candidate round.

Deterministic assertions run before any semantic comparison. A `semantic_pair`
uses exactly two blind, order-swapped judgments under its frozen task rubric;
disagreement or stale binding cannot support a preference.

## 4. Decide and project

```bash
python3 scripts/skill_eval_runtime.py grade \
  --plan <workspace>/execution-plan.json --workspace <workspace>

python3 scripts/skill_eval_runtime.py decide \
  --plan <workspace>/execution-plan.json \
  --evidence <workspace>/verification-evidence.json \
  --workspace <workspace> --iteration 1 --phase selection

python3 scripts/skill_eval_runtime.py project-dashboard \
  --workspace <workspace> \
  --output <workspace>/dashboard-data.json
```

The decision recomputes authority and grading from retained inputs. Dashboard
projection is a read model, never the evidence of record.

## Dashboard

Start it only after an explicit user request:

```bash
python3 scripts/start_skill_dashboard.py \
  --workspace <workspace> \
  --state <optional-evolution-state.json> \
  --user-approved-control-plane --open
```

The launcher verifies the pinned manifest in
`assets/dashboard-ui-bundle.json`, serves one loopback origin, and keeps run
data local. The Dashboard presents the ordered validity chain and retained
evidence. It cannot change Eval authority, grading, evolution state, or release.
Any saved local handoff must be revalidated by the receiving Agent.

## Completion

Retain the plan, lock, assignments, snapshots, dispatch receipts, source stream
when declared, canonical Traces, executions, outputs, grading, decision, and
projection. Report the strongest level supported by that chain and name any
missing link precisely.
