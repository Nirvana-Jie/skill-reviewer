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
   Three stochastic repeats and three evolution rounds are predeclared
   replicate and cost budgets, not statistical sufficiency claims.
2. Freeze the candidate. Freeze the accepted old Skill when an improvement or
   regression claim is requested.
3. Choose one stage: bounded `development` diagnosis, complete `selection`, or
   one `audit`. Selection and audit require the accepted old Skill.
4. Create a fresh workspace outside candidate and baseline roots.
5. Supply a canonical execution profile outside all three roots. For a
   registered process adapter the complete profile is:

   ```json
   {"adapter_id":"<registry id>","isolation":"local-unattested","sampling":{"mode":"<adapter>-default","paired":true}}
   ```

   `adapter_id` names an implemented registry entry; local dispatch requires
   `isolation: local-unattested`; `sampling` is retained verbatim in the plan.
6. Confirm cost and permissions. Network, secrets, external writes, dependency
   installation, or `danger-full-access` require explicit authority.
7. Compile one split:

```bash
node scripts/skill_eval_runtime.mjs compile \
  --manifest <candidate>/evals/evals.json \
  --subject <candidate> \
  --execution-profile <profile.json> \
  --baseline-kind old_skill \
  --baseline-path <accepted-skill> \
  --split selection \
  --workspace <fresh-workspace>
```

The manifest must be `<candidate>/evals/evals.json`. An opaque `audit` case
declares only `"holdout": {"visibility": "opaque", "asset_id": "<slug>"}`; its
prompt, files, assertions, and objectives come from `--holdout-pack <pack>`:

```json
{"issuer":"<issuer>","assets":{"<slug>":{"prompt":"…","files":{"<logical/path>":"/absolute/source"},"assertions":[...],"objectives":[...]}}}
```

Pack and sources are regular files at absolute paths outside candidate,
baseline, and run roots; every `must_pass` text predicate must calibrate.

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
executable with `--agent-bin`, or narrow cost and timeout; they cannot add
authority. The executable must satisfy the registry's compatible version range;
a version that differs from the canary-verified one runs and is retained as a
limitation. The first cell freezes these operational choices in the per-run
runtime binding, and every paired cell must match it. Agent authentication or
service failure remains failed evidence; never convert it into a pass.

Agent children inherit only a minimal safe environment: repeatable
`--pass-env NAME` for non-secret controls, `--credential-env NAME` for
credentials. Never pass a secret through `--pass-env`; declared credential
values are redacted from retained artifacts and any observed leak fails the cell.

The executor cannot edit the candidate, baseline, manifest, fixtures, grader,
or another cell, and cannot decide release. Candidate and baseline cells start
in one paired batch when capacity permits.

## 3. Grade the measuring instrument first

Apply the validity chain in order:

1. **Evidence:** identity, locks, receipts, Trace, artifacts, digests, and
   paired execution identities and bindings all bind.
2. **Measurement:** required text predicates pass positive and negative
   calibration.
3. **Candidate:** required assertions pass, forbidden effects are absent,
   objectives do not regress, and any required primary delta is material.

An invalid Oracle quarantines the experiment and routes to Eval repair without
consuming an evolution candidate round. Broken pairing/binding or missing
paired metrics instead yield incomplete evidence and an `inconclusive`
selection decision; that decision consumes the round and is journaled under
its distinct `inconclusive` status. Mixed repeat effects are candidate
variability, not an invalid instrument: retain them as a limitation and let
the all-repeat objective gates decide. Invalid measurement does not reject the
Skill.

Calibration examples must exercise the boundary the predicate claims. For a
section-scoped negative assertion, the passing example includes the forbidden
term in an allowed neighboring section and the failing example places it inside
the governed section. If retained output shows that a predicate crosses its
declared container or section, quarantine that run and repair it under a new
authority digest; never edit the candidate to satisfy the mis-scoped predicate.

Deterministic assertions run before any semantic comparison. A `semantic_pair`
uses exactly two blind, order-swapped judgments under its frozen task rubric,
produced by the judge runner after every paired cell executed, before `grade`:

```bash
node scripts/run_semantic_judge.mjs --workspace <workspace> --adapter <id>
```

Disagreement or stale binding cannot support a preference. It is always
supplemental: failure adds a limitation but never weakens complete
deterministic paired evidence or enters the mechanical release gate.

## 4. Decide and project

A `development` run ends at `grade`. `decide` accepts only `--phase selection`
or `--phase audit` against a plan compiled with exactly that split.

```bash
node scripts/skill_eval_runtime.mjs grade \
  --plan <workspace>/execution-plan.json --workspace <workspace>

node scripts/skill_eval_runtime.mjs decide \
  --plan <workspace>/execution-plan.json \
  --evidence <workspace>/verification-evidence.json \
  --workspace <workspace> --iteration 1 --phase selection

node scripts/skill_eval_runtime.mjs project-dashboard \
  --workspace <workspace> \
  --output <workspace>/dashboard-data.json
```

The decision recomputes authority and grading from retained inputs. Dashboard
projection is a read model, never the evidence of record.

## Dashboard

Start it only after an explicit user request:

```bash
node scripts/start_skill_dashboard.mjs \
  --workspace <workspace> \
  --state <optional-evolution-state.json> \
  --user-approved-dashboard --open
```

The launcher verifies the pinned manifest in `assets/dashboard-ui-bundle.json`,
serves one loopback origin, and keeps run data local. The Dashboard presents the
validity chain and retained evidence; it cannot change Eval authority, grading,
evolution state, or release, and exposes no Agent-task ledger or write route.

## Completion

Retain the plan, lock, assignments, snapshots, dispatch receipts, source stream
when declared, canonical Traces, executions, outputs, grading, decision, and
projection. Report the strongest level supported by that chain and name any
missing link precisely.
