export const MANIFEST_CONTRACT = "skill-reviewer.evals";
export const PLAN_CONTRACT = "skill-reviewer.execution-plan";
export const RUN_LOCK_CONTRACT = "skill-reviewer.run-lock";
export const VERIFICATION_CONTRACT = "skill-reviewer.verification";
export const ACCEPTANCE_CONTRACT = "skill-reviewer.acceptance-decision";
export const ASSIGNMENT_CONTRACT = "skill-reviewer.executor-assignment";
export const EXECUTION_CONTRACT = "skill-reviewer.executor-execution";
export const DISPATCH_RECEIPT_CONTRACT = "skill-reviewer.dispatch-receipt";
export const TRACE_EVENT_CONTRACT = "skill-reviewer.agent-trace-event";
export const SEMANTIC_JUDGMENT_CONTRACT = "skill-reviewer.semantic-judgment";
export const DASHBOARD_CONTRACT = "skill-reviewer.dashboard-data";
export const DASHBOARD_DIFF_CONTRACT = "skill-reviewer.dashboard-diff";
export const DASHBOARD_SESSION_CONTRACT = "skill-reviewer.dashboard-session";
export const DASHBOARD_LAUNCH_SESSION_CONTRACT = "skill-reviewer.dashboard-launch-session";
export const EVOLUTION_STATE_CONTRACT = "skill-reviewer.evolution-state";
export const EVOLUTION_TRANSITION_CONTRACT = "skill-reviewer.evolution-transition";

export const DETERMINISTIC_ASSERTION_TYPES = new Set([
  "file_exists",
  "text_contains",
  "text_not_contains",
  "text_matches",
  "text_not_matches",
  "json_path",
  "event_absent",
  "digest_equals",
  "numeric_range",
]);
export const SEMANTIC_ASSERTION_TYPES = new Set(["semantic_pair"]);

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}
