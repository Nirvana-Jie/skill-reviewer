export type EvidenceStatus = string;
export type MeasurementStatus = "valid" | "invalid" | "unverified" | "pending";

export interface DashboardOracleValidity {
  status: MeasurementStatus;
  required_text_assertions?: number;
  calibrated_text_assertions?: number;
  checks?: Array<{
    assertion_id: string;
    status: "valid" | "invalid" | "unverified" | "not_applicable";
    pass_example_count: number;
    fail_example_count: number;
    failed_pass_examples: number[];
    failed_fail_examples: number[];
  }>;
  reasons: string[];
}

export interface DashboardSamplingValidity {
  status: MeasurementStatus;
  repeats?: number | null;
  pairing?: string | null;
  source?: string | null;
  direction_disagreement: boolean;
}

export interface DashboardCaseMeasurement {
  status: MeasurementStatus;
  oracle: DashboardOracleValidity;
  sampling: DashboardSamplingValidity;
  reasons: string[];
}

export interface DashboardRunMeasurement {
  status: MeasurementStatus;
  cases: Array<{ case_id: string } & DashboardCaseMeasurement>;
  reasons: string[];
}

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

export type AgentTraceDiagnosticEvent = Record<string, unknown>;

interface ValidAgentExecutionTrace {
  artifact: string;
  digest: string;
  capture_source: string;
  source_trace_required: boolean;
  complete: boolean;
  valid: true;
  event_count: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  events: AgentTraceEvent[];
}

interface InvalidAgentExecutionTrace {
  artifact?: string | null;
  digest?: string | null;
  capture_source?: string | null;
  source_trace_required?: boolean | null;
  complete?: boolean | null;
  valid: false;
  event_count?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  events: AgentTraceDiagnosticEvent[];
}

export type AgentExecutionTrace =
  | ValidAgentExecutionTrace
  | InvalidAgentExecutionTrace;

interface ValidAgentDispatchReceipt {
  artifact: string;
  digest: string;
  valid: true;
  provider: string;
  harness: string;
  observation: "host_dispatch" | "process_spawn" | "external_harness";
  dispatch_id: string;
  worker_id: string;
  batch_id: string;
  dispatched_at: string;
}

interface InvalidAgentDispatchReceipt {
  artifact?: string | null;
  digest?: string | null;
  valid: false;
  provider?: string | null;
  harness?: string | null;
  observation?: "host_dispatch" | "process_spawn" | "external_harness" | null;
  dispatch_id?: string | null;
  worker_id?: string | null;
  batch_id?: string | null;
  dispatched_at?: string | null;
}

export type AgentDispatchReceipt =
  | ValidAgentDispatchReceipt
  | InvalidAgentDispatchReceipt;

interface ValidAgentSourceTrace {
  artifact: string;
  digest: string;
  valid: true;
  adapter: string;
  format: string;
  source_stream_digest: string;
  source_event_count: number;
  retained_event_count: number;
  redaction: "private-reasoning-fields-removed";
  source_agent?: string;
  registry_entry_digest?: string;
  runtime_binding_digest?: string;
  agent_version?: string;
  executable_digest?: string;
  argv_digest?: string;
  parser_id?: string;
  parser_version?: string;
  parser_digest?: string;
  contract_urls?: string[];
  adapter_maturity?: string;
  source_contract_version?: string;
  contract_stability?: string;
  evidence_authority?: string;
}

interface InvalidAgentSourceTrace {
  artifact?: string | null;
  digest?: string | null;
  valid: false;
  adapter?: string | null;
  format?: string | null;
  source_stream_digest?: string | null;
  source_event_count?: number | null;
  retained_event_count?: number | null;
  redaction?: "private-reasoning-fields-removed" | null;
  source_agent?: string | null;
  registry_entry_digest?: string | null;
  runtime_binding_digest?: string | null;
  agent_version?: string | null;
  executable_digest?: string | null;
  argv_digest?: string | null;
  parser_id?: string | null;
  parser_version?: string | null;
  parser_digest?: string | null;
  contract_urls?: string[] | null;
  adapter_maturity?: string | null;
  source_contract_version?: string | null;
  contract_stability?: string | null;
  evidence_authority?: string | null;
}

