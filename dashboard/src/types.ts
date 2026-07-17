export type EvidenceStatus = string;

export type AgentTraceEventKind =
  | "execution_started"
  | "file_read"
  | "tool_call"
  | "command"
  | "agent_message"
  | "artifact_written"
  | "error"
  | "execution_finished";

export interface AgentTraceEvent {
  contract: "skill-reviewer.agent-trace-event";
  event_id: string;
  run_id: string;
  case_id: string;
  arm: string;
  repeat: number;
  sequence: number;
  occurred_at: string;
  elapsed_ms: number;
  kind: AgentTraceEventKind;
  status: string;
  summary: string;
  details: Record<string, unknown>;
  artifact_refs: string[];
}

export interface AgentExecutionTrace {
  artifact: string;
  digest: string;
  capture_source:
    | "codex_cli_jsonl"
    | "harness_native"
    | "lead_agent_observed";
  complete: boolean;
  valid: boolean;
  event_count: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  events: AgentTraceEvent[];
}

export interface DashboardExecution {
  repeat: number;
  status: string;
  binding_error_count: number;
  execution_digest: string | null;
  artifact_count: number;
  assertions: { passed: number; total: number };
  required_pass_rate: number | null;
  metrics: Record<string, number>;
  trace: AgentExecutionTrace | null;
}

export interface DashboardArm {
  id: string;
  complete: boolean;
  passed: boolean;
  required_pass_rate: number | null;
  forbidden_actions?: string[];
  side_effects?: string[];
  binding_errors?: string[];
  metrics: Record<string, number>;
  assertions: { passed: number; total: number };
  artifact_count: number;
  executions?: DashboardExecution[];
}

export interface DashboardCase {
  id: string;
  purpose?: string | null;
  prompt?: string | null;
  input_files?: string[];
  split: "development" | "selection" | "audit";
  determinism: "deterministic" | "stochastic";
  repeats: number;
  holdout_visibility: "public" | "opaque";
  status: EvidenceStatus;
  regressed: boolean;
  direction_disagreement: boolean;
  missing_objective_metrics: string[];
  arms: DashboardArm[];
  semantic_assertions: Array<{
    id: string;
    status: string;
    passed: boolean;
    preference?: string | null;
    reason?: string | null;
    artifact?: string;
    resolved_winners?: string[];
    source_event_ids?: string[];
  }>;
}

export interface DashboardAssertionRule {
  severity?: string;
  artifact?: string;
  expected?: string | string[];
  pattern?: string;
  rubric?: string;
  inputs?: string[];
}

export interface DashboardAssertionEvidence {
  artifact?: string;
  exists?: boolean;
  missing?: string[];
  unexpected?: string[];
  pattern?: string;
  matched?: boolean;
  [key: string]: unknown;
}

export interface SpineNode {
  id: string;
  kind: "run" | "gate" | "iteration" | "case" | "assertion" | "artifact";
  parent_id: string | null;
  label: string;
  status: EvidenceStatus;
  detail?: string | null;
  case_id?: string | null;
  split?: DashboardCase["split"];
  arm?: string;
  repeat?: number;
  assertion_type?: string;
  assertion_rule?: DashboardAssertionRule;
  assertion_evidence?: DashboardAssertionEvidence;
  path?: string;
  artifact?: string;
  content_url?: string;
  content_digest?: string;
  content_size?: number;
  content_unavailable_reason?: "opaque" | "binary" | "too_large";
}

export interface DashboardEvidenceContent {
  contract: "skill-reviewer.dashboard-evidence";
  node_id: string;
  path: string;
  media_type: string;
  content: string;
  digest: string;
  size: number;
  truncated: boolean;
}

export interface AcceptanceDecision {
  iteration: number;
  phase: "selection" | "audit";
  status: string;
  accepted: boolean;
  artifact?: string;
  hard_gates?: Array<{ id: string; passed: boolean; reason: string }>;
  objectives?: Array<Record<string, unknown>>;
}

export type ActionAttributionId =
  | "skill"
  | "eval"
  | "execution_environment"
  | "evidence"
  | "human";

export type DashboardActionId =
  | "generate_candidate"
  | "prepare_audit"
  | "rerun_execution"
  | "propose_eval_change"
  | "request_release_confirmation";

export interface DashboardAgentHandoff {
  contract: "skill-reviewer.dashboard-agent-handoff";
  mode: "durable_local_ledger";
  agent_session_state: "unbound";
  can_wake_agent_session: false;
  persists_after_agent_session_end: true;
  task_root: string;
}

export interface DashboardActionCenter {
  next_action: string;
  owner: "lead_agent";
  continuation: {
    mode: "automatic" | "human_required" | "stopped";
    owner: "lead_agent" | "human";
    reason:
      | "within_locked_authority"
      | "eval_change_confirmation"
      | "release_confirmation"
      | "evidence_review"
      | "terminal_state";
  };
  acceptance: {
    status: string;
    accepted: boolean | null;
    decision_run_id: string | null;
    criteria: Array<{
      id: "hard_gates" | "pareto" | "material_improvement";
      status: "satisfied" | "failed" | "pending";
      passed: number;
      total: number;
      evidence_ids: string[];
    }>;
  };
  attribution: {
    primary: ActionAttributionId | null;
    items: Array<{
      id: ActionAttributionId;
      status: "primary" | "contributing" | "clear" | "waiting";
      signals: string[];
      evidence_ids: string[];
    }>;
  };
  actions: Array<{
    id: DashboardActionId;
    available: boolean;
    recommended: boolean;
    owner: "lead_agent";
    execution_mode: "automatic" | "request";
    requestable: boolean;
    human_confirmation_required: boolean;
    evidence_ids: string[];
  }>;
  task_gateway: {
    request_endpoint: string;
    audit_endpoint: string;
    evidence_mutation: false;
    eval_mutation: false;
    handoff_mode: "durable_local_ledger";
    can_wake_agent_session: false;
    persists_after_agent_session_end: true;
  };
}

