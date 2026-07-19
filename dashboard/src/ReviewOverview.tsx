import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileSearch,
  GitCompareArrows,
  ShieldCheck,
  X,
} from "lucide-react";

import { nextActionMessageKey } from "./ActionCenter";
import {
  describeAssertionDecision,
  describeDashboardCase,
  describeEvidenceNode,
} from "./evidence-semantics";
import { buildReviewViewModel } from "./review-view-model";
import type {
  ActionAttributionId,
  DashboardData,
  SpineNode,
} from "./types";
import {
  localizeStatus,
  useUiPreferences,
  type MessageKey,
} from "./ui-preferences";

const attributionKeys: Record<ActionAttributionId, MessageKey> = {
  skill: "attribution_skill",
  eval: "attribution_eval",
  execution_environment: "attribution_execution_environment",
  evidence: "attribution_evidence",
  human: "attribution_human",
};

const attributionActionKeys: Record<ActionAttributionId, MessageKey> = {
  skill: "issueAction_skill",
  eval: "issueAction_eval",
  execution_environment: "issueAction_execution_environment",
  evidence: "issueAction_evidence",
  human: "issueAction_human",
};

function nodeMap(data: DashboardData): Map<string, SpineNode> {
  return new Map(data.spine.map((node) => [node.id, node]));
}

function DecisionIcon({ tone }: { tone: "good" | "bad" | "warn" | "neutral" }) {
  if (tone === "good") return <Check size={17} strokeWidth={2.4} />;
  if (tone === "bad") return <X size={17} strokeWidth={2.4} />;
  return <CircleAlert size={17} />;
}

function reviewDecisionCopy(
  locale: "en" | "zh-CN",
  data: DashboardData,
  releaseReady: boolean,
): { title: string; detail: string } {
  const decision = data.review.decision;
  if (
    releaseReady &&
    decision.status === "ready" &&
    decision.reason === "release_conditions_met" &&
    decision.release_eligible
  ) {
    return locale === "zh-CN"
      ? {
          title: "可以进入发布确认",
          detail: "所有发布级要求和评测场景均已满足；下一步仍由人确认是否发布。",
        }
      : {
          title: "Ready for release confirmation",
          detail: "Every release requirement and evaluation scenario passed; a human still confirms the release.",
        };
  }
  if (decision.reason === "release_gate_failed") {
    return locale === "zh-CN"
      ? {
          title: "暂不可发布",
          detail: `${decision.blocking_scenario_count} 个场景触发了 ${decision.blocking_gate_count} 项未满足的发布要求。`,
        }
      : {
          title: "Not ready for release",
          detail: `${decision.blocking_scenario_count} scenarios caused ${decision.blocking_gate_count} release requirements to fail.`,
        };
  }
  if (decision.reason === "scenario_failed") {
    return locale === "zh-CN"
      ? {
          title: "暂不可发布",
          detail: `${decision.blocking_scenario_count} 个评测场景尚未得到可接受的结果。`,
        }
      : {
          title: "Not ready for release",
          detail: `${decision.blocking_scenario_count} evaluation scenarios do not yet have an acceptable result.`,
      };
  }
  if (decision.reason === "candidate_acceptance_failed") {
    const failedCount = data.action_center.acceptance.criteria.filter(
      (criterion) => criterion.status === "failed",
    ).length;
    return locale === "zh-CN"
      ? {
          title: "候选暂不可接受",
          detail: `${failedCount} 项候选接受条件未满足；请先核对硬门禁、Pareto 不退化与实质提升。`,
        }
      : {
          title: "Candidate is not yet acceptable",
          detail: `${failedCount} candidate acceptance criteria failed. Review hard gates, Pareto admissibility, and material improvement.`,
        };
  }
  if (decision.reason === "audit_required") {
    return locale === "zh-CN"
      ? {
          title: "候选已通过，等待发布审计",
          detail: "候选选拔已满足要求，但发布证据尚不完整，暂不可发布；自动完成一次性发布审计并保留结果后，才能进入发布确认。",
        }
      : {
          title: "Candidate passed; release audit pending",
          detail: "Candidate selection passed, but release evidence is incomplete and release is not ready. Complete and retain the one-shot release audit before requesting confirmation.",
        };
  }
  return locale === "zh-CN"
    ? {
        title: "证据尚不足",
        detail: "当前没有足够的完整证据形成发布判断。",
      }
    : {
        title: "Evidence is still incomplete",
        detail: "The retained evidence is not yet sufficient for a release decision.",
      };
}

