# Action Center and lead-Agent handoff

Use this reference whenever a review/evolution run is presented in the
Dashboard or a human requests a next step from that Dashboard.

## Boundary

The Action Center has two planes:

| Plane | Authority | Storage |
|---|---|---|
| evidence | read, explain, cite | immutable run workspace |
| Agent handoff | append a bounded, recoverable work intent | external local ledger |

The React control plane runs only on the user's loopback interface. The
installed Skill contains a small content-addressed manifest and launcher, not
the React source or build. An explicit Dashboard request or an affirmative
structured consent answer authorizes the launcher to anonymously download the
pinned GitHub Release archive. It verifies both archive and extracted-tree
digests, safely extracts it under a private OS temporary directory, and serves
UI, immutable read model, digest-bound sidecars, and bounded action-task gateway
from one origin. No credential, run id, evidence, or prompt is sent to the
archive host, and GitHub Pages is not used.

The local service must reject a non-loopback Host, a mismatched Origin,
cross-site Fetch Metadata, and a missing or stale process-lifetime capability.
Every response is `no-store`; evidence routes remain read-only. The one POST
route appends a recoverable lead-Agent handoff outside the run workspace. It
does not deliver work to an Agent session and does not make the browser an
execution authority.

## Run connection lifecycle

The control plane is optional. One interactive Eval run owns at most one
Dashboard session:

1. The lead Agent compiles and locks the run before any worker executes.
2. The lead Agent resolves consent once. A current-request instruction to open
   the Dashboard is already consent; an explicit refusal skips it. Otherwise an
   interactive host uses a standalone structured question with `打开控制面（推荐）`
   and `不打开`, then waits. The question must not be embedded in a progress
   update, and silence must not be converted into either answer.
3. The lead Agent starts `start_skill_dashboard.py` with
   `--user-approved-control-plane` as a managed foreground process. The flag is
   only a record of consent from the current request or structured answer;
   without it, the launcher exits before download. It projects the initial read
   model, materializes the digest-pinned UI, binds one loopback origin, and prints a
   `skill-reviewer.dashboard-session` record.
4. The launcher opens a local URL. Its fragment contains only an unguessable
   process-lifetime capability; the page reads run identity from the
   authenticated local session contract.
5. Candidate, baseline, and nested Eval workers write only their bound traces
   and artifacts. They never own or restart the Dashboard server.
6. The projector refreshes retained evidence in place. Human-boundary actions
   append a local handoff outside the evidence workspace. The Dashboard does
   not deliver it to, address, or wake an Agent session.
7. Stopping the launcher closes the service, invalidates the capability, and
   deletes the temporary UI. No remote service can recover local evidence.

An explicit no, a non-interactive/headless environment, task termination before
consent, or download failure produces no control plane; it does not invalidate
retained Eval evidence. Silence is absence of authority, not a recorded refusal.
Report the observability gap rather than inventing evidence. `--prepare-only`
validates projection without a UI download. `--ui-dir` is an explicit trusted
local/offline override and is not deleted by the launcher.

Do not create one server per case, arm, repeat, or worker. Those are evidence
cells under one run-level control plane. For a new immutable run or evolution
round, create a new session URL and preserve the earlier run's evidence rather
than rebinding the old URL to a different run.

An action button MUST NOT edit `evals.json`, an execution plan, retained
artifacts, grading evidence, acceptance decisions, evolution state, or
`dashboard-data.json`. It saves a durable local handoff whose logical owner is
the lead Agent. It does **not** create work inside an existing Codex/Claude/other
host session and cannot send that session a prompt. The reviewer must return to
the current Agent task or paste the generated recovery instruction into a new
one. The receiving lead Agent must re-read the authoritative artifacts and
verify the state-machine precondition before doing any work.

## Agent-session and recovery boundary

The portable Skill has no trusted host API for addressing an already-running
Agent session. A loopback HTTP server cannot infer that a Codex task is alive,
cannot obtain a thread capability, and must never spawn a new privileged Agent
merely because a browser button was clicked. Therefore the current contract is
explicitly `durable_local_ledger` with:

