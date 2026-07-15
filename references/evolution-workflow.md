# Bounded Skill Evolution

Read this file only when the user explicitly asks `skill-reviewer` to improve,
evolve, or iterate the reviewed skill. A full review may automatically execute
valid declared evals, but it must not silently enter edit mode.

## Objective

Produce a candidate skill that passes every hard gate, does not regress on any
declared objective, and materially improves at least one primary objective.
Stop after three selection rounds. Run the audit once. Keep the user in
control of eval changes, permission expansion, and new dependencies.

## Strict role separation

One agent may perform multiple roles sequentially only when the environment
lacks enough workers, but artifacts and prompts remain separated:

1. **Lead release decider** freezes inputs, dispatches work, and owns the final
   review and release recommendation.
2. **Optimizer** reads the current skill plus development evidence and proposes
   a candidate. It cannot see audit cases or grade itself.
3. **Executor** runs an assigned case/arm/repeat in an isolated workspace. It
   cannot edit the skill, evals, fixtures, snapshots, or grader.
4. **Deterministic grader** applies the manifest assertion registry to retained
   artifacts.
5. **Semantic grader** receives anonymized paired outputs, judges both A/B
   orders under the frozen contract, and returns only anonymous winners. The
   lead owns the mapped, digest-bound semantic judgment artifact.

Do not use worker voting as a release decision.

## Mutable and immutable surfaces

The optimizer may restructure the whole candidate package: `SKILL.md`,
`references/`, `scripts/`, and `assets/`. There is no artificial line-count or
diff-size limit; a skill may need an architectural rewrite.

The following stay frozen for the whole evolution run:

- selection/audit cases, their fixtures, and shared manifest defaults;
- deterministic and semantic grader contracts;
- accepted baseline digest;
- external execution-profile digest;
- selection and audit outputs from earlier rounds.

Development cases and fixtures form a separately digested surrogate surface.
They may evolve between rounds to improve diagnosis, but cannot modify or
replace authoritative selection/audit cases. Every new development digest is
retained in its compiled plan. This separation combines CoEvoSkills-style
surrogate evolution with a frozen release oracle.

An architecture-scale rewrite is allowed, but it deliberately leaves
SkillOpt's bounded-edit continuity regime. Every candidate is evaluated as a
branch from the accepted baseline; a rejected candidate can inform the typed
optimizer buffer but can never become a parent. For later rounds, any added or
removed runtime path is mechanically classified as a topology change and must
use `continuity: reset`. Content-only architectural changes cannot be inferred
reliably from a tree diff, so the lead must also mark those as reset. The
control state increments its continuity epoch and clears the active optimizer
rejected buffer whose meaning depended on adjacent candidates; historical
rejection records remain available for audit. Do not use diff size as a release
gate.

If an eval is wrong, the optimizer writes an eval-change proposal with reason,
expected effect, and affected cases. Do not apply it in the current run. Ask the
user to confirm, then start a new run with a new lock. Likewise, ask before
adding an external dependency, enabling network access, or widening external
permissions.

## State machine

Initialize once:

```bash
python3 scripts/skill_eval_runtime.py evolution-init \
  --plan <round-1-selection-workspace>/execution-plan.json \
  --workspace <evolution-control-workspace>
```

The control workspace must be fresh, empty, and outside both candidate and
accepted baseline packages. It is never the same directory as a run workspace.

`evolution-state.json` is a derived projection. Each accepted transition is
first appended as a digest-chained, read-only record under `transitions/`; if a
process stops between the append and state replacement, the next advance
reconstructs state from that journal. The canonical state path and journal are
never exposed as executor-readable or writable paths.

This is a local orchestrator control, not a remote transparency log. It detects
partial state rollback while the control workspace remains trusted, but the
same OS owner can copy or delete the whole state+journal directory. Claims that
the three-round limit or audit is adversarially non-replayable therefore need
an external append-only anchor controlled outside that owner. Without one,
report `control anchor: local/trusted` and interpret “one-shot” as workflow
enforcement by the trusted lead, not a cryptographic guarantee.

The state pins authoritative eval/grader identity, accepted baseline, and the
execution-profile digest, not one candidate `run_id`. Each candidate round and
the audit use a fresh, empty run workspace and may have a different run ID.
`evolution-advance` verifies their authority/profile, query authorization, and
lineage before accepting a transition.

Initialization authorizes the round-1 selection plan. Every later selection
query and the only audit query must be authorized explicitly before dispatch.
The exact authorized plan/run/round can be consumed only once. Selection query
count is limited to three; audit query count is limited to one.

For each selection round:

1. Optimizer creates an isolated candidate package from the accepted baseline,
   using typed development feedback and the current-epoch rejected buffer as
   evidence rather than treating a rejected candidate as a parent.
2. Lead compiles and runs a targeted development screen plus safety gates.
3. If the screen is viable, lead compiles the full selection split in a fresh
   workspace using the same external execution profile.
4. For round 1, `evolution-init` already authorized that plan. For later rounds,
   authorize the exact plan, accepted-baseline parent digest, supporting training traces, and
   continuity before launching selection workers:

```bash
python3 scripts/skill_eval_runtime.py evolution-authorize \
  --state <evolution-control-workspace>/evolution-state.json \
  --plan <round-N-selection-workspace>/execution-plan.json \
  --parent-digest <accepted-baseline-sha256> \
  --training-trace <development-trace-id> \
  --continuity continue
```

For a topology or architecture rewrite, keep the accepted baseline digest and
use `--continuity reset` instead. Added or removed runtime paths are rejected
without it; there is no diff-size threshold.

5. Deterministic assertions run first; semantic comparisons supplement them.
6. Lead creates a `selection` acceptance decision and advances the state:

```bash
python3 scripts/skill_eval_runtime.py evolution-advance \
  --state <evolution-control-workspace>/evolution-state.json \
  --decision <round-1-selection-workspace>/iteration-1/acceptance-decision.json
```

The acceptance rule is conjunctive:

- all required candidate assertions pass;
- no forbidden action or integrity failure occurs;
- every paired baseline is complete;
- every objective is within its non-regression tolerance;
- at least one `primary: true` objective reaches `min_material_delta`;
- evidence is not `inconclusive`.

Averages cannot mask a failed hard gate or a regressed objective. A stochastic
direction disagreement is `inconclusive` even if its arithmetic mean improves.

After a rejected, no-change, or inconclusive selection decision, the lineage
records parent/candidate digest, tree-change digest, trace IDs, continuity epoch,
plan, and decision. The rejected candidate does not become an active parent.
Feed only typed development feedback and the allowed aggregate selection result
into the optimizer; never leak hidden assertions or opaque source paths. Advance
to the next round until round three. At round three, stop as `exhausted`; do not
ask for an unbounded fourth attempt.

## One-shot audit

When selection accepts a candidate, state becomes `awaiting-audit`. Compile the
audit split with an opaque holdout pack outside protected roots, then authorize
the exact plan before dispatch:

```bash
python3 scripts/skill_eval_runtime.py evolution-authorize \
  --state <evolution-control-workspace>/evolution-state.json \
  --plan <audit-workspace>/execution-plan.json
```

Run candidate / accepted baseline / without-skill where applicable. The audit
decision needs hard gates and Pareto non-regression but does not demand another
material delta; selection already established it.

- Audit acceptance moves the behavioral state to `audit-passed` with
  `next_action: request_user_release`.
- Audit rejection or inconclusive evidence moves state to `audit-failed`.
- Either result is terminal.
- Never reveal audit cases or failures to the optimizer for another patch.

This preserves the audit as a one-shot generalization check instead of another
training prompt. An audit fixture committed in the skill package is public,
not a true hidden holdout. Public audit evidence is explicitly
`public-calibration` and release-ineligible. An opaque manifest contains only
the public case identity and `asset_id`; prompt, logical files, assertions, and
objectives are resolved from a trusted external pack. `audit-passed` means the
behavioral gates are release-eligible, not that the package has been published
or approved. The lead still combines static/package/permission gates and asks
the user for the final release decision.

## Stop conditions

Stop immediately when any of these occurs:

- candidate passes selection and the one-shot audit;
- audit fails or is inconclusive;
- three selection rounds are exhausted;
- safety or permission expansion needs user authority;
- the optimizer proposes changing frozen eval assets;
- evidence integrity fails and inputs must be recompiled;
- the user cancels or changes scope.

Retain every candidate digest, plan, run lock, execution artifact, grading,
decision, and state transition. Project them into `dashboard-data.json`; do not
replace the evidence files with a dashboard screenshot.

When the control state is outside the current run workspace, pass it explicitly
so the Dashboard timeline can join decisions across candidate run IDs:

```bash
python3 scripts/skill_eval_runtime.py project-dashboard \
  --workspace <current-run-workspace> \
  --state <evolution-control-workspace>/evolution-state.json \
  --output <current-run-workspace>/dashboard-data.json
```

Projection verifies the state authority and baseline, every retained decision
digest, the bound plan/evidence behind each decision, and the complete state
transition sequence. Gates shown for the current run come only from a decision
with the latest journal run ID; older rounds remain timeline history, not
current evidence. Projection performs fresh grading in memory and writes only
the canonical `dashboard-data.json` read model.
