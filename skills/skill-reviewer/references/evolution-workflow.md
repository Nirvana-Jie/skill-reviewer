# Bounded Skill Evolution

Read this file only after `verification-workflow.md` and only when the user
explicitly asks to improve an existing Skill.

## Objective

Find a candidate that passes every hard gate, does not regress any declared
objective, materially improves at least one primary objective during selection,
and generalizes in one audit. Stop after three candidate rounds.

## Authority

Freeze for the full run:

- selection and audit cases, fixtures, assertions, objectives, and graders;
- accepted baseline digest;
- execution-profile digest and permissions;
- earlier plans, evidence, decisions, and candidate lineage.

The optimizer may edit the candidate package but cannot edit those authorities
or grade itself. Development cases may improve diagnosis under a separate
digest; they never redefine acceptance.

Continue automatically while authority, permissions, dependencies, cost, and
scope stay fixed. Ask the user only to change one of those inputs or to approve
an external release effect.

## State machine

Initialize a fresh control workspace outside all run and Skill roots:

```bash
python3 scripts/skill_eval_runtime.py evolution-init \
  --plan <round-1-workspace>/execution-plan.json \
  --workspace <control-workspace>
```

For each round:

1. Create a fresh candidate from the accepted baseline. A rejected candidate
   may inform the next proposal but never becomes its parent.
2. Run bounded development diagnosis.
3. Compile the complete selection split in a fresh run workspace.
4. After round one, bind the exact plan before dispatch:

```bash
python3 scripts/skill_eval_runtime.py evolution-authorize \
  --state <control-workspace>/evolution-state.json \
  --plan <round-workspace>/execution-plan.json \
  --parent-digest <accepted-baseline-digest> \
  --training-trace <development-trace-id> \
  --continuity continue
```

Use `--continuity reset` for topology or architecture rewrites. The candidate
still branches from the accepted baseline.

5. Execute, grade, and create the selection decision.
6. Advance only with the retained decision:

```bash
python3 scripts/skill_eval_runtime.py evolution-advance \
  --state <control-workspace>/evolution-state.json \
  --decision <round-workspace>/iteration-1/acceptance-decision.json
```

Selection accepts only when evidence is complete, measurement is valid, every
hard gate passes, all objectives remain within tolerance, and a primary
objective reaches its declared material delta. An average cannot mask a failed
conjunct.

Invalid measurement is recorded separately from candidate rejection. Preserve
the physical query, consume its authorization, propose an Eval change, and stop
the current cycle. Do not advance the round or add the result to the optimizer's
rejection buffer.

## One audit

After selection accepts, compile the complete audit split with an opaque trusted
holdout outside candidate, baseline, and run roots. Bind its exact plan with
`evolution-authorize`, run it once, and never return its cases or failures to the
optimizer.

- Audit acceptance ends behavioral evolution and asks the user for the final
  release decision.
- Audit rejection or unresolved evidence is terminal.
- Public audit fixtures are calibration only and cannot authorize release.

## Stop conditions

Stop when one of these becomes true:

- selection and the one audit pass;
- the audit fails or cannot support a decision;
- three candidate rounds are exhausted;
- measurement needs an Eval change;
- authority, permission, dependency, cost, or scope must expand;
- the user cancels or changes the task.

Retain every candidate digest, authorization, plan, evidence chain, decision,
and transition. Project the current run for Dashboard inspection, but keep the
state journal and retained artifacts as authority.