- `agent_session_state: unbound`;
- `can_wake_agent_session: false`;
- `persists_after_agent_session_end: true`.

“Saved” and “delivered” are different states. A successful POST means only that
the digest-bound record exists on local disk. The UI labels it “awaiting Agent”
and offers a recovery instruction containing task/run/action/digest references
and the local ledger location. It must never display “Agent received”,
“running”, or “completed” without a real host adapter and an independently
authenticated acknowledgement protocol.

Repeated clicks for the same run, Dashboard digest, `next_action`, action, and
ordered evidence references return the existing handoff instead of appending a
duplicate. If the Dashboard digest or `next_action` changes, the UI marks the
older record as requiring revalidation rather than claiming it completed.

If the Agent task ends while the local server is still alive, the handoff can be
copied into a new task. If the launcher also exits, the browser becomes read-only
and cannot save new work; already written records remain under `--task-root`.
Restarting with the same run and task root restores that audit history. Recovery
is possible only while that local directory still exists; temporary-directory
cleanup or manual deletion is intentionally terminal.

## Projection contract

`project-dashboard` projects `action_center` from validated state and retained
decisions. The UI must not infer or overwrite these fields:

`run.release_eligible` and `review.decision.release_eligible` are
decision-level projections. They are true only for the current run when its
validated decision has `phase: audit`, `status: accepted`, `accepted: true`,
and decision-owned `release_eligible: true`. The similarly named field on
verification evidence records an opaque-audit evidence precondition; it cannot
make the Dashboard release-ready before a bound acceptance decision exists.

- `next_action`: exact value from `evolution-state.json`; without validated
  state, use `review_evidence` and do not expose state-changing tasks.
- `continuation`: explicit `automatic`, `human_required`, or `stopped` mode.
  Automatic means the lead Agent continues in the current task without a
  Dashboard click; human-required identifies a real authority or release
  boundary.
- `acceptance.criteria`: hard gates, Pareto admissibility, and material primary
  improvement. Selection accepts a candidate only when all three are true.
- `attribution`: deterministic signals grouped into Skill, Eval, execution
  environment, missing evidence, and human decision.
- `actions`: availability, recommendation, `execution_mode`, and
  `requestable` derived from `next_action`. The server rejects a browser request
  for any automatic action even if a client fabricates one.
- `task_gateway`: separate request and audit-log endpoints; both declare
  `evidence_mutation: false` and `eval_mutation: false`.

The same command projects a required `review` read model for the Dashboard's
default human-facing view. It is derived from, but does not replace, the
immutable `spine`:

- `review.decision` answers whether release is ready, blocked, awaiting audit,
  or still lacks a complete decision.
- `review.blockers` groups one independent blocker per scenario. A failed
  scenario and its failed gate are one causal problem, not two work items.
- Failed Pareto or material-improvement conditions are separate candidate-level
  blockers. The failed hard-gate aggregate is not duplicated when its failed
  scenario/gate chain is already present.
- Each blocker orders its references as scenario → failed release requirement
  → failed candidate observation → source artifact.
- Case-scoped gate nodes carry `case_id` and use the case node as `parent_id`;
  serialized array position is never a substitute for this parent graph.
- The projector indexes spine nodes by `parent_id` once. For `V` nodes and `C`
  cases, review projection is `O(V + C)` time with `O(V)` auxiliary references;
  do not rescan all `V` nodes inside every case on the live-refresh path.
- Candidate acceptance criteria remain visible together: hard gates, Pareto
  admissibility, and material improvement.
- The complete `spine` is a secondary audit archive for reproduction. Reviewers
  should not need to expand it to understand the release conclusion.

