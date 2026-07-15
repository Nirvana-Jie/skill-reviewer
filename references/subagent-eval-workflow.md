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
3. Choose `old_skill` for revision comparison or `without_skill` for a new
   skill. Freeze the accepted baseline before candidate edits.
4. Compile the required split. Treat `execution-plan.json` and `run-lock.json`
   as immutable.
5. Check permissions. Default to no network and no writes outside each repeat
   root. Ask before any external dependency or permission expansion.
6. Count runs from case × arm × repeat. Respect the environment concurrency
   limit; batch by configuration when needed.

## Dispatch contract

Start paired configurations in the same lead-agent turn. If there are fewer
worker slots than logical runs, give one worker several repeats for one arm,
but launch candidate and baseline workers together. Use at most three eval
workers concurrently unless the environment explicitly permits more.

Each executor prompt includes:

- exact plan path, run ID, case ID, arm, and repeat numbers;
- immutable candidate or baseline path, or the `without_skill` marker;
- subject/baseline digest and fixture paths from the plan;
- the realistic user prompt, not a paraphrased success criterion;
- exact writable repeat root and required artifact paths;
- declared permissions and timeout;
- assertion IDs to preserve, without telling the worker how to game them;
- only the declared executor input files; never calibration `expected.md`,
  assertion expected values, audit content, or grader references;
- prohibition on editing candidate, baseline, manifest, fixtures, snapshots,
  grader, git state, or another worker directory;
- prohibition on making the overall release decision or recursively invoking
  the complete review/evolution loop.

For `with_skill`, tell the executor to follow the frozen candidate skill. For
`old_skill`, use only the frozen accepted version. For `without_skill`, do not
load either package; solve from the user prompt and provided fixture only.

The lead records failed, timed-out, or interrupted runs in `execution.json` and
retains partial outputs. Never reconstruct a missing output from memory.

Do not hand the executor the full plan when it contains assertion expectations.
Pass a sanitized assignment derived from the locked plan: identity, prompt,
declared input files, permissions, and writable root only. Keep the plan itself
with the lead and graders.

## Workspace

```text
<workspace>/
├── execution-plan.json
├── run-lock.json
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
├── evolution-state.json                # only for explicit evolution
└── dashboard-data.json
```

Generated state never belongs inside the reviewed skill package.

## Semantic grader dispatch

Run deterministic grading first. Only assertions declared `semantic_pair` may
invoke a semantic grader. Give the grader anonymized output A and B plus the
rubric; withhold configuration names, candidate age, and the optimizer's
rationale. Run the same judgment again with A/B order swapped.

The semantic grader writes only the artifact described in
`references/executable-evals.md`. If the resolved winners disagree, retain both
judgments and mark the case `inconclusive`. Do not add a third vote.

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

Optional `agent_provenance` may identify the executor surface. A model or
subagent version is useful context but is not required evidence; artifact and
input identity are load-bearing.