export function ReviewOverview({
  data,
  onOpenEvidence,
  onOpenDiff,
  onOpenTrace,
  onOpenActionCenter,
}: {
  data: DashboardData;
  onOpenEvidence: (node: SpineNode) => void;
  onOpenDiff: () => void;
  onOpenTrace: () => void;
  onOpenActionCenter: () => void;
}) {
  const { locale, t } = useUiPreferences();
  const nodesById = nodeMap(data);
  const viewModel = buildReviewViewModel(data);
  const decisionTone = viewModel.decision.tone;
  const decision = reviewDecisionCopy(
    locale,
    data,
    decisionTone === "good",
  );
  const nextActionKey = nextActionMessageKey(data.review.next_action);
  const automaticContinuation =
    data.action_center.continuation.mode === "automatic";
  const noBlockersReady = decisionTone === "good";
  const automaticNoBlockers =
    automaticContinuation && data.review.decision.reason === "audit_required";
  const noBlockersTitleKey = noBlockersReady
    ? "releaseBlockerNone"
    : "noKnownBlockerEvidenceIncomplete";
  const configuredRatio = (passed: number, total: number) =>
    total > 0 ? `${passed}/${total}` : t("notConfigured");
  const expectedTraces = viewModel.execution.expected;
  const capturedTraces = viewModel.execution.captured;
  const releaseEvidenceIncomplete = viewModel.evidence.status !== "complete";
  const evidenceCoverageTone = releaseEvidenceIncomplete
    ? viewModel.evidence.tone
    : viewModel.execution.tone;
  const primaryBlocker = data.review.blockers[0];
  const primaryRiskEvidence = primaryBlocker?.evidence_ids
    .map((id) => nodesById.get(id))
    .find((node): node is SpineNode => Boolean(node));

  return (
    <div className="review-overview">
      <section className={`review-decision-hero tone-${decisionTone}`}>
        <div className="review-decision-mark" aria-hidden="true">
          <DecisionIcon tone={decisionTone} />
        </div>
        <div className="review-decision-copy">
          <span className="pane-kicker">{t("reviewOverview")}</span>
          <h2 id="review-decision-title">{decision.title}</h2>
          <p>{decision.detail}</p>
        </div>
        <div className="review-decision-counts" aria-label={t("decisionCoverage")}>
          <div>
            <strong>
              {configuredRatio(
                data.summary.hard_gates_passed,
                data.summary.hard_gates_total,
              )}
            </strong>
            <span>{t("hardGates")}</span>
          </div>
          <div>
            <strong>
              {configuredRatio(
                data.summary.candidate_passed,
                data.summary.case_count,
              )}
            </strong>
            <span>{t("casesPassed")}</span>
          </div>
        </div>
      </section>

      <section
        className="decision-evidence-spine"
        aria-label={t("decisionEvidence")}
      >
        <div className={`decision-summary tone-${decisionTone}`}>
          <DecisionIcon tone={decisionTone} />
          <span>
            <small>{t("releaseState")}</small>
            <strong>{decision.title}</strong>
          </span>
        </div>
        <button
          type="button"
          className={primaryBlocker ? "tone-bad" : noBlockersReady ? "tone-good" : "tone-warn"}
          aria-label={t("reviewPrimaryRiskEvidence")}
          onClick={() =>
            primaryRiskEvidence
              ? onOpenEvidence(primaryRiskEvidence)
              : onOpenActionCenter()
          }
        >
          <CircleAlert size={17} aria-hidden="true" />
          <span>
            <small>{t("problemsToFix")}</small>
            <strong>
              {primaryBlocker
                ? t("releaseBlockerCount", { count: data.review.blockers.length })
                : noBlockersReady
                  ? t("noKnownRisk")
                  : t("evidenceIncomplete")}
            </strong>
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`tone-${evidenceCoverageTone}`}
          aria-label={t("reviewExecutionEvidence")}
          aria-describedby={
            releaseEvidenceIncomplete
              ? "review-release-evidence-quality"
              : undefined
          }
          onClick={onOpenTrace}
        >
          <ShieldCheck size={17} aria-hidden="true" />
          <span>
            <small>{t("evidenceCoverage")}</small>
            <strong>
              {expectedTraces > 0
                ? t("evidenceCoverageRatio", {
                    captured: capturedTraces,
                    expected: expectedTraces,
                  })
                : t("notConfigured")}
            </strong>
            {releaseEvidenceIncomplete && (
              <em id="review-release-evidence-quality">
                {t("evidenceIncomplete")}
              </em>
            )}
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={data.diffs.length > 0 ? "tone-neutral" : "tone-warn"}
          aria-label={t("reviewChangeEvidence")}
          onClick={onOpenDiff}
        >
          <GitCompareArrows size={17} aria-hidden="true" />
          <span>
            <small>{t("whatChanged")}</small>
            <strong>
              {data.diffs.length > 0
                ? t("changeEvidenceCount", { count: data.diffs.length })
                : t("noChangeEvidenceCaptured")}
            </strong>
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </section>

      <div className="review-body-grid">
        <section className="review-blockers" aria-labelledby="release-blockers-title">
          <header className="review-section-heading">
            <div>
              <span>{t("problemsToFix")}</span>
              <h3 id="release-blockers-title">
                {data.review.blockers.length > 0
                  ? t("releaseBlockerCount", { count: data.review.blockers.length })
                  : t(
                      noBlockersReady
                        ? "releaseBlockerNone"
                        : "noKnownBlockerEvidenceIncomplete",
                    )}
              </h3>
            </div>
            <CircleAlert size={17} aria-hidden="true" />
          </header>

          {data.review.blockers.map((blocker) => {
            const criterion = blocker.criterion_ids
              .map((criterionId) =>
                data.action_center.acceptance.criteria.find(
                  (candidate) => candidate.id === criterionId,
                ),
              )
              .find((candidate) => Boolean(candidate));
            const criterionEvidence = blocker.evidence_ids
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            if (blocker.kind === "criterion") {
              const primaryCriterionEvidence = criterionEvidence[0];
              return (
                <article className="review-blocker-card is-criterion" key={blocker.id}>
                  <header>
                    <div>
                      <span>
                        {criterion
                          ? t(`criterion_${criterion.id}`)
                          : blocker.id}
                      </span>
                      <p>
                        {criterion
                          ? t(`criterion_${criterion.id}_description`)
                          : t("criterionEvidenceUnavailable")}
                      </p>
                    </div>
                    <div className="review-blocker-owner">
                      <span>{localizeStatus(locale, blocker.status)}</span>
                      {blocker.attribution && (
                        <small>{t(attributionKeys[blocker.attribution])}</small>
                      )}
                    </div>
                  </header>

                  <div className="review-issue-explanation">
                    <div>
                      <span>{t("issueWhy")}</span>
                      <strong>
                        {criterion
                          ? t("criterionFailedSummary", {
                              passed: criterion.passed,
                              total: criterion.total,
                            })
                          : localizeStatus(locale, blocker.status)}
                      </strong>
                      <p>
                        {criterion
                          ? t(`criterion_${criterion.id}_description`)
                          : t("criterionEvidenceUnavailable")}
                      </p>
                    </div>
                    <div>
                      <span>{t("issueNextStep")}</span>
                      <strong>
                        {t(
                          attributionActionKeys[
                            blocker.attribution ?? "evidence"
                          ],
                        )}
                      </strong>
                      <p>
                        {criterionEvidence.length > 0
                          ? t("issueEvidenceCount", {
                              count: criterionEvidence.length,
                            })
                          : t("criterionEvidenceUnavailable")}
                      </p>
                    </div>
                  </div>

                  {primaryCriterionEvidence && (
                    <button
                      type="button"
                      className="review-evidence-action"
                      onClick={() => onOpenEvidence(primaryCriterionEvidence)}
                    >
                      <FileSearch size={14} aria-hidden="true" />
                      {t("openProblemEvidence")}
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </article>
              );
            }
            const item = blocker.case_id
              ? data.cases.find((candidate) => candidate.id === blocker.case_id) ?? null
              : null;
            const caseNode = blocker.case_id
              ? nodesById.get(`case:${blocker.case_id}`)
              : undefined;
            const caseSemantic = item
              ? describeDashboardCase(locale, item)
              : caseNode
                ? describeEvidenceNode(locale, caseNode, data.cases)
                : null;
            const gateNodes = blocker.gate_ids
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            const failedChecks = blocker.failed_check_ids
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            const sourceNodes = [
              ...blocker.source_evidence_ids,
              ...blocker.missing_artifact_ids,
            ]
              .map((id) => nodesById.get(id))
              .filter((node): node is SpineNode => Boolean(node));
            const primaryEvidence = failedChecks[0] ?? gateNodes[0] ?? caseNode;
            const primaryFailedCheck = failedChecks[0];
            const primaryGate = gateNodes[0];
            const primaryReason = primaryFailedCheck
              ? describeAssertionDecision(locale, primaryFailedCheck)?.observed ??
                describeEvidenceNode(locale, primaryFailedCheck, data.cases).description
              : primaryGate
                ? describeEvidenceNode(locale, primaryGate, data.cases).description
                : caseSemantic?.description;
            return (
              <article className="review-blocker-card" key={blocker.id}>
                <header>
                  <div>
                    <span>{caseSemantic?.title ?? blocker.id}</span>
                    <p>{caseSemantic?.description}</p>
                  </div>
                  <div className="review-blocker-owner">
                    <span>{localizeStatus(locale, blocker.status)}</span>
                    {blocker.attribution && (
                      <small>{t(attributionKeys[blocker.attribution])}</small>
                    )}
                  </div>
                </header>

                <div className="review-issue-explanation">
                  <div>
                    <span>{t("issueWhy")}</span>
                    <strong>
                      {primaryFailedCheck
                        ? describeEvidenceNode(locale, primaryFailedCheck, data.cases).title
                        : primaryGate
                          ? describeEvidenceNode(locale, primaryGate, data.cases).title
                          : t("scenarioDidNotPass")}
                    </strong>
                    <p>{primaryReason ?? t("noFailedCheckRecorded")}</p>
                  </div>
                  <div>
                    <span>{t("issueNextStep")}</span>
                    <strong>
                      {t(
                        attributionActionKeys[
                          blocker.attribution ?? "evidence"
                        ],
                      )}
                    </strong>
                    <p>
                      {t("issueEvidenceSummary", {
                        checks: failedChecks.length,
                        sources: sourceNodes.length,
                      })}
                    </p>
                  </div>
                </div>

                {primaryEvidence && (
                  <button
                    type="button"
                    className="review-evidence-action"
                    onClick={() => onOpenEvidence(primaryEvidence)}
                  >
                    <FileSearch size={14} aria-hidden="true" />
                    {t("openProblemEvidence")}
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                )}
              </article>
            );
          })}
          {data.review.blockers.length === 0 && (
            <div
              className={`review-no-blockers tone-${
                noBlockersReady ? "good" : "warn"
              }`}
              role="status"
              aria-label={t(noBlockersTitleKey)}
            >
              {noBlockersReady ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <CircleAlert size={16} aria-hidden="true" />
              )}
              <div>
                <strong>
                  {t(noBlockersTitleKey)}
                </strong>
                <p>
                  {noBlockersReady
                    ? t("readyForHumanConfirmation")
                    : automaticNoBlockers
                      ? t("automaticNoBlockerSummary")
                      : t("evidenceIncompleteReleaseBlocked")}
                </p>
              </div>
            </div>
          )}
        </section>

        <section className="review-next-action review-next-action-card">
          <div className="review-rail-label">
            <Bot size={14} aria-hidden="true" />
            {t("recommendedNextStep")}
          </div>
          <strong>{t(nextActionKey ?? "nextActionReviewEvidence")}</strong>
          <p>
            {t(
              automaticContinuation
                ? "automaticLeadAgentOwnerDescription"
                : "leadAgentOwnerDescription",
            )}
          </p>
          <button type="button" onClick={onOpenActionCenter}>
            {t("openActionCenter")}
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </section>
      </div>
    </div>
  );
}
