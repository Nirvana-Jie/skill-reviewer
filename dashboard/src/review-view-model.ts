import {
  buildEvalExecutionTrace,
  buildTraceCaseIndex,
} from "./eval-execution-trace";
import type { DashboardData } from "./types";

export type ReviewTone = "good" | "bad" | "warn" | "neutral";

export interface ReviewViewModel {
  decision: {
    status: DashboardData["review"]["decision"]["status"];
    reason: DashboardData["review"]["decision"]["reason"];
    tone: ReviewTone;
  };
  execution: {
    captured: number;
    expected: number;
    status: "complete" | "partial" | "not_configured";
    tone: "neutral" | "warn";
  };
  evidence: {
    status: "complete" | "partial" | "missing";
    tone: "neutral" | "warn";
  };
  measurement: {
    status: "valid" | "invalid" | "unverified" | "pending";
    tone: "good" | "warn";
  };
  validity: {
    evidence: {
      status: "valid" | "invalid";
      tone: "good" | "bad";
    };
    candidate: {
      status: "accepted" | "rejected" | "pending" | "not_judged";
      tone: "good" | "bad" | "neutral" | "warn";
    };
  };
}

const candidateToneByStatus: Record<
  ReviewViewModel["validity"]["candidate"]["status"],
  ReviewViewModel["validity"]["candidate"]["tone"]
> = {
  accepted: "good",
  rejected: "bad",
  pending: "neutral",
  not_judged: "warn",
};

const requiredAcceptanceCriterionIds = [
  "hard_gates",
  "pareto",
  "material_improvement",
] as const;

function hasCompleteAcceptanceCriteria(data: DashboardData): boolean {
  const ids = data.action_center.acceptance.criteria.map(
    (criterion) => criterion.id,
  );
  const uniqueIds = new Set(ids);
  return (
    ids.length === requiredAcceptanceCriterionIds.length &&
    uniqueIds.size === requiredAcceptanceCriterionIds.length &&
    requiredAcceptanceCriterionIds.every((id) => uniqueIds.has(id))
  );
}

function hasTrustedOpaqueHoldout(data: DashboardData): boolean {
  const holdout = data.run.holdout;
  return (
    data.run.evidence_scope === "opaque-holdout" &&
    holdout?.visibility === "opaque" &&
    typeof holdout.issuer === "string" &&
    holdout.issuer.trim().length > 0 &&
    typeof holdout.digest === "string" &&
    holdout.digest.trim().length > 0
  );
}

function hasValidEvidenceIntegrity(
  data: DashboardData,
  executionEvidenceComplete: boolean,
): boolean {
  const integrity = data.run.integrity;
  return (
    integrity?.locked === true &&
    integrity.verified === true &&
    data.cases.length > 0 &&
    executionEvidenceComplete &&
    data.cases.every((item) =>
      item.arms.every(
        (arm) =>
          (arm.binding_errors?.length ?? 0) === 0 &&
          (arm.executions ?? []).every(
            (execution) =>
              execution.binding_error_count === 0 &&
              execution.dispatch?.valid === true &&
              execution.trace?.valid === true,
          ),
      ),
    )
  );
}

function decisionTone(
  decision: DashboardData["review"]["decision"],
  releaseInvariantsSatisfied: boolean,
): ReviewTone {
  if (
    releaseInvariantsSatisfied &&
    decision.status === "ready" &&
    decision.reason === "release_conditions_met" &&
    decision.release_eligible
  ) {
    return "good";
  }
  if (
    decision.status === "blocked" ||
    [
      "release_gate_failed",
      "scenario_failed",
      "candidate_acceptance_failed",
    ].includes(decision.reason)
  ) {
    return "bad";
  }
  return "warn";
}

export function buildReviewViewModel(data: DashboardData): ReviewViewModel {
  const traceIndex = buildTraceCaseIndex(data.cases);
  const expected = traceIndex.reduce(
    (total, item) => total + item.expectedExecutions,
    0,
  );
  const captured = traceIndex.reduce(
    (total, item) => total + item.capturedTraces,
    0,
  );
  const executionStatus =
    expected === 0
      ? "not_configured"
      : captured === expected
        ? "complete"
        : "partial";
  const executionEvidenceVerified =
    data.cases.length > 0 &&
    data.cases.every(
      (item) => buildEvalExecutionTrace(data, item.id)?.confidence === "verified",
    );
  const measurementStatus = data.run.measurement?.status ?? "unverified";
  const measurementValid = measurementStatus === "valid";
  const evidenceIntegrityValid = hasValidEvidenceIntegrity(
    data,
    executionStatus === "complete" && executionEvidenceVerified,
  );
  const candidateStatus =
    !evidenceIntegrityValid || !measurementValid
      ? "not_judged"
      : data.action_center.acceptance.accepted === true
        ? "accepted"
        : data.action_center.acceptance.accepted === false
          ? "rejected"
          : "pending";
  const evidenceIncomplete =
    executionStatus !== "complete" ||
    !executionEvidenceVerified ||
    ["audit_required", "evidence_incomplete"].includes(
      data.review.decision.reason,
    ) ||
    data.review.blockers.some(
      (blocker) => blocker.missing_artifact_ids.length > 0,
    ) ||
    data.cases.some((item) => item.arms.some((arm) => !arm.complete)) ||
    !measurementValid;
  const releaseInvariantsSatisfied =
    data.run.release_eligible &&
    data.review.blockers.length === 0 &&
    data.review.decision.blocking_scenario_count === 0 &&
    data.review.decision.blocking_gate_count === 0 &&
    data.summary.case_count > 0 &&
    data.summary.candidate_passed === data.summary.case_count &&
    data.summary.candidate_failed === 0 &&
    data.summary.hard_gates_total > 0 &&
    data.summary.hard_gates_passed === data.summary.hard_gates_total &&
    hasTrustedOpaqueHoldout(data) &&
    hasCompleteAcceptanceCriteria(data) &&
    measurementValid;
  const declaredDecisionTone = decisionTone(
    data.review.decision,
    releaseInvariantsSatisfied,
  );

  return {
    decision: {
      status: data.review.decision.status,
      reason: data.review.decision.reason,
      tone:
        declaredDecisionTone === "good" && evidenceIncomplete
          ? "warn"
          : declaredDecisionTone,
    },
    execution: {
      captured,
      expected,
      status: executionStatus,
      tone: executionStatus === "complete" ? "neutral" : "warn",
    },
    evidence: {
      status: evidenceIncomplete
        ? captured === 0
          ? "missing"
          : "partial"
        : "complete",
      tone: evidenceIncomplete ? "warn" : "neutral",
    },
    measurement: {
      status: measurementStatus,
      tone: measurementValid ? "good" : "warn",
    },
    validity: {
      evidence: {
        status: evidenceIntegrityValid ? "valid" : "invalid",
        tone: evidenceIntegrityValid ? "good" : "bad",
      },
      candidate: {
        status: candidateStatus,
        tone: candidateToneByStatus[candidateStatus],
      },
    },
  };
}
