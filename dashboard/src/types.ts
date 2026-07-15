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

export interface DashboardData {
  schema_version: "skill-reviewer.dashboard-data.v1";
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
  };
  cases: DashboardCase[];
  iterations: AcceptanceDecision[];
  spine: SpineNode[];
  limitations: string[];
}