export type AgentSourceTrace = ValidAgentSourceTrace | InvalidAgentSourceTrace;

export interface DashboardExecution {
  repeat: number;
  status: string;
  binding_error_count: number;
  execution_digest: string | null;
  artifact_count: number;
  assertions: { passed: number; total: number };
  required_pass_rate: number | null;
  metrics: Record<string, number>;
  dispatch?: AgentDispatchReceipt | null;
  source_trace?: AgentSourceTrace | null;
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
  measurement?: DashboardCaseMeasurement;
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

export type DecisionAttributionId =
  | "skill"
  | "eval"
  | "execution_environment"
  | "evidence"
  | "human";

export interface DashboardDecisionSupport {
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
    objectives?: Array<{
      case_id: string;
      id: string;
      metric: string;
      direction: "maximize" | "minimize";
      primary: boolean;
      candidate?: number | null;
      baseline?: number | null;
      delta: number | null;
      paired_deltas: number[];
      delta_min?: number | null;
      delta_max?: number | null;
      repeat_count: number;
      aggregation_policy?: string;
      regression_repeats?: number[];
      material_improvement_repeats?: number[];
      non_regression_tolerance: number;
      min_material_delta: number;
      non_regressed: boolean;
      materially_improved: boolean;
    }>;
    criteria: Array<{
      id: "hard_gates" | "pareto" | "material_improvement";
      status: "satisfied" | "failed" | "pending";
      passed: number;
      total: number;
      evidence_ids: string[];
    }>;
  };
  attribution: {
    primary: DecisionAttributionId | null;
    items: Array<{
      id: DecisionAttributionId;
      status: "primary" | "contributing" | "clear" | "waiting";
      signals: string[];
      evidence_ids: string[];
    }>;
  };
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
      | "measurement_invalid"
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
    attribution: DecisionAttributionId | null;
    next_action: string;
  }>;
  // Retained for external consumers and reproduction tooling; the review
  // screen intentionally leads with blockers rather than passed safeguards.
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
  attribution: DecisionAttributionId | null;
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
  schema_version?: number;
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
      adapter_id?: string | null;
      adapter_binding?: {
        source_agent: string;
        source_format: string;
        source_contract_version: string;
        contract_stability: string;
        official_sources: string[];
        evidence_authority: string;
        implementation_maturity: string;
        executable_version: string;
        registry_entry_digest: string;
      };
      target?: string;
      harness?: string;
      dispatch_observation?: "host_dispatch" | "process_spawn" | "external_harness";
      trace?: {
        capture_source: string;
        source: { artifact: string; format: string } | null;
      };
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
    measurement?: DashboardRunMeasurement;
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
    invalid_experiments?: number;
    continuity_epoch: number | null;
  };
  evolution: {
    active_query?: {
      phase: "selection" | "audit";
      round: number;
      run_id: string;
      candidate_digest: string;
      holdout_visibility: "public" | "opaque" | null;
    } | null;
    selection_query_limit: number;
    audit_query_limit: number;
    candidate_lineage: Array<{
      round: number;
      run_id: string;
      parent_digest: string;
      candidate_digest: string;
      change: { added: string[]; removed: string[]; modified: string[] };
      change_digest: string;
      continuity: "continue" | "reset";
      continuity_epoch: number;
    }>;
    rejected_candidates: Array<Record<string, unknown>>;
    invalid_experiments?: Array<Record<string, unknown>>;
  };
  action_center: DashboardDecisionSupport;
  review: DashboardReviewOutline;
  cases: DashboardCase[];
  diffs: DashboardDiff[];
  spine: SpineNode[];
  limitations: string[];
}
