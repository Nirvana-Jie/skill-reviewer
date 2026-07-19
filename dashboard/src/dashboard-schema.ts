import type { DashboardData } from "./types";

export const dashboardSchemaVersion = 3 as const;

export class DashboardCompatibilityError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "DashboardCompatibilityError";
    this.path = path;
  }
}

type Validator = (value: unknown, path: string) => void;

const splits = ["development", "selection", "audit"] as const;
const measurementStatuses = ["valid", "invalid", "unverified", "pending"] as const;
const attributionIds = [
  "skill",
  "eval",
  "execution_environment",
  "evidence",
  "human",
] as const;
const forbiddenTraceDetailKeys = new Set([
  "analysis",
  "chain_of_thought",
  "private_reasoning",
  "reasoning",
  "thought",
  "thoughts",
]);

interface RunValidationContext {
  runId: string;
  profileAdapterId?: string;
  profileSourceAgent?: string;
  profileRegistryEntryDigest?: string;
  profileTarget?: string;
  profileHarness?: string;
  profileDispatchObservation?: "host_dispatch" | "process_spawn" | "external_harness";
  profileTraceCaptureSource?: string;
  profileSourceArtifact?: string | null;
  profileSourceFormat?: string | null;
}

interface CaseValidationContext extends RunValidationContext {
  caseId: string;
  repeats: number;
}

interface ArmValidationContext extends CaseValidationContext {
  armId: string;
}

interface TraceValidationContext extends ArmValidationContext {
  repeat: number;
  executionStatus: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DashboardCompatibilityError(path, "expected an object");
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DashboardCompatibilityError(path, "expected an array");
  }
  return value;
}

function requireArrayOf(
  value: unknown,
  path: string,
  validate: Validator,
): unknown[] {
  const items = requireArray(value, path);
  items.forEach((item, index) => validate(item, `${path}[${index}]`));
  return items;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DashboardCompatibilityError(path, "expected a non-empty string");
  }
  return value;
}

function requireStringArray(value: unknown, path: string): void {
  requireArrayOf(value, path, requireString);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new DashboardCompatibilityError(path, "expected a boolean");
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DashboardCompatibilityError(path, "expected a finite number");
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number < 0) {
    throw new DashboardCompatibilityError(path, "expected a non-negative number");
  }
  return number;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  const number = requireNonNegativeNumber(value, path);
  if (!Number.isInteger(number)) {
    throw new DashboardCompatibilityError(path, "expected an integer");
  }
  return number;
}

function requirePositiveInteger(value: unknown, path: string): number {
  const number = requireNonNegativeInteger(value, path);
  if (number < 1) {
    throw new DashboardCompatibilityError(path, "expected a positive integer");
  }
  return number;
}

function requireUnitInterval(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number < 0 || number > 1) {
    throw new DashboardCompatibilityError(path, "expected a number from 0 to 1");
  }
  return number;
}

function requireNullableString(value: unknown, path: string): void {
  if (value !== null) requireString(value, path);
}

function requireNullablePositiveInteger(value: unknown, path: string): void {
  if (value !== null) requirePositiveInteger(value, path);
}

function requireNullableUnitInterval(value: unknown, path: string): void {
  if (value !== null) requireUnitInterval(value, path);
}

function requireNullableBoolean(value: unknown, path: string): void {
  if (value !== null) requireBoolean(value, path);
}

function requireOneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DashboardCompatibilityError(
      path,
      `expected one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function requireLiteral<T extends string | boolean>(
  value: unknown,
  path: string,
  literal: T,
): void {
  if (value !== literal) {
    throw new DashboardCompatibilityError(path, `expected ${String(literal)}`);
  }
}

function requireNumberRecord(value: unknown, path: string): void {
  const record = requireRecord(value, path);
  Object.entries(record).forEach(([key, item]) =>
    requireFiniteNumber(item, `${path}.${key}`),
  );
}

function findForbiddenTraceDetailKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(findForbiddenTraceDetailKeys);
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const normalized = key.trim().toLowerCase().replaceAll("-", "_");
    return [
      ...(forbiddenTraceDetailKeys.has(normalized) ? [key] : []),
      ...findForbiddenTraceDetailKeys(item),
    ];
  });
}

function requirePassedCount(
  value: Record<string, unknown>,
  path: string,
): void {
  const passed = requireNonNegativeInteger(value.passed, `${path}.passed`);
  const total = requireNonNegativeInteger(value.total, `${path}.total`);
  if (passed > total) {
    throw new DashboardCompatibilityError(
      path,
      "passed count must not exceed total count",
    );
  }
}

function validateOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] !== undefined) requireString(record[key], `${path}.${key}`);
}

function validateOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] !== undefined) {
    requireNullableString(record[key], `${path}.${key}`);
  }
}

function validateOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] !== undefined) {
    requireNonNegativeInteger(record[key], `${path}.${key}`);
  }
}

function validateOracleMeasurement(value: unknown, path: string): void {
  const oracle = requireRecord(value, path);
  requireOneOf(oracle.status, `${path}.status`, measurementStatuses);
  for (const key of ["required_text_assertions", "calibrated_text_assertions"]) {
    if (oracle[key] !== undefined) {
      requireNonNegativeInteger(oracle[key], `${path}.${key}`);
    }
  }
  requireStringArray(oracle.reasons, `${path}.reasons`);
  if (oracle.checks !== undefined) {
    requireArrayOf(oracle.checks, `${path}.checks`, (value, checkPath) => {
      const check = requireRecord(value, checkPath);
      requireString(check.assertion_id, `${checkPath}.assertion_id`);
      requireOneOf(check.status, `${checkPath}.status`, [
        "valid",
        "invalid",
        "unverified",
        "not_applicable",
      ] as const);
      for (const key of ["pass_example_count", "fail_example_count"]) {
        requireNonNegativeInteger(check[key], `${checkPath}.${key}`);
      }
      for (const key of ["failed_pass_examples", "failed_fail_examples"]) {
        requireArrayOf(check[key], `${checkPath}.${key}`, (index, indexPath) => {
          requireNonNegativeInteger(index, indexPath);
        });
      }
    });
  }
}

function validateSamplingMeasurement(value: unknown, path: string): void {
  const sampling = requireRecord(value, path);
  requireOneOf(sampling.status, `${path}.status`, measurementStatuses);
  if (sampling.repeats !== undefined && sampling.repeats !== null) {
    requirePositiveInteger(sampling.repeats, `${path}.repeats`);
  }
  for (const key of ["pairing", "source"]) {
    if (sampling[key] !== undefined) {
      requireNullableString(sampling[key], `${path}.${key}`);
    }
  }
  requireBoolean(
    sampling.direction_disagreement,
    `${path}.direction_disagreement`,
  );
}

function validateCaseMeasurement(value: unknown, path: string): void {
  const measurement = requireRecord(value, path);
  requireOneOf(measurement.status, `${path}.status`, measurementStatuses);
  validateOracleMeasurement(measurement.oracle, `${path}.oracle`);
  validateSamplingMeasurement(measurement.sampling, `${path}.sampling`);
  requireStringArray(measurement.reasons, `${path}.reasons`);
}

function validateRunMeasurement(value: unknown, path: string): void {
  const measurement = requireRecord(value, path);
  requireOneOf(measurement.status, `${path}.status`, measurementStatuses);
  requireStringArray(measurement.reasons, `${path}.reasons`);
  requireArrayOf(measurement.cases, `${path}.cases`, (value, casePath) => {
    const item = requireRecord(value, casePath);
    requireString(item.case_id, `${casePath}.case_id`);
    validateCaseMeasurement(item, casePath);
  });
}

function aggregateMeasurementStatus(
  statuses: unknown[],
): (typeof measurementStatuses)[number] {
  if (statuses.includes("invalid")) return "invalid";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("unverified") || statuses.length === 0) {
    return "unverified";
  }
  return "valid";
}

function validateRun(value: unknown, path: string): void {
  const run = requireRecord(value, path);
  requireString(run.id, `${path}.id`);
  requireString(run.status, `${path}.status`);
  requireString(run.verification_level, `${path}.verification_level`);
  requireArrayOf(run.splits, `${path}.splits`, (item, itemPath) => {
    requireOneOf(item, itemPath, splits);
  });
  requireOneOf(run.evidence_scope, `${path}.evidence_scope`, [
    "public-calibration",
    "opaque-holdout",
  ] as const);
  requireBoolean(run.release_eligible, `${path}.release_eligible`);
  validateRunMeasurement(run.measurement, `${path}.measurement`);

  if (run.manifest != null) {
    const manifest = requireRecord(run.manifest, `${path}.manifest`);
    requireString(manifest.path, `${path}.manifest.path`);
    requireString(manifest.digest, `${path}.manifest.digest`);
  }
  if (run.subject != null) {
    const subject = requireRecord(run.subject, `${path}.subject`);
    validateOptionalString(subject, "path", `${path}.subject`);
    validateOptionalString(subject, "digest", `${path}.subject`);
  }
  if (run.baseline != null) {
    const baseline = requireRecord(run.baseline, `${path}.baseline`);
    validateOptionalString(baseline, "kind", `${path}.baseline`);
    validateOptionalNullableString(baseline, "path", `${path}.baseline`);
    validateOptionalNullableString(baseline, "digest", `${path}.baseline`);
  }
  if (run.control_anchor !== undefined && run.control_anchor !== null) {
    requireLiteral(run.control_anchor, `${path}.control_anchor`, "local/trusted");
  }
  if (run.execution_profile != null) {
    const profile = requireRecord(
      run.execution_profile,
      `${path}.execution_profile`,
    );
    validateOptionalNullableString(
      profile,
      "adapter_id",
      `${path}.execution_profile`,
    );
    if (profile.adapter_binding !== undefined) {
      const binding = requireRecord(
        profile.adapter_binding,
        `${path}.execution_profile.adapter_binding`,
      );
      for (const key of [
        "source_agent",
        "source_format",
        "source_contract_version",
        "contract_stability",
        "evidence_authority",
        "implementation_maturity",
        "executable_version",
        "registry_entry_digest",
      ]) {
        requireString(
          binding[key],
          `${path}.execution_profile.adapter_binding.${key}`,
        );
      }
      requireStringArray(
        binding.official_sources,
        `${path}.execution_profile.adapter_binding.official_sources`,
      );
    }
    for (const key of ["target", "harness", "isolation", "digest"]) {
      validateOptionalString(profile, key, `${path}.execution_profile`);
    }
    if (profile.dispatch_observation !== undefined) {
      requireOneOf(
        profile.dispatch_observation,
        `${path}.execution_profile.dispatch_observation`,
        ["host_dispatch", "process_spawn", "external_harness"] as const,
      );
    }
    if (profile.trace !== undefined) {
      const trace = requireRecord(
        profile.trace,
        `${path}.execution_profile.trace`,
      );
      requireString(
        trace.capture_source,
        `${path}.execution_profile.trace.capture_source`,
      );
      if (trace.source !== null) {
        const source = requireRecord(
          trace.source,
          `${path}.execution_profile.trace.source`,
        );
        requireString(
          source.artifact,
          `${path}.execution_profile.trace.source.artifact`,
        );
        requireString(
          source.format,
          `${path}.execution_profile.trace.source.format`,
        );
      }
    }
    if (profile.capabilities !== undefined) {
      requireStringArray(
        profile.capabilities,
        `${path}.execution_profile.capabilities`,
      );
    }
    if (profile.sampling !== undefined) {
      requireRecord(profile.sampling, `${path}.execution_profile.sampling`);
    }
  }
  if (run.holdout != null) {
    const holdout = requireRecord(run.holdout, `${path}.holdout`);
    if (holdout.visibility !== undefined) {
      requireOneOf(holdout.visibility, `${path}.holdout.visibility`, [
        "public",
        "opaque",
      ] as const);
    }
    validateOptionalNullableString(holdout, "issuer", `${path}.holdout`);
    validateOptionalNullableString(holdout, "digest", `${path}.holdout`);
  }
  if (run.integrity != null) {
    const integrity = requireRecord(run.integrity, `${path}.integrity`);
    if (integrity.locked !== undefined) {
      requireBoolean(integrity.locked, `${path}.integrity.locked`);
    }
    if (integrity.verified !== undefined) {
      requireBoolean(integrity.verified, `${path}.integrity.verified`);
    }
    validateOptionalString(integrity, "run_lock", `${path}.integrity`);
    validateOptionalString(integrity, "plan_digest", `${path}.integrity`);
  }
}

function validateSummary(value: unknown, path: string): void {
  const summary = requireRecord(value, path);
  for (const key of [
    "case_count",
    "candidate_passed",
    "candidate_failed",
    "hard_gates_passed",
    "hard_gates_total",
    "selection_queries",
    "audit_queries",
    "rejected_candidates",
    "invalid_experiments",
  ]) {
    requireNonNegativeInteger(summary[key], `${path}.${key}`);
  }
  requirePositiveInteger(summary.max_rounds, `${path}.max_rounds`);
  if (Number(summary.hard_gates_passed) > Number(summary.hard_gates_total)) {
    throw new DashboardCompatibilityError(
      path,
      "hard_gates_passed must not exceed hard_gates_total",
    );
  }
  if (
    Number(summary.candidate_passed) + Number(summary.candidate_failed) >
    Number(summary.case_count)
  ) {
    throw new DashboardCompatibilityError(
      path,
      "candidate result counts must not exceed case_count",
    );
  }
  requireNullableString(summary.decision_status, `${path}.decision_status`);
  requireNullablePositiveInteger(
    summary.current_round,
    `${path}.current_round`,
  );
  requireNullablePositiveInteger(
    summary.continuity_epoch,
    `${path}.continuity_epoch`,
  );
}

function validateEvolution(value: unknown, path: string): void {
  const evolution = requireRecord(value, path);
  requireNonNegativeInteger(
    evolution.selection_query_limit,
    `${path}.selection_query_limit`,
  );
  requireNonNegativeInteger(
    evolution.audit_query_limit,
    `${path}.audit_query_limit`,
  );
  if (evolution.active_query != null) {
    const query = requireRecord(evolution.active_query, `${path}.active_query`);
    requireOneOf(query.phase, `${path}.active_query.phase`, [
      "selection",
      "audit",
    ] as const);
    requirePositiveInteger(query.round, `${path}.active_query.round`);
    requireString(query.run_id, `${path}.active_query.run_id`);
    requireString(
      query.candidate_digest,
      `${path}.active_query.candidate_digest`,
    );
    if (query.holdout_visibility !== null) {
      requireOneOf(
        query.holdout_visibility,
        `${path}.active_query.holdout_visibility`,
        ["public", "opaque"] as const,
      );
    }
  }
  requireArrayOf(
    evolution.candidate_lineage,
    `${path}.candidate_lineage`,
    (item, itemPath) => {
      const lineage = requireRecord(item, itemPath);
      requirePositiveInteger(lineage.round, `${itemPath}.round`);
      for (const key of [
        "run_id",
        "parent_digest",
        "candidate_digest",
        "change_digest",
      ]) {
        requireString(lineage[key], `${itemPath}.${key}`);
      }
      const change = requireRecord(lineage.change, `${itemPath}.change`);
      for (const key of ["added", "removed", "modified"]) {
        requireStringArray(change[key], `${itemPath}.change.${key}`);
      }
      requireOneOf(lineage.continuity, `${itemPath}.continuity`, [
        "continue",
        "reset",
      ] as const);
      requirePositiveInteger(
        lineage.continuity_epoch,
        `${itemPath}.continuity_epoch`,
      );
      requireStringArray(
        lineage.training_trace_ids,
        `${itemPath}.training_trace_ids`,
      );
    },
  );
  requireArrayOf(
    evolution.rejected_candidates,
    `${path}.rejected_candidates`,
    (item, itemPath) => {
      requireRecord(item, itemPath);
    },
  );
  requireArrayOf(
    evolution.invalid_experiments,
    `${path}.invalid_experiments`,
    (item, itemPath) => {
      requireRecord(item, itemPath);
    },
  );
}

function validateActionCenter(value: unknown, path: string): void {
  const actionCenter = requireRecord(value, path);
  requireString(actionCenter.next_action, `${path}.next_action`);
  requireLiteral(actionCenter.owner, `${path}.owner`, "lead_agent");

  const continuation = requireRecord(
    actionCenter.continuation,
    `${path}.continuation`,
  );
  requireOneOf(continuation.mode, `${path}.continuation.mode`, [
    "automatic",
    "human_required",
    "stopped",
  ] as const);
  requireOneOf(continuation.owner, `${path}.continuation.owner`, [
    "lead_agent",
    "human",
  ] as const);
  requireOneOf(continuation.reason, `${path}.continuation.reason`, [
    "within_locked_authority",
    "eval_change_confirmation",
    "release_confirmation",
    "evidence_review",
    "terminal_state",
  ] as const);

  const acceptance = requireRecord(
    actionCenter.acceptance,
    `${path}.acceptance`,
  );
  requireString(acceptance.status, `${path}.acceptance.status`);
  requireNullableBoolean(acceptance.accepted, `${path}.acceptance.accepted`);
  requireNullableString(
    acceptance.decision_run_id,
    `${path}.acceptance.decision_run_id`,
  );
  const acceptanceCriteria = requireArray(
    acceptance.criteria,
    `${path}.acceptance.criteria`,
  );
  requireArrayOf(
    acceptance.criteria,
    `${path}.acceptance.criteria`,
    (item, itemPath) => {
      const criterion = requireRecord(item, itemPath);
      requireOneOf(criterion.id, `${itemPath}.id`, [
        "hard_gates",
        "pareto",
        "material_improvement",
      ] as const);
      requireOneOf(criterion.status, `${itemPath}.status`, [
        "satisfied",
        "failed",
        "pending",
      ] as const);
      requirePassedCount(criterion, itemPath);
      requireStringArray(criterion.evidence_ids, `${itemPath}.evidence_ids`);
    },
  );
  const requiredCriterionIds = [
    "hard_gates",
    "pareto",
    "material_improvement",
  ];
  const criterionIds = acceptanceCriteria.map((item, index) =>
    requireString(
      requireRecord(item, `${path}.acceptance.criteria[${index}]`).id,
      `${path}.acceptance.criteria[${index}].id`,
    ),
  );
  const uniqueCriterionIds = new Set(criterionIds);
  if (
    criterionIds.length !== requiredCriterionIds.length ||
    uniqueCriterionIds.size !== requiredCriterionIds.length ||
    requiredCriterionIds.some((id) => !uniqueCriterionIds.has(id))
  ) {
    throw new DashboardCompatibilityError(
      `${path}.acceptance.criteria`,
      "must contain each required criterion exactly once",
    );
  }

  const attribution = requireRecord(
    actionCenter.attribution,
    `${path}.attribution`,
  );
  if (attribution.primary !== null) {
    requireOneOf(attribution.primary, `${path}.attribution.primary`, attributionIds);
  }
  requireArrayOf(
    attribution.items,
    `${path}.attribution.items`,
    (item, itemPath) => {
      const attributionItem = requireRecord(item, itemPath);
      requireOneOf(attributionItem.id, `${itemPath}.id`, attributionIds);
      requireOneOf(attributionItem.status, `${itemPath}.status`, [
        "primary",
        "contributing",
        "clear",
        "waiting",
      ] as const);
      requireStringArray(attributionItem.signals, `${itemPath}.signals`);
      requireStringArray(attributionItem.evidence_ids, `${itemPath}.evidence_ids`);
    },
  );

  requireArrayOf(actionCenter.actions, `${path}.actions`, (item, itemPath) => {
    const action = requireRecord(item, itemPath);
    requireOneOf(action.id, `${itemPath}.id`, [
      "generate_candidate",
      "prepare_audit",
      "rerun_execution",
      "propose_eval_change",
      "request_release_confirmation",
    ] as const);
    requireBoolean(action.available, `${itemPath}.available`);
    requireBoolean(action.recommended, `${itemPath}.recommended`);
    requireLiteral(action.owner, `${itemPath}.owner`, "lead_agent");
    requireOneOf(action.execution_mode, `${itemPath}.execution_mode`, [
      "automatic",
      "request",
    ] as const);
    requireBoolean(action.requestable, `${itemPath}.requestable`);
    requireBoolean(
      action.human_confirmation_required,
      `${itemPath}.human_confirmation_required`,
    );
    requireStringArray(action.evidence_ids, `${itemPath}.evidence_ids`);
  });

  const gateway = requireRecord(
    actionCenter.task_gateway,
    `${path}.task_gateway`,
  );
  requireString(gateway.request_endpoint, `${path}.task_gateway.request_endpoint`);
  requireString(gateway.audit_endpoint, `${path}.task_gateway.audit_endpoint`);
  requireLiteral(
    gateway.evidence_mutation,
    `${path}.task_gateway.evidence_mutation`,
    false,
  );
  requireLiteral(
    gateway.eval_mutation,
    `${path}.task_gateway.eval_mutation`,
    false,
  );
  requireLiteral(
    gateway.handoff_mode,
    `${path}.task_gateway.handoff_mode`,
    "durable_local_ledger",
  );
  requireLiteral(
    gateway.can_wake_agent_session,
    `${path}.task_gateway.can_wake_agent_session`,
    false,
  );
  requireLiteral(
    gateway.persists_after_agent_session_end,
    `${path}.task_gateway.persists_after_agent_session_end`,
    true,
  );
}

function validateReview(value: unknown, path: string): void {
  const review = requireRecord(value, path);
  requireLiteral(review.contract, `${path}.contract`, "skill-reviewer.dashboard-review");
  const decision = requireRecord(review.decision, `${path}.decision`);
  requireOneOf(decision.status, `${path}.decision.status`, [
    "ready",
    "blocked",
    "inconclusive",
  ] as const);
  requireOneOf(decision.reason, `${path}.decision.reason`, [
    "release_conditions_met",
    "release_gate_failed",
    "scenario_failed",
    "candidate_acceptance_failed",
    "measurement_invalid",
    "audit_required",
    "evidence_incomplete",
  ] as const);
  requireBoolean(decision.release_eligible, `${path}.decision.release_eligible`);
  requireNonNegativeInteger(
    decision.blocking_scenario_count,
    `${path}.decision.blocking_scenario_count`,
  );
  requireNonNegativeInteger(
    decision.blocking_gate_count,
    `${path}.decision.blocking_gate_count`,
  );

  requireArrayOf(review.blockers, `${path}.blockers`, (item, itemPath) => {
    const blocker = requireRecord(item, itemPath);
    requireString(blocker.id, `${itemPath}.id`);
    requireOneOf(blocker.kind, `${itemPath}.kind`, [
      "scenario",
      "criterion",
    ] as const);
    requireNullableString(blocker.case_id, `${itemPath}.case_id`);
    requireString(blocker.status, `${itemPath}.status`);
    for (const key of [
      "gate_ids",
      "failed_check_ids",
      "missing_artifact_ids",
      "source_evidence_ids",
      "evidence_ids",
    ]) {
      requireStringArray(blocker[key], `${itemPath}.${key}`);
    }
    requireArrayOf(
      blocker.criterion_ids,
      `${itemPath}.criterion_ids`,
      (criterion, criterionPath) => {
        requireOneOf(criterion, criterionPath, [
          "hard_gates",
          "pareto",
          "material_improvement",
        ] as const);
      },
    );
    if (blocker.attribution !== null) {
      requireOneOf(blocker.attribution, `${itemPath}.attribution`, attributionIds);
    }
    requireString(blocker.next_action, `${itemPath}.next_action`);
  });

  const safeguards = requireRecord(review.safeguards, `${path}.safeguards`);
  requireStringArray(
    safeguards.passed_gate_ids,
    `${path}.safeguards.passed_gate_ids`,
  );
  requireStringArray(
    safeguards.passed_case_ids,
    `${path}.safeguards.passed_case_ids`,
  );
  requireArrayOf(review.scenarios, `${path}.scenarios`, (item, itemPath) => {
    const scenario = requireRecord(item, itemPath);
    requireString(scenario.case_id, `${itemPath}.case_id`);
    requireString(scenario.status, `${itemPath}.status`);
    for (const key of ["gate_ids", "check_ids", "artifact_ids"]) {
      requireStringArray(scenario[key], `${itemPath}.${key}`);
    }
  });
  requireString(review.next_action, `${path}.next_action`);
  if (review.attribution !== null) {
    requireOneOf(review.attribution, `${path}.attribution`, attributionIds);
  }
}

function validateDispatch(
  value: unknown,
  path: string,
  context: RunValidationContext,
): void {
  const dispatch = requireRecord(value, path);
  const valid = requireBoolean(dispatch.valid, `${path}.valid`);
  if (!valid) {
    for (const key of [
      "artifact",
      "digest",
      "provider",
      "harness",
      "dispatch_id",
      "worker_id",
      "batch_id",
      "dispatched_at",
    ]) {
      if (dispatch[key] !== undefined) {
        requireNullableString(dispatch[key], `${path}.${key}`);
      }
    }
    if (dispatch.observation !== undefined && dispatch.observation !== null) {
      requireOneOf(dispatch.observation, `${path}.observation`, [
        "host_dispatch",
        "process_spawn",
        "external_harness",
      ] as const);
    }
    return;
  }
  for (const key of [
    "artifact",
    "digest",
    "dispatch_id",
    "worker_id",
    "batch_id",
    "dispatched_at",
  ]) {
    requireString(dispatch[key], `${path}.${key}`);
  }
  const provider = requireString(dispatch.provider, `${path}.provider`);
  const harness = requireString(dispatch.harness, `${path}.harness`);
  if (!context.profileTarget || !context.profileHarness) {
    throw new DashboardCompatibilityError(
      path,
      "a valid dispatch requires a declared execution profile",
    );
  }
  if (provider !== context.profileTarget) {
    throw new DashboardCompatibilityError(
      `${path}.provider`,
      "must match run.execution_profile.target",
    );
  }
  if (harness !== context.profileHarness) {
    throw new DashboardCompatibilityError(
      `${path}.harness`,
      "must match run.execution_profile.harness",
    );
  }
  const observation = requireOneOf(dispatch.observation, `${path}.observation`, [
    "host_dispatch",
    "process_spawn",
    "external_harness",
  ] as const);
  const expectedObservation = context.profileDispatchObservation ?? null;
  if (expectedObservation !== null && observation !== expectedObservation) {
    throw new DashboardCompatibilityError(
      `${path}.observation`,
      `expected ${expectedObservation} for the declared execution profile`,
    );
  }
}

function validateSourceTrace(
  value: unknown,
  path: string,
  context: RunValidationContext,
): boolean {
  const source = requireRecord(value, path);
  const valid = requireBoolean(source.valid, `${path}.valid`);
  if (!valid) {
    for (const key of [
      "artifact",
      "digest",
      "adapter",
      "format",
      "source_stream_digest",
      "source_agent",
      "registry_entry_digest",
      "runtime_binding_digest",
      "agent_version",
      "executable_digest",
      "argv_digest",
      "parser_id",
      "parser_version",
      "parser_digest",
      "adapter_maturity",
      "source_contract_version",
      "contract_stability",
      "evidence_authority",
    ]) {
      if (source[key] !== undefined) {
        requireNullableString(source[key], `${path}.${key}`);
      }
    }
    for (const key of ["source_event_count", "retained_event_count"]) {
      if (source[key] !== undefined && source[key] !== null) {
        requireNonNegativeInteger(source[key], `${path}.${key}`);
      }
    }
    if (source.redaction !== undefined && source.redaction !== null) {
      requireLiteral(
        source.redaction,
        `${path}.redaction`,
        "private-reasoning-fields-removed",
      );
    }
    if (source.contract_urls !== undefined && source.contract_urls !== null) {
      requireStringArray(source.contract_urls, `${path}.contract_urls`);
    }
    return false;
  }
  for (const key of [
    "artifact",
    "digest",
    "adapter",
    "format",
    "source_stream_digest",
  ]) {
    requireString(source[key], `${path}.${key}`);
  }
  if (
    context.profileSourceArtifact &&
    source.artifact !== context.profileSourceArtifact
  ) {
    throw new DashboardCompatibilityError(
      `${path}.artifact`,
      "must match run.execution_profile.trace.source.artifact",
    );
  }
  if (
    context.profileAdapterId &&
    source.adapter !== context.profileAdapterId
  ) {
    throw new DashboardCompatibilityError(
      `${path}.adapter`,
      "must match run.execution_profile.adapter_id",
    );
  }
  if (
    context.profileSourceFormat &&
    source.format !== context.profileSourceFormat
  ) {
    throw new DashboardCompatibilityError(
      `${path}.format`,
      "must match run.execution_profile.trace.source.format",
    );
  }
  if (
    context.profileSourceAgent &&
    source.source_agent !== context.profileSourceAgent
  ) {
    throw new DashboardCompatibilityError(
      `${path}.source_agent`,
      "must match run.execution_profile.adapter_binding.source_agent",
    );
  }
  if (
    context.profileRegistryEntryDigest &&
    source.registry_entry_digest !== context.profileRegistryEntryDigest
  ) {
    throw new DashboardCompatibilityError(
      `${path}.registry_entry_digest`,
      "must match run.execution_profile.adapter_binding.registry_entry_digest",
    );
  }
  requireNonNegativeInteger(
    source.source_event_count,
    `${path}.source_event_count`,
  );
  requireNonNegativeInteger(
    source.retained_event_count,
    `${path}.retained_event_count`,
  );
  if (Number(source.retained_event_count) > Number(source.source_event_count)) {
    throw new DashboardCompatibilityError(
      path,
      "retained_event_count must not exceed source_event_count",
    );
  }
  requireLiteral(
    source.redaction,
    `${path}.redaction`,
    "private-reasoning-fields-removed",
  );
  for (const key of [
    "source_agent",
    "agent_version",
    "parser_id",
    "parser_version",
    "adapter_maturity",
    "source_contract_version",
    "contract_stability",
    "evidence_authority",
  ]) {
    if (source[key] !== undefined) requireString(source[key], `${path}.${key}`);
  }
  for (const key of [
    "registry_entry_digest",
    "runtime_binding_digest",
    "executable_digest",
    "argv_digest",
    "parser_digest",
  ]) {
    if (source[key] !== undefined) {
      const digest = requireString(source[key], `${path}.${key}`);
      if (!/^[a-f0-9]{64}$/i.test(digest)) {
        throw new DashboardCompatibilityError(`${path}.${key}`, "expected a SHA-256 digest");
      }
    }
  }
  if (source.contract_urls !== undefined) {
    requireStringArray(source.contract_urls, `${path}.contract_urls`);
  }
  return true;
}

function validateAgentTrace(
  value: unknown,
  path: string,
  context: TraceValidationContext,
): void {
  const trace = requireRecord(value, path);
  const valid = requireBoolean(trace.valid, `${path}.valid`);
  if (!valid) {
    for (const key of ["artifact", "digest", "started_at", "finished_at"]) {
      if (trace[key] !== undefined) {
        requireNullableString(trace[key], `${path}.${key}`);
      }
    }
    if (trace.capture_source !== undefined && trace.capture_source !== null) {
      requireString(trace.capture_source, `${path}.capture_source`);
    }
    if (
      trace.source_trace_required !== undefined &&
      trace.source_trace_required !== null
    ) {
      requireBoolean(
        trace.source_trace_required,
        `${path}.source_trace_required`,
      );
    }
    if (trace.complete !== undefined && trace.complete !== null) {
      requireBoolean(trace.complete, `${path}.complete`);
    }
    if (trace.event_count !== undefined && trace.event_count !== null) {
      requireNonNegativeInteger(trace.event_count, `${path}.event_count`);
    }
    if (trace.duration_ms !== undefined && trace.duration_ms !== null) {
      requireNonNegativeInteger(trace.duration_ms, `${path}.duration_ms`);
    }
    requireArrayOf(trace.events, `${path}.events`, (item, itemPath) => {
      requireRecord(item, itemPath);
    });
    return;
  }
  for (const key of ["artifact", "digest", "started_at", "finished_at"]) {
    requireString(trace[key], `${path}.${key}`);
  }
  const captureSource = requireString(
    trace.capture_source,
    `${path}.capture_source`,
  );
  if (
    context.profileTraceCaptureSource &&
    captureSource !== context.profileTraceCaptureSource
  ) {
    throw new DashboardCompatibilityError(
      `${path}.capture_source`,
      "must match run.execution_profile.trace.capture_source",
    );
  }
  const sourceTraceRequired = requireBoolean(
    trace.source_trace_required,
    `${path}.source_trace_required`,
  );
  if (
    context.profileSourceArtifact !== undefined &&
    sourceTraceRequired !== (context.profileSourceArtifact !== null)
  ) {
    throw new DashboardCompatibilityError(
      `${path}.source_trace_required`,
      "must match run.execution_profile.trace.source",
    );
  }
  requireLiteral(trace.complete, `${path}.complete`, true);
  const eventCount = requireNonNegativeInteger(
    trace.event_count,
    `${path}.event_count`,
  );
  const durationMs = requireNonNegativeInteger(
    trace.duration_ms,
    `${path}.duration_ms`,
  );
  const events = requireArray(trace.events, `${path}.events`);
  if (events.length === 0) {
    throw new DashboardCompatibilityError(path, "a valid trace requires events");
  }
  const seenEventIds = new Set<string>();
  const eventRecords: Record<string, unknown>[] = [];
  let previousElapsed = -1;
  events.forEach((item, index) => {
    const itemPath = `${path}.events[${index}]`;
    const event = requireRecord(item, itemPath);
    eventRecords.push(event);
    requireLiteral(
      event.contract,
      `${itemPath}.contract`,
      "skill-reviewer.agent-trace-event",
    );
    const eventId = requireString(event.event_id, `${itemPath}.event_id`);
    if (seenEventIds.has(eventId)) {
      throw new DashboardCompatibilityError(
        `${itemPath}.event_id`,
        "expected a unique event id",
      );
    }
    seenEventIds.add(eventId);
    const eventRunId = requireString(event.run_id, `${itemPath}.run_id`);
    const eventCaseId = requireString(event.case_id, `${itemPath}.case_id`);
    const eventArm = requireString(event.arm, `${itemPath}.arm`);
    const eventRepeat = requirePositiveInteger(
      event.repeat,
      `${itemPath}.repeat`,
    );
    const sequence = requirePositiveInteger(
      event.sequence,
      `${itemPath}.sequence`,
    );
    requireString(event.occurred_at, `${itemPath}.occurred_at`);
    requireString(event.status, `${itemPath}.status`);
    requireString(event.summary, `${itemPath}.summary`);
    if (eventRunId !== context.runId) {
      throw new DashboardCompatibilityError(
        `${itemPath}.run_id`,
        "must match run.id",
      );
    }
    if (eventCaseId !== context.caseId) {
      throw new DashboardCompatibilityError(
        `${itemPath}.case_id`,
        "must match its case",
      );
    }
    if (eventArm !== context.armId) {
      throw new DashboardCompatibilityError(
        `${itemPath}.arm`,
        "must match its arm",
      );
    }
    if (eventRepeat !== context.repeat) {
      throw new DashboardCompatibilityError(
        `${itemPath}.repeat`,
        "must match its execution repeat",
      );
    }
    if (sequence !== index + 1) {
      throw new DashboardCompatibilityError(
        `${itemPath}.sequence`,
        "must be contiguous and start at 1",
      );
    }
    const elapsed = requireNonNegativeInteger(
      event.elapsed_ms,
      `${itemPath}.elapsed_ms`,
    );
    if (elapsed < previousElapsed) {
      throw new DashboardCompatibilityError(
        `${itemPath}.elapsed_ms`,
        "must be monotonic",
      );
    }
    previousElapsed = elapsed;
    requireOneOf(event.kind, `${itemPath}.kind`, [
      "execution_started",
      "file_read",
      "tool_call",
      "command",
      "agent_message",
      "artifact_written",
      "error",
      "execution_finished",
    ] as const);
    const details = requireRecord(event.details, `${itemPath}.details`);
    const forbiddenKeys = [...new Set(findForbiddenTraceDetailKeys(details))];
    if (forbiddenKeys.length > 0) {
      throw new DashboardCompatibilityError(
        `${itemPath}.details`,
        `contains forbidden private-reasoning fields: ${forbiddenKeys.join(", ")}`,
      );
    }
    requireStringArray(event.artifact_refs, `${itemPath}.artifact_refs`);
  });
  if (eventCount !== events.length) {
    throw new DashboardCompatibilityError(
      path,
      "event_count must match the retained event array",
    );
  }
  const first = requireRecord(events[0], `${path}.events[0]`);
  const last = requireRecord(
    events.at(-1),
    `${path}.events[${events.length - 1}]`,
  );
  if (first.kind !== "execution_started") {
    throw new DashboardCompatibilityError(
      path,
      "a valid trace must start with execution_started",
    );
  }
  if (last.kind !== "execution_finished") {
    throw new DashboardCompatibilityError(
      path,
      "a valid trace must end with execution_finished",
    );
  }
  if (last.status !== context.executionStatus) {
    throw new DashboardCompatibilityError(
      `${path}.events[${events.length - 1}].status`,
      "must match its execution status",
    );
  }
  if (trace.started_at !== first.occurred_at) {
    throw new DashboardCompatibilityError(
      `${path}.started_at`,
      "must match the first event",
    );
  }
  if (trace.finished_at !== last.occurred_at) {
    throw new DashboardCompatibilityError(
      `${path}.finished_at`,
      "must match the final event",
    );
  }
  if (durationMs !== last.elapsed_ms) {
    throw new DashboardCompatibilityError(
      `${path}.duration_ms`,
      "must match the final event",
    );
  }
  const firstDetails = requireRecord(first.details, `${path}.events[0].details`);
  if (firstDetails.capture_source !== trace.capture_source) {
    throw new DashboardCompatibilityError(
      `${path}.events[0].details.capture_source`,
      "must match trace.capture_source",
    );
  }
  const observableKinds = new Set([
    "file_read",
    "tool_call",
    "command",
    "agent_message",
    "artifact_written",
    "error",
  ]);
  if (
    !eventRecords.some((event) => observableKinds.has(String(event.kind)))
  ) {
    throw new DashboardCompatibilityError(
      path,
      "a valid trace requires an observable Agent action",
    );
  }
}

function validateExecution(
  value: unknown,
  path: string,
  context: ArmValidationContext,
): number {
  const execution = requireRecord(value, path);
  const repeat = requirePositiveInteger(execution.repeat, `${path}.repeat`);
  const executionStatus = requireString(execution.status, `${path}.status`);
  requireNonNegativeInteger(
    execution.binding_error_count,
    `${path}.binding_error_count`,
  );
  requireNullableString(execution.execution_digest, `${path}.execution_digest`);
  requireNonNegativeInteger(execution.artifact_count, `${path}.artifact_count`);
  const assertions = requireRecord(execution.assertions, `${path}.assertions`);
  requirePassedCount(assertions, `${path}.assertions`);
  requireNullableUnitInterval(
    execution.required_pass_rate,
    `${path}.required_pass_rate`,
  );
  requireNumberRecord(execution.metrics, `${path}.metrics`);
  if (execution.dispatch !== undefined && execution.dispatch !== null) {
    validateDispatch(execution.dispatch, `${path}.dispatch`, context);
  }
  let validSourceTrace = false;
  if (execution.source_trace !== undefined && execution.source_trace !== null) {
    validSourceTrace = validateSourceTrace(
      execution.source_trace,
      `${path}.source_trace`,
      context,
    );
  }
  if (execution.trace !== null) {
    validateAgentTrace(execution.trace, `${path}.trace`, {
      ...context,
      repeat,
      executionStatus,
    });
    const trace = requireRecord(execution.trace, `${path}.trace`);
    if (
      executionStatus === "completed" &&
      trace.valid === true &&
      trace.source_trace_required === true &&
      !validSourceTrace
    ) {
      throw new DashboardCompatibilityError(
        `${path}.source_trace`,
        "a completed source-stream trace requires a valid bound source trace",
      );
    }
  }
  return repeat;
}

function validateArm(
  value: unknown,
  path: string,
  context: CaseValidationContext,
): string {
  const arm = requireRecord(value, path);
  const armId = requireString(arm.id, `${path}.id`);
  requireBoolean(arm.complete, `${path}.complete`);
  requireBoolean(arm.passed, `${path}.passed`);
  requireNullableUnitInterval(arm.required_pass_rate, `${path}.required_pass_rate`);
  for (const key of ["forbidden_actions", "side_effects", "binding_errors"]) {
    if (arm[key] !== undefined) requireStringArray(arm[key], `${path}.${key}`);
  }
  requireNumberRecord(arm.metrics, `${path}.metrics`);
  const assertions = requireRecord(arm.assertions, `${path}.assertions`);
  requirePassedCount(assertions, `${path}.assertions`);
  requireNonNegativeInteger(arm.artifact_count, `${path}.artifact_count`);
  if (arm.executions !== undefined) {
    const seenRepeats = new Set<number>();
    requireArrayOf(
      arm.executions,
      `${path}.executions`,
      (execution, executionPath) => {
        const repeat = validateExecution(execution, executionPath, {
          ...context,
          armId,
        });
        if (repeat > context.repeats) {
          throw new DashboardCompatibilityError(
            `${executionPath}.repeat`,
            `must not exceed case repeats (${context.repeats})`,
          );
        }
        if (seenRepeats.has(repeat)) {
          throw new DashboardCompatibilityError(
            `${executionPath}.repeat`,
            "must be unique within its arm",
          );
        }
        seenRepeats.add(repeat);
      },
    );
  }
  return armId;
}

function validateCase(
  value: unknown,
  path: string,
  context: RunValidationContext,
): void {
  const item = requireRecord(value, path);
  const caseId = requireString(item.id, `${path}.id`);
  if (item.purpose !== undefined) {
    requireNullableString(item.purpose, `${path}.purpose`);
  }
  if (item.prompt !== undefined) {
    requireNullableString(item.prompt, `${path}.prompt`);
  }
  if (item.input_files !== undefined) {
    requireStringArray(item.input_files, `${path}.input_files`);
  }
  requireOneOf(item.split, `${path}.split`, splits);
  requireOneOf(item.determinism, `${path}.determinism`, [
    "deterministic",
    "stochastic",
  ] as const);
  const repeats = requirePositiveInteger(item.repeats, `${path}.repeats`);
  requireOneOf(item.holdout_visibility, `${path}.holdout_visibility`, [
    "public",
    "opaque",
  ] as const);
  requireString(item.status, `${path}.status`);
  validateCaseMeasurement(item.measurement, `${path}.measurement`);
  requireBoolean(item.regressed, `${path}.regressed`);
  requireBoolean(item.direction_disagreement, `${path}.direction_disagreement`);
  requireStringArray(
    item.missing_objective_metrics,
    `${path}.missing_objective_metrics`,
  );
  const seenArmIds = new Set<string>();
  requireArrayOf(item.arms, `${path}.arms`, (arm, armPath) => {
    const armId = validateArm(arm, armPath, {
      ...context,
      caseId,
      repeats,
    });
    if (seenArmIds.has(armId)) {
      throw new DashboardCompatibilityError(
        `${armPath}.id`,
        "must be unique within its case",
      );
    }
    seenArmIds.add(armId);
  });
  requireArrayOf(
    item.semantic_assertions,
    `${path}.semantic_assertions`,
    (assertionValue, assertionPath) => {
      const assertion = requireRecord(assertionValue, assertionPath);
      requireString(assertion.id, `${assertionPath}.id`);
      requireString(assertion.status, `${assertionPath}.status`);
      requireBoolean(assertion.passed, `${assertionPath}.passed`);
      for (const key of ["preference", "reason"]) {
        validateOptionalNullableString(assertion, key, assertionPath);
      }
      validateOptionalString(assertion, "artifact", assertionPath);
      for (const key of ["resolved_winners", "source_event_ids"]) {
        if (assertion[key] !== undefined) {
          requireStringArray(assertion[key], `${assertionPath}.${key}`);
        }
      }
    },
  );
}

function validateDiff(value: unknown, path: string): void {
  const diff = requireRecord(value, path);
  requireString(diff.id, `${path}.id`);
  requireString(diff.path, `${path}.path`);
  requireOneOf(diff.status, `${path}.status`, [
    "added",
    "removed",
    "modified",
  ] as const);
  requireNullableString(diff.old_digest, `${path}.old_digest`);
  requireNullableString(diff.new_digest, `${path}.new_digest`);
  requireNonNegativeInteger(diff.old_size, `${path}.old_size`);
  requireNonNegativeInteger(diff.new_size, `${path}.new_size`);
  requireBoolean(diff.binary, `${path}.binary`);
  requireOneOf(diff.render_mode, `${path}.render_mode`, [
    "lazy",
    "summary",
    "binary",
  ] as const);
  requireNullableString(diff.content_url, `${path}.content_url`);
  requireNullableString(diff.payload_digest, `${path}.payload_digest`);
  if (diff.summary !== undefined) {
    requireNullableString(diff.summary, `${path}.summary`);
  }
}

function validateAssertionRule(value: unknown, path: string): void {
  const rule = requireRecord(value, path);
  for (const key of ["severity", "artifact", "pattern", "rubric"]) {
    validateOptionalString(rule, key, path);
  }
  if (rule.expected !== undefined) {
    if (Array.isArray(rule.expected)) {
      requireStringArray(rule.expected, `${path}.expected`);
    } else {
      requireString(rule.expected, `${path}.expected`);
    }
  }
  if (rule.inputs !== undefined) {
    requireStringArray(rule.inputs, `${path}.inputs`);
  }
}

function validateAssertionEvidence(value: unknown, path: string): void {
  const evidence = requireRecord(value, path);
  for (const key of ["artifact", "pattern"]) {
    validateOptionalString(evidence, key, path);
  }
  for (const key of ["exists", "matched"]) {
    if (evidence[key] !== undefined) {
      requireBoolean(evidence[key], `${path}.${key}`);
    }
  }
  for (const key of ["missing", "unexpected", "source_event_ids"]) {
    if (evidence[key] !== undefined) {
      requireStringArray(evidence[key], `${path}.${key}`);
    }
  }
}

function validateSpineNode(value: unknown, path: string): void {
  const node = requireRecord(value, path);
  requireString(node.id, `${path}.id`);
  requireOneOf(node.kind, `${path}.kind`, [
    "run",
    "gate",
    "iteration",
    "case",
    "assertion",
    "artifact",
  ] as const);
  requireNullableString(node.parent_id, `${path}.parent_id`);
  requireString(node.label, `${path}.label`);
  requireString(node.status, `${path}.status`);
  validateOptionalNullableString(node, "detail", path);
  validateOptionalNullableString(node, "case_id", path);
  if (node.split !== undefined) requireOneOf(node.split, `${path}.split`, splits);
  for (const key of ["arm", "assertion_type"]) {
    validateOptionalString(node, key, path);
  }
  for (const key of ["path", "artifact", "content_url", "content_digest"]) {
    validateOptionalNullableString(node, key, path);
  }
  for (const key of ["repeat", "content_size"]) {
    validateOptionalNumber(node, key, path);
  }
  if (node.assertion_rule !== undefined) {
    validateAssertionRule(node.assertion_rule, `${path}.assertion_rule`);
  }
  if (node.assertion_evidence !== undefined) {
    validateAssertionEvidence(
      node.assertion_evidence,
      `${path}.assertion_evidence`,
    );
  }
  if (node.content_unavailable_reason !== undefined) {
    requireOneOf(
      node.content_unavailable_reason,
      `${path}.content_unavailable_reason`,
      ["opaque", "binary", "too_large"] as const,
    );
  }
}

function validateProjectionInvariants(
  run: Record<string, unknown>,
  summary: Record<string, unknown>,
  evolution: Record<string, unknown>,
  cases: unknown[],
  review: Record<string, unknown>,
): void {
  const decision = requireRecord(review.decision, "review.decision");
  if (run.release_eligible !== decision.release_eligible) {
    throw new DashboardCompatibilityError(
      "run.release_eligible",
      "must match review.decision.release_eligible",
    );
  }
  if (
    decision.release_eligible === true &&
    (decision.status !== "ready" ||
      decision.reason !== "release_conditions_met")
  ) {
    throw new DashboardCompatibilityError(
      "review.decision.release_eligible",
      "true requires ready status and release_conditions_met reason",
    );
  }
  if (
    decision.release_eligible === false &&
    (decision.status === "ready" ||
      decision.reason === "release_conditions_met")
  ) {
    throw new DashboardCompatibilityError(
      "review.decision.release_eligible",
      "false cannot accompany ready status or release_conditions_met reason",
    );
  }
  if (decision.release_eligible === true) {
    const holdout = isRecord(run.holdout) ? run.holdout : null;
    if (
      run.evidence_scope !== "opaque-holdout" ||
      holdout?.visibility !== "opaque" ||
      typeof holdout.issuer !== "string" ||
      holdout.issuer.trim().length === 0 ||
      typeof holdout.digest !== "string" ||
      holdout.digest.trim().length === 0
    ) {
      throw new DashboardCompatibilityError(
        "run.evidence_scope",
        "eligible release requires a trusted opaque holdout",
      );
    }
    const blockers = requireArray(review.blockers, "review.blockers");
    if (blockers.length > 0) {
      throw new DashboardCompatibilityError(
        "review.blockers",
        "must be empty when release is eligible",
      );
    }
    if (
      decision.blocking_scenario_count !== 0 ||
      decision.blocking_gate_count !== 0
    ) {
      throw new DashboardCompatibilityError(
        "review.decision",
        "eligible release cannot declare blocking scenarios or gates",
      );
    }
    if (
      Number(summary.case_count) <= 0 ||
      summary.candidate_passed !== summary.case_count ||
      summary.candidate_failed !== 0
    ) {
      throw new DashboardCompatibilityError(
        "summary.candidate_passed",
        "eligible release requires every configured case to pass",
      );
    }
    if (
      Number(summary.hard_gates_total) <= 0 ||
      summary.hard_gates_passed !== summary.hard_gates_total
    ) {
      throw new DashboardCompatibilityError(
        "summary.hard_gates_passed",
        "eligible release requires every configured hard gate to pass",
      );
    }
  }
  if (summary.case_count !== cases.length) {
    throw new DashboardCompatibilityError(
      "summary.case_count",
      "must match cases.length",
    );
  }
  const caseRecords = cases.map((item, index) =>
    requireRecord(item, `cases[${index}]`),
  );
  const caseIds = new Set<string>();
  caseRecords.forEach((item, index) => {
    const caseId = requireString(item.id, `cases[${index}].id`);
    if (caseIds.has(caseId)) {
      throw new DashboardCompatibilityError(
        `cases[${index}].id`,
        "must be unique within the projection",
      );
    }
    caseIds.add(caseId);
  });
  const candidatePassed = caseRecords.filter(
    (item) => item.status === "passed",
  ).length;
  const candidateFailed = caseRecords.filter((item) =>
    ["failed", "incomplete"].includes(String(item.status)),
  ).length;
  if (summary.candidate_passed !== candidatePassed) {
    throw new DashboardCompatibilityError(
      "summary.candidate_passed",
      "must match passed cases",
    );
  }
  if (summary.candidate_failed !== candidateFailed) {
    throw new DashboardCompatibilityError(
      "summary.candidate_failed",
      "must match failed and incomplete cases",
    );
  }
  if (
    summary.current_round !== null &&
    Number(summary.current_round) > Number(summary.max_rounds)
  ) {
    throw new DashboardCompatibilityError(
      "summary.current_round",
      "must not exceed summary.max_rounds",
    );
  }
  if (
    Number(summary.selection_queries) >
    Number(evolution.selection_query_limit)
  ) {
    throw new DashboardCompatibilityError(
      "summary.selection_queries",
      "must not exceed evolution.selection_query_limit",
    );
  }
  if (Number(summary.audit_queries) > Number(evolution.audit_query_limit)) {
    throw new DashboardCompatibilityError(
      "summary.audit_queries",
      "must not exceed evolution.audit_query_limit",
    );
  }
  const rejected = requireArray(
    evolution.rejected_candidates,
    "evolution.rejected_candidates",
  );
  if (summary.rejected_candidates !== rejected.length) {
    throw new DashboardCompatibilityError(
      "summary.rejected_candidates",
      "must match evolution.rejected_candidates.length",
    );
  }
  const lineage = requireArray(
    evolution.candidate_lineage,
    "evolution.candidate_lineage",
  );
  const statePresent = summary.current_round !== null;
  if (statePresent) {
    if (summary.continuity_epoch === null) {
      throw new DashboardCompatibilityError(
        "summary.continuity_epoch",
        "is required when evolution state is present",
      );
    }
    if (summary.selection_queries !== lineage.length) {
      throw new DashboardCompatibilityError(
        "summary.selection_queries",
        "must match evolution.candidate_lineage.length",
      );
    }
    if (lineage.length === 0) {
      throw new DashboardCompatibilityError(
        "evolution.candidate_lineage",
        "must not be empty when evolution state is present",
      );
    }
    const seenLineageRunIds = new Set<string>();
    const baseline = requireRecord(run.baseline, "run.baseline");
    const baselineDigest = requireString(
      baseline.digest,
      "run.baseline.digest",
    );
    const subject = requireRecord(run.subject, "run.subject");
    const subjectDigest = requireString(subject.digest, "run.subject.digest");
    lineage.forEach((item, index) => {
      const record = requireRecord(
        item,
        `evolution.candidate_lineage[${index}]`,
      );
      if (record.round !== index + 1) {
        throw new DashboardCompatibilityError(
          `evolution.candidate_lineage[${index}].round`,
          "must be contiguous and start at 1",
        );
      }
      if (record.parent_digest !== baselineDigest) {
        throw new DashboardCompatibilityError(
          `evolution.candidate_lineage[${index}].parent_digest`,
          "must remain anchored to run.baseline.digest",
        );
      }
      const runId = requireString(
        record.run_id,
        `evolution.candidate_lineage[${index}].run_id`,
      );
      if (seenLineageRunIds.has(runId)) {
        throw new DashboardCompatibilityError(
          `evolution.candidate_lineage[${index}].run_id`,
          "must be unique within candidate lineage",
        );
      }
      seenLineageRunIds.add(runId);
      if (runId === run.id && record.candidate_digest !== subjectDigest) {
        throw new DashboardCompatibilityError(
          `evolution.candidate_lineage[${index}].candidate_digest`,
          "must match run.subject.digest for the current run",
        );
      }
    });
    const lastLineage = requireRecord(
      lineage.at(-1),
      `evolution.candidate_lineage[${lineage.length - 1}]`,
    );
    if (summary.continuity_epoch !== lastLineage.continuity_epoch) {
      throw new DashboardCompatibilityError(
        "summary.continuity_epoch",
        "must match the final candidate lineage epoch",
      );
    }
  } else if (
    summary.selection_queries !== 0 ||
    summary.audit_queries !== 0 ||
    summary.continuity_epoch !== null ||
    lineage.length !== 0 ||
    rejected.length !== 0 ||
    evolution.active_query !== null
  ) {
    throw new DashboardCompatibilityError(
      "evolution",
      "state-absent projections require zero query counts and empty lineage",
    );
  }
  if (evolution.active_query != null) {
    const activeQuery = requireRecord(
      evolution.active_query,
      "evolution.active_query",
    );
    if (activeQuery.round !== summary.current_round) {
      throw new DashboardCompatibilityError(
        "evolution.active_query.round",
        "must match summary.current_round",
      );
    }
    if (activeQuery.run_id !== run.id) {
      throw new DashboardCompatibilityError(
        "evolution.active_query.run_id",
        "must match run.id",
      );
    }
    const subject = requireRecord(run.subject, "run.subject");
    if (activeQuery.candidate_digest !== subject.digest) {
      throw new DashboardCompatibilityError(
        "evolution.active_query.candidate_digest",
        "must match run.subject.digest",
      );
    }
  }
  const runMeasurement = requireRecord(run.measurement, "run.measurement");
  const measurementCases = requireArray(
    runMeasurement.cases,
    "run.measurement.cases",
  ).map((value, index) =>
    requireRecord(value, `run.measurement.cases[${index}]`),
  );
  const measurementByCase = new Map(
    measurementCases.map((item) => [String(item.case_id), item]),
  );
  if (
    measurementByCase.size !== caseRecords.length ||
    caseRecords.some((item) => !measurementByCase.has(String(item.id)))
  ) {
    throw new DashboardCompatibilityError(
      "run.measurement.cases",
      "must contain exactly one record for every projected case",
    );
  }
  caseRecords.forEach((item, index) => {
    const caseMeasurement = requireRecord(
      item.measurement,
      `cases[${index}].measurement`,
    );
    const oracle = requireRecord(
      caseMeasurement.oracle,
      `cases[${index}].measurement.oracle`,
    );
    const sampling = requireRecord(
      caseMeasurement.sampling,
      `cases[${index}].measurement.sampling`,
    );
    const expectedCaseStatus = aggregateMeasurementStatus([
      oracle.status,
      sampling.status,
    ]);
    if (caseMeasurement.status !== expectedCaseStatus) {
      throw new DashboardCompatibilityError(
        `cases[${index}].measurement.status`,
        `must aggregate oracle and sampling status as ${expectedCaseStatus}`,
      );
    }
    if (
      measurementByCase.get(String(item.id))?.status !== caseMeasurement.status
    ) {
      throw new DashboardCompatibilityError(
        `cases[${index}].measurement.status`,
        "must match run.measurement.cases",
      );
    }
  });
  const expectedRunMeasurementStatus = aggregateMeasurementStatus(
    measurementCases.map((item) => item.status),
  );
  if (runMeasurement.status !== expectedRunMeasurementStatus) {
    throw new DashboardCompatibilityError(
      "run.measurement.status",
      `must aggregate case measurement status as ${expectedRunMeasurementStatus}`,
    );
  }
  if (run.release_eligible === true && runMeasurement.status !== "valid") {
    throw new DashboardCompatibilityError(
      "run.release_eligible",
      "requires valid measurement evidence",
    );
  }
  const declaredSplits = new Set(
    requireArray(run.splits, "run.splits").map((split) => String(split)),
  );
  caseRecords.forEach((item, index) => {
    if (!declaredSplits.has(String(item.split))) {
      throw new DashboardCompatibilityError(
        `cases[${index}].split`,
        "must be declared in run.splits",
      );
    }
  });
}

function legacyCaseMeasurement(
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    status: "unverified",
    oracle: {
      status: "unverified",
      required_text_assertions: 0,
      calibrated_text_assertions: 0,
      checks: [],
      reasons: ["legacy_projection_missing_measurement_validity"],
    },
    sampling: {
      status: "unverified",
      repeats:
        typeof item.repeats === "number" && Number.isInteger(item.repeats)
          ? item.repeats
          : null,
      pairing: "paired",
      source: "legacy-projection",
      direction_disagreement: item.direction_disagreement === true,
    },
    reasons: ["legacy_projection_missing_measurement_validity"],
  };
}

function migrateV2Projection(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const migratedSource = { ...source };
  delete migratedSource.iterations;
  const cases = Array.isArray(source.cases)
    ? source.cases.map((value) => {
        if (!isRecord(value)) return value;
        return {
          ...value,
          measurement: value.measurement ?? legacyCaseMeasurement(value),
        };
      })
    : source.cases;
  const caseMeasurements = Array.isArray(cases)
    ? cases.flatMap((value) => {
        if (!isRecord(value) || typeof value.id !== "string") return [];
        const measurement = isRecord(value.measurement)
          ? value.measurement
          : legacyCaseMeasurement(value);
        return [{ case_id: value.id, ...measurement }];
      })
    : [];
  const run = isRecord(source.run) ? source.run : {};
  const summary = isRecord(source.summary) ? source.summary : {};
  const evolution = isRecord(source.evolution) ? source.evolution : {};
  const review = isRecord(source.review) ? source.review : null;
  const reviewDecision = review && isRecord(review.decision) ? review.decision : null;
  const actionCenter = isRecord(source.action_center) ? source.action_center : null;
  const continuation =
    actionCenter && isRecord(actionCenter.continuation)
      ? actionCenter.continuation
      : null;
  const acceptance =
    actionCenter && isRecord(actionCenter.acceptance)
      ? actionCenter.acceptance
      : null;
  const attribution =
    actionCenter && isRecord(actionCenter.attribution)
      ? actionCenter.attribution
      : null;
  return {
    ...migratedSource,
    schema_version: dashboardSchemaVersion,
    run: {
      ...run,
      release_eligible: false,
      measurement: run.measurement ?? {
        status: "unverified",
        cases: caseMeasurements,
        reasons: ["legacy_projection_missing_measurement_validity"],
      },
    },
    summary: { ...summary, invalid_experiments: summary.invalid_experiments ?? 0 },
    evolution: {
      ...evolution,
      invalid_experiments: evolution.invalid_experiments ?? [],
    },
    review:
      review === null
        ? source.review
        : {
            ...review,
            decision:
              reviewDecision === null
                ? review.decision
                : {
                    ...reviewDecision,
                    status: "inconclusive",
                    reason: "evidence_incomplete",
                    release_eligible: false,
                  },
            next_action: "review_evidence",
          },
    action_center:
      actionCenter === null
        ? source.action_center
        : {
            ...actionCenter,
            next_action: "review_evidence",
            continuation:
              continuation === null
                ? actionCenter.continuation
                : {
                    ...continuation,
                    mode: "human_required",
                    owner: "human",
                    reason: "evidence_review",
                  },
            acceptance:
              acceptance === null
                ? actionCenter.acceptance
                : {
                    ...acceptance,
                    status: "measurement-unverified",
                    accepted: null,
                    criteria: Array.isArray(acceptance.criteria)
                      ? acceptance.criteria.map((value) =>
                          isRecord(value) ? { ...value, status: "pending" } : value,
                        )
                      : acceptance.criteria,
                  },
            attribution:
              attribution === null
                ? actionCenter.attribution
                : {
                    ...attribution,
                    primary: null,
                    items: Array.isArray(attribution.items)
                      ? attribution.items.map((value) =>
                          isRecord(value)
                            ? { ...value, status: "waiting", signals: [] }
                            : value,
                        )
                      : attribution.items,
                  },
            actions: Array.isArray(actionCenter.actions)
              ? actionCenter.actions.map((value) =>
                  isRecord(value)
                    ? { ...value, available: false, recommended: false }
                    : value,
                )
              : actionCenter.actions,
          },
    cases,
  };
}

/**
 * Validates every decision-bearing nested collection before React receives it.
 * V2 and its unversioned predecessor migrate only by marking the newly added
 * measurement layer explicitly unverified; no positive evidence is invented.
 */
export function validateAndMigrateDashboardData(input: unknown): DashboardData {
  const source = requireRecord(input, "dashboard");
  requireLiteral(source.contract, "contract", "skill-reviewer.dashboard-data");

  const rawVersion = source.schema_version;
  let version = 2;
  if (rawVersion !== undefined) {
    version = requireFiniteNumber(rawVersion, "schema_version");
    if (!Number.isInteger(version)) {
      throw new DashboardCompatibilityError(
        "schema_version",
        "expected an integer version",
      );
    }
    if (version !== 2 && version !== dashboardSchemaVersion) {
      throw new DashboardCompatibilityError(
        "schema_version",
        `version ${version} has no registered migration; regenerate with version ${dashboardSchemaVersion}`,
      );
    }
  }
  const root = version === 2 ? migrateV2Projection(source) : source;

  if (root.generated_at !== null) {
    requireString(root.generated_at, "generated_at");
  }
  requirePositiveInteger(root.refresh_interval_ms, "refresh_interval_ms");
  const run = requireRecord(root.run, "run");
  validateRun(run, "run");
  const profile =
    run.execution_profile == null
      ? null
      : requireRecord(run.execution_profile, "run.execution_profile");
  const runContext: RunValidationContext = {
    runId: requireString(run.id, "run.id"),
    profileAdapterId:
      typeof profile?.adapter_id === "string" ? profile.adapter_id : undefined,
    profileSourceAgent:
      isRecord(profile?.adapter_binding) &&
      typeof profile.adapter_binding.source_agent === "string"
        ? profile.adapter_binding.source_agent
        : undefined,
    profileRegistryEntryDigest:
      isRecord(profile?.adapter_binding) &&
      typeof profile.adapter_binding.registry_entry_digest === "string"
        ? profile.adapter_binding.registry_entry_digest
        : undefined,
    profileTarget:
      typeof profile?.target === "string" ? profile.target : undefined,
    profileHarness:
      typeof profile?.harness === "string" ? profile.harness : undefined,
    profileDispatchObservation:
      profile?.dispatch_observation === "host_dispatch" ||
      profile?.dispatch_observation === "process_spawn" ||
      profile?.dispatch_observation === "external_harness"
        ? profile.dispatch_observation
        : undefined,
    profileTraceCaptureSource:
      isRecord(profile?.trace) && typeof profile.trace.capture_source === "string"
        ? profile.trace.capture_source
        : undefined,
    profileSourceArtifact:
      isRecord(profile?.trace) && profile.trace.source === null
        ? null
        : isRecord(profile?.trace) && isRecord(profile.trace.source) &&
            typeof profile.trace.source.artifact === "string"
          ? profile.trace.source.artifact
          : undefined,
    profileSourceFormat:
      isRecord(profile?.trace) && isRecord(profile.trace.source) &&
      typeof profile.trace.source.format === "string"
        ? profile.trace.source.format
        : undefined,
  };
  const summary = requireRecord(root.summary, "summary");
  validateSummary(summary, "summary");
  const evolution = requireRecord(root.evolution, "evolution");
  validateEvolution(evolution, "evolution");
  const actionCenter = requireRecord(root.action_center, "action_center");
  validateActionCenter(actionCenter, "action_center");
  const review = requireRecord(root.review, "review");
  validateReview(review, "review");
  const cases = requireArray(root.cases, "cases");
  cases.forEach((item, index) =>
    validateCase(item, `cases[${index}]`, runContext),
  );
  validateProjectionInvariants(
    run,
    summary,
    evolution,
    cases,
    review,
  );
  requireArrayOf(root.diffs, "diffs", validateDiff);
  requireArrayOf(root.spine, "spine", validateSpineNode);
  requireStringArray(root.limitations, "limitations");

  return {
    ...root,
    schema_version: dashboardSchemaVersion,
  } as unknown as DashboardData;
}