The Agent Trace view also keeps declared configuration separate from observed
execution provenance. `run.execution_profile` says which provider/harness was
intended. A native-subagent, local-process, or external-harness label requires
the selected execution's validated, profile-matching `dispatch` descriptor;
otherwise the UI says only that the profile was declared. Every profile that
declares a source stream additionally exposes whether the digest-bound,
adapter-and-format-matching `source_trace` descriptor validated. The client
does not parse provider formats or keep a provider allowlist. Neither field
creates a new grade or upgrades missing evidence. The normative adapter
boundary is `agent-trace-contract.md`.

Review Overview is the single primary verdict surface. Its decision-evidence
spine routes a reviewer to immutable change evidence, observed execution
coverage, and the primary risk in at most two interactions. Diff, Agent Trace,
and the audit archive remain separate evidence views. The Action Center opens
as a side drawer from Review Overview rather than as a competing verdict page;
the Inspector renders only the currently selected evidence. None of these
views is an independent acceptance engine.

`project-dashboard` emits `schema_version: 2`. The client validates every item
in current decision-bearing nested collections before rendering, migrates only
structurally complete unversioned projections, and never fabricates evidence
to make legacy data pass. Fractional versions and versions without a registered
migration are rejected. Unsupported or incomplete projections produce a
regeneration page; an Error Boundary covers unexpected render failures.
Execution evidence uses a discriminated diagnostic shape: `valid: true`
requires the complete receipt/source/Trace contract, while `valid: false`
allows bounded null diagnostic fields so the UI can show the evidence gap
instead of rejecting the entire projection. Counts are non-negative integers,
repeat numbers are positive integers, and pass rates stay in `[0, 1]`.
Projection validation also enforces decision-bearing relationships: summary
counts match their source collections, query and round counters stay within
their locked limits, stateful query accounting matches candidate lineage,
lineage parents stay anchored to the accepted baseline rather than a rejected
candidate, execution repeats are unique and within the case plan,
and every `valid: true` Trace event remains bound to the run/case/arm/repeat
identity with contiguous sequence, monotonic time, and matching lifecycle
boundaries. A `valid: true` dispatch must match the declared execution profile
and its expected observation mode. Trace details are recursively checked for
private-reasoning keys before any verified event can be rendered.

Trace presentation is anomaly-first. Failed checks, failed events, evidence
gaps, and candidate/baseline differences are aggregated in one pass. The robust
slow-execution threshold sorts retained durations to compute their median, so
the complete summary is `O(E log E + A)` time: `E` executions and `A` observed
events plus assertion groups. Business failures outrank evidence gaps, which
outrank candidate/baseline differences and slow executions. Slow execution uses
twice the median retained duration, with a 1-second floor and 5-second cap.
Lifecycle completion, business result, and evidence quality remain orthogonal;
completion alone is neutral, never green.

## Failure attribution

Attribution is a routing aid, not a new acceptance score:

| Category | Examples | Normal owner |
|---|---|---|
| Skill | required assertion failure, unsafe behavior, objective regression, no material improvement | candidate author / lead Agent |
| Eval | declared objective cannot be measured, metric contract missing | eval maintainer, after user confirmation |
| execution environment | bound input mismatch or harness/runtime failure | lead Agent / executor maintainer |
| evidence | missing candidate or paired-baseline artifacts | lead Agent reruns the authorized plan |
| human | Eval/threshold change, permission or scope expansion, irreducible ambiguity, final release/publish decision | user/reviewer |

Prefer concrete retained signals. Do not assign Eval blame merely because a
candidate failed. Do not call an incomplete or unbound run a Skill regression.
When multiple categories contribute, expose one primary category plus all
contributing categories.

## Action mapping

| State-machine `next_action` | Recommended task | Permission effect |
|---|---|---|
| `propose_candidate` | `generate_candidate` (automatic) | none; the lead Agent proposes the next isolated candidate |
| `prepare_audit` | `prepare_audit` (automatic) | none; compiles and binds the exact one-shot plan inside locked authority |
| `run_authorized_selection` | `rerun_execution` (automatic) | none; consumes a query binding already present in state |
| `run_authorized_audit` | `rerun_execution` (automatic) | none; consumes the one-shot query binding already present in state |
| `request_user_release` | `request_release_confirmation` | none; creates a human-decision request, not release |
| `stop` | no automatic continuation | none |

