# Action Center and lead-Agent handoff

Use this reference whenever a review/evolution run is presented in the
Dashboard or a human requests a next step from that Dashboard.

## Boundary

The Action Center has two planes:

| Plane | Authority | Storage |
|---|---|---|
| evidence | read, explain, cite | immutable run workspace |
| action request | append a bounded task intent | external task ledger |

An action button MUST NOT edit `evals.json`, an execution plan, retained
artifacts, grading evidence, acceptance decisions, evolution state, or
`dashboard-data.json`. It creates a task owned by the lead Agent. The lead
Agent must re-read the authoritative artifacts and verify the state-machine
precondition before doing any work.

## Projection contract

`project-dashboard` projects `action_center` from validated state and retained
decisions. The UI must not infer or overwrite these fields:

- `next_action`: exact value from `evolution-state.json`; without validated
  state, use `review_evidence` and do not expose state-changing tasks.
- `acceptance.criteria`: hard gates, Pareto admissibility, and material primary
  improvement. Selection accepts a candidate only when all three are true.
- `attribution`: deterministic signals grouped into Skill, Eval, execution
  environment, missing evidence, and human decision.
- `actions`: availability and recommendation derived from `next_action`.
- `task_gateway`: separate request and audit-log endpoints; both declare
  `evidence_mutation: false` and `eval_mutation: false`.

The Action Center explains conclusions; it is not a second grader.

## Failure attribution

Attribution is a routing aid, not a new acceptance score:

| Category | Examples | Normal owner |
|---|---|---|
| Skill | required assertion failure, unsafe behavior, objective regression, no material improvement | candidate author / lead Agent |
| Eval | declared objective cannot be measured, metric contract missing | eval maintainer, after user confirmation |
| execution environment | bound input mismatch or harness/runtime failure | lead Agent / executor maintainer |
| evidence | missing candidate or paired-baseline artifacts | lead Agent reruns the authorized plan |
| human | audit authorization or final release confirmation | user/reviewer |

Prefer concrete retained signals. Do not assign Eval blame merely because a
candidate failed. Do not call an incomplete or unbound run a Skill regression.
When multiple categories contribute, expose one primary category plus all
contributing categories.

## Action mapping

| State-machine `next_action` | Recommended task | Permission effect |
|---|---|---|
| `propose_candidate` | `generate_candidate` | none; asks the lead Agent to propose a candidate |
| `run_authorized_selection` | `rerun_execution` | none; consumes an authorization already present in state |
| `run_authorized_audit` | `rerun_execution` | none; consumes the one-shot authorization already present in state |
| `authorize_audit` | `authorize_audit` | none; creates a human-decision request, not authorization |
| `request_user_release` | `request_release_confirmation` | none; creates a human-decision request, not release |
| `stop` | no automatic continuation | none |

`propose_eval_change` may be available for rejected, inconclusive, or no-change
selection evidence only when retained signals identify an Eval-design problem.
Do not offer it merely because a candidate failed. It only asks for a proposal.
Applying that proposal needs explicit user confirmation, a new frozen eval
identity, and a new evaluation cycle. Never mutate the current eval in place.

## Task request protocol

The browser sends only:

```json
{
  "contract": "skill-reviewer.dashboard-action-request",
  "run_id": "run-...",
  "action_id": "generate_candidate",
  "expected_next_action": "propose_candidate",
  "evidence_ids": ["case:..."],
  "idempotency_key": "..."
}
```

The local server must reject unknown fields, unknown or substituted evidence
IDs, unavailable actions, stale `run_id`/`expected_next_action`, cross-origin
requests, oversized bodies, and reused idempotency keys for different actions.
The submitted `evidence_ids` must exactly equal the ordered references projected
for that action; being a valid ID elsewhere in the same run is not sufficient.

Accepted requests become immutable, digest-chained
`skill-reviewer.dashboard-action-task` records outside the run workspace. Each
record binds:

- exact run and Dashboard digest;
- expected state-machine next action;
- bounded evidence references;
- human requester and `lead_agent` owner;
- whether later human confirmation is required;
- previous task digest and current task digest.

The local digest chain is auditable but remains a local/trusted anchor. Do not
claim it prevents a same-owner rewrite without an external append-only anchor.

## Lead-Agent consumption

When the user asks to continue from a Dashboard task, the lead Agent must:

1. Read the task record and verify its digest chain.
2. Re-read the referenced run state and evidence; do not trust UI text alone.
3. Confirm that `run_id`, Dashboard digest, and `expected_next_action` are still
   current. If stale, stop and explain the newer state.
4. Enforce the action-specific authority boundary:
   - candidate generation may edit only a new candidate workspace;
   - execution may run only the already authorized exact plan;
   - an eval-change task may draft a proposal only;
   - audit authorization and release remain user decisions.
5. Dispatch worker/subagents only when the host supports them and only for the
   real scenario work; the runtime itself stays agent-agnostic.
6. Retain new evidence and advance the canonical state machine through its
   existing commands. Never mark the task itself as evidence of success.

## Human review order

The Action Center should answer these questions in order:

1. Can this candidate be accepted, and which of the three conditions failed?
2. Who owns the blocker, and what retained signal supports that attribution?
3. What does the canonical state machine say should happen next?
4. Does the proposed task request work, authorization, or only a human decision?
5. Which immutable evidence records will the lead Agent receive as context?

If any answer is absent, keep the action unavailable and return to the evidence
chain instead of guessing.