export interface DashboardActionTask {
  contract: "skill-reviewer.dashboard-action-task";
  id: string;
  sequence: number;
  created_at: string;
  run_id: string;
  dashboard_digest: string;
  expected_next_action: string;
  action_id: DashboardActionId;
  owner: "lead_agent";
  requested_by: "human_reviewer";
  status: "awaiting_agent";
  delivery_mode: "durable_local_ledger";
  agent_session_id: null;
  human_confirmation_required: boolean;
  evidence_ids: string[];
  idempotency_key: string;
  previous_digest: string | null;
  digest: string;
}

export interface DashboardActionTaskLog {
  contract: "skill-reviewer.dashboard-action-task-log";
  run_id: string;
  owner: "lead_agent";
  evidence_mutation: false;
  eval_mutation: false;
  current_dashboard_digest: string;
  handoff: DashboardAgentHandoff;
  tasks: DashboardActionTask[];
}

export interface DashboardReviewOutline {
  contract: "skill-reviewer.dashboard-review";
  decision: {
    status: "ready" | "blocked" | "inconclusive";
    reason:
      | "release_conditions_met"
      | "release_gate_failed"
      | "scenario_failed"
      | "candidate_acceptance_failed"
      | "audit_required"
      | "evidence_incomplete";
    release_eligible: boolean;
    blocking_scenario_count: number;
    blocking_gate_count: number;
  };
  blockers: Array<{
    id: string;
    kind: "scenario" | "criterion";
    case_id: string | null;
    status: EvidenceStatus;
    gate_ids: string[];
    failed_check_ids: string[];
    missing_artifact_ids: string[];
    source_evidence_ids: string[];
    criterion_ids: Array<"hard_gates" | "pareto" | "material_improvement">;
    evidence_ids: string[];
    attribution: ActionAttributionId | null;
    next_action: string;
  }>;
  safeguards: {
    passed_gate_ids: string[];
    passed_case_ids: string[];
  };
  scenarios: Array<{
    case_id: string;
    status: EvidenceStatus;
    gate_ids: string[];
    check_ids: string[];
    artifact_ids: string[];
  }>;
  next_action: string;
  attribution: ActionAttributionId | null;
}

export interface DashboardDiff {
  id: string;
  path: string;
  status: "added" | "removed" | "modified";
  old_digest: string | null;
  new_digest: string | null;
  old_size: number;
  new_size: number;
  binary: boolean;
  render_mode: "lazy" | "summary" | "binary";
  content_url: string | null;
  payload_digest: string | null;
  summary?: string | null;
}

export interface DashboardDiffPayload {
  contract: "skill-reviewer.dashboard-diff";
  id: string;
  path: string;
  old_digest: string | null;
  new_digest: string | null;
  old_content: string;
  new_content: string;
}

export interface DashboardData {
  contract: "skill-reviewer.dashboard-data";
  generated_at: string | null;
  refresh_interval_ms: number;
  run: {
    id: string;
    status: EvidenceStatus;
    verification_level: string;
    manifest?: { path: string; digest: string } | null;
    subject?: { path?: string; digest?: string } | null;
    baseline?: { kind?: string; path?: string | null; digest?: string | null } | null;
    splits: DashboardCase["split"][];
    control_anchor?: "local/trusted" | null;
    execution_profile?: {
      target?: string;
      harness?: string;
      capabilities?: string[];
      isolation?: string;
      sampling?: Record<string, unknown>;
      digest?: string;
    } | null;
    holdout?: {
      visibility?: "public" | "opaque";
      issuer?: string | null;
      digest?: string | null;
    } | null;
    evidence_scope: "public-calibration" | "opaque-holdout";
    release_eligible: boolean;
    integrity?: {
      locked?: boolean;
      verified?: boolean;
      run_lock?: string;
      plan_digest?: string;
    } | null;
  };
  summary: {
    case_count: number;
    candidate_passed: number;
    candidate_failed: number;
    hard_gates_passed: number;
    hard_gates_total: number;
    decision_status: string | null;
    current_round: number | null;
    max_rounds: number;
    selection_queries: number;
    audit_queries: number;
    rejected_candidates: number;
    continuity_epoch: number | null;
  };
  evolution: {
    active_query?: {
      phase?: "selection" | "audit";
      round?: number;
      run_id?: string;
      candidate_digest?: string;
      holdout_visibility?: "public" | "opaque";
    } | null;
    selection_query_limit: number;
    audit_query_limit: number;
    candidate_lineage: Array<{
      round?: number;
      run_id?: string;
      parent_digest?: string;
      candidate_digest?: string;
      change?: { added?: string[]; removed?: string[]; modified?: string[] };
      change_digest?: string;
      continuity?: "continue" | "reset";
      continuity_epoch?: number;
      training_trace_ids?: string[];
    }>;
    rejected_candidates: Array<Record<string, unknown>>;
  };
  action_center: DashboardActionCenter;
  review: DashboardReviewOutline;
  cases: DashboardCase[];
  diffs: DashboardDiff[];
  iterations: AcceptanceDecision[];
  spine: SpineNode[];
  limitations: string[];
}
