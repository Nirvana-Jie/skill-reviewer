export type EvidenceStatus = string;

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
}

export interface DashboardCase {
  id: string;
  purpose?: string | null;
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
  }>;
}

export interface SpineNode {
  id: string;
  kind: "run" | "gate" | "iteration" | "case" | "assertion" | "artifact";
  parent_id: string | null;
  label: string;
  status: EvidenceStatus;
  detail?: string | null;
  split?: DashboardCase["split"];
  arm?: string;
  repeat?: number;
  assertion_type?: string;
  path?: string;
  artifact?: string;
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
  cases: DashboardCase[];
  diffs: DashboardDiff[];
  iterations: AcceptanceDecision[];
  spine: SpineNode[];
  limitations: string[];
}
