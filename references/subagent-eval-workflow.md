# Native-Agent Eval Orchestration

Read this workflow for full/readiness reviews that discover a valid executable
manifest, and for explicit behavior or regression verification. Read
`references/executable-evals.md` first for the manifest, assertion, and artifact
contracts. If the user explicitly asks to improve the skill, also read
`references/evolution-workflow.md`.

## Boundary

The lead agent dispatches native subagents. `scripts/skill_eval_runtime.py` is
agent-agnostic: it compiles a plan, verifies locks, grades artifacts, makes a
mechanical acceptance decision, and projects a dashboard read model. It does
not know how to create a worker.

Subagents supply isolated execution evidence. They do not own the final review,
release verdict, skill edits, eval edits, or snapshot updates.

## When to execute

- Full review or production-readiness review: if `evals/evals.json` exists and
  compiles, execute the relevant full verification path unless the user forbids
  runtime work.
- Focused review: execute only when the focus concerns evals, runtime effect, or
  a claim that requires behavioral evidence.
- Explicit static-only / no-subagent request: do not execute; report `not-run`.
- Explicit evolution request: follow the bounded evolution workflow.

An absent manifest is not a defect. An invalid present manifest is a release
blocker and stops before worker launch.

## Lead preflight

1. Read the target `SKILL.md` and every resource needed by the selected cases.
2. Place the workspace outside candidate and baseline directories.
3. Choose `old_skill` for selection/audit revision comparison; development may
   use `without_skill`. Freeze the accepted baseline before candidate edits.
4. Create or select a canonical execution profile outside subject, baseline,
   and run roots. It declares target, harness, capabilities, isolation, and
   sampling. Do not ask a worker to self-attest a version.
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

The lead records failed, timed-out, or interrupted runs in `execution.json` and
retains partial outputs. Never reconstruct a missing output from memory.
Every execution record must bind the run/case/arm/repeat, SHA-256 of its
assignment, execution-profile digest, forbidden actions, side effects, and
digests of every produced declared artifact. A stale or mismatched record is
incomplete evidence.

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
│       │   │   ├── execution.json
│       │   │   └── outputs/...
│       │   └── grading.json
│       ├── old_skill/                 # or without_skill/
│       │   └── repeat-1/...
│       └── semantic/
│           └── <assertion-id>.json
├── verification-evidence.json
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
2. Inspect every incomplete arm, forbidden action, failed `must_pass`
   assertion, direction disagreement, and semantic disagreement.
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

Optional `agent_provenance` may identify the executor surface. Do not request or
gate on a model/subagent version; the lead-supplied execution profile plus
artifact, assignment, and input identity are load-bearing.

A public audit is calibration-only even if every case passes. Report its
`release_eligible: false` limitation and do not advance to release without a
trusted opaque holdout pack.