An opaque or one-shot audit is not itself a permission boundary. The exact
audit plan still uses `evolution-authorize` internally because the runtime must
bind run/round/authority and prevent replay; that command is a machine control,
not human consent. If the audit would change Eval authority, execution-profile
digest, permissions, dependency surface, or task scope, stop before binding and
ask for that specific expansion.

`propose_eval_change` may be available for rejected, inconclusive, or no-change
selection evidence only when retained signals identify an Eval-design problem.
Do not offer it merely because a candidate failed. It only asks for a proposal.
Applying that proposal needs explicit user confirmation, a new frozen eval
identity, and a new evaluation cycle. Never mutate the current eval in place.

## Task request protocol

Only requestable human-boundary actions use the browser protocol. The browser
sends only:

```json
{
  "contract": "skill-reviewer.dashboard-action-request",
  "run_id": "run-...",
  "action_id": "request_release_confirmation",
  "expected_next_action": "request_user_release",
  "evidence_ids": ["case:..."],
  "idempotency_key": "..."
}
```

The local server must reject unknown fields, unknown or substituted evidence
IDs, unavailable actions, stale `run_id`/`expected_next_action`, cross-origin
requests, oversized bodies, automatic/non-requestable actions, and reused
idempotency keys for different actions.
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
- `awaiting_agent` status, durable-local-ledger delivery, and an explicit null
  Agent session identity;
- previous task digest and current task digest.

The local digest chain is auditable but remains a local/trusted anchor. Do not
claim it prevents a same-owner rewrite without an external append-only anchor.

## Lead-Agent consumption

When the user pastes a recovery instruction or asks to continue from a
Dashboard handoff, the current or new lead Agent must:

1. Read the task record and verify its digest chain.
2. Re-read the referenced run state and evidence; do not trust UI text alone.
3. Confirm that `run_id`, Dashboard digest, and `expected_next_action` are still
   current. If stale, stop and explain the newer state.
4. Enforce the action-specific authority boundary:
   - an eval-change task may draft a proposal only;
   - applying an Eval change, widening authority, and release remain user
     decisions.
5. Dispatch worker/subagents only when the host supports them and only for the
   real scenario work; the runtime itself stays agent-agnostic.
6. Retain new evidence and advance the canonical state machine through its
   existing commands. Never mark the task itself as evidence of success.

The receiving Agent must not claim the handoff was automatically dispatched.
If the record cannot be found because the local ledger was removed, report that
the handoff cannot be recovered and reconstruct intent from authoritative run
state only after the user confirms.

## Human review order

The Action Center should answer these questions in order:

1. Can this candidate be accepted, and which of the three conditions failed?
2. Who owns the blocker, and what retained signal supports that attribution?
3. What does the canonical state machine say should happen next?
4. Does the proposed handoff request work, authorization, or only a human decision?
5. Which immutable evidence records will the lead Agent receive as context?
6. Has an Agent really acknowledged it, or is it only saved locally?

If any answer is absent, keep the action unavailable and return to the evidence
chain instead of guessing.

## End-to-end intervention rule

The normal evolution loop is automatic from the first locked selection through
the one-shot audit. Human intervention is exceptional and must name the exact
boundary:

- **Agent runs:** static/package checks, candidate edits in a fresh workspace,
  locked Eval cases and repeats, deterministic assertions, semantic Judge,
  Pareto/material-improvement decision, audit plan binding/execution, evidence
  retention, and state projection.
- **Human decides:** a changed Eval/baseline/threshold/grader, new permission,
  network/secret/dependency/cost/scope, ambiguity the frozen contract cannot
  resolve, or final publish/deploy/external side effect.

The Dashboard is not a scheduler. For an automatic state it displays what the
lead Agent is doing and never asks the reviewer to manufacture a task. For a
human-required state it can append one audited request, but the current Agent
still revalidates and performs any resulting work.
