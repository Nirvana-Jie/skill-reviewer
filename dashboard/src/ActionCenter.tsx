import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  FilePenLine,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createDashboardActionTask,
  loadDashboardActionTasks,
} from "./dashboard-actions";
import type {
  ActionAttributionId,
  DashboardActionId,
  DashboardActionTask,
  DashboardData,
} from "./types";
import {
  localizeStatus,
  useUiPreferences,
  type MessageKey,
} from "./ui-preferences";

const attributionOrder: ActionAttributionId[] = [
  "skill",
  "eval",
  "execution_environment",
  "evidence",
  "human",
];

function actionIcon(actionId: DashboardActionId) {
  if (actionId === "generate_candidate") return Sparkles;
  if (actionId === "rerun_execution") return RefreshCw;
  if (actionId === "propose_eval_change") return FilePenLine;
  if (actionId === "authorize_audit") return ShieldCheck;
  return UserRoundCheck;
}

function taskKey(actionId: DashboardActionId): string {
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `${actionId}-${Date.now().toString(36)}-${random}`;
}

const signalMessageKeys: Record<string, MessageKey> = {
  binding_error: "signal_binding_error",
  candidate_evidence_incomplete: "signal_candidate_evidence_incomplete",
  required_assertion_failed: "signal_required_assertion_failed",
  unsafe_behavior_observed: "signal_unsafe_behavior_observed",
  objective_regressed: "signal_objective_regressed",
  stochastic_direction_disagreement: "signal_stochastic_direction_disagreement",
  objective_metric_unavailable: "signal_objective_metric_unavailable",
  baseline_evidence_incomplete: "signal_baseline_evidence_incomplete",
  pareto_regression: "signal_pareto_regression",
  material_improvement_missing: "signal_material_improvement_missing",
  objective_evidence_missing: "signal_objective_evidence_missing",
  declared_metric_missing: "signal_declared_metric_missing",
  paired_evidence_missing: "signal_paired_evidence_missing",
  audit_authorization_required: "signal_audit_authorization_required",
  release_confirmation_required: "signal_release_confirmation_required",
};

export function nextActionMessageKey(nextAction: string): MessageKey | null {
  if (nextAction === "propose_candidate") return "action_generate_candidate";
  if (
    nextAction === "run_authorized_selection" ||
    nextAction === "run_authorized_audit"
  ) {
    return "action_rerun_execution";
  }
  if (nextAction === "authorize_audit") return "action_authorize_audit";
  if (nextAction === "request_user_release") {
    return "action_request_release_confirmation";
  }
  if (nextAction === "stop") return "nextActionStop";
  if (nextAction === "review_evidence") return "nextActionReviewEvidence";
  return null;
}

export function ActionCenter({
  data,
  onOpenEvidence,
}: {
  data: DashboardData;
  onOpenEvidence: (evidenceId: string) => void;
}) {
  const { locale, t } = useUiPreferences();
  const center = data.action_center;
  const nextActionLabel = t(nextActionMessageKey(center.next_action) ?? "nextActionReviewEvidence");
  const [tasks, setTasks] = useState<DashboardActionTask[]>([]);
  const [taskLogState, setTaskLogState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [submitting, setSubmitting] = useState<DashboardActionId | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);

  const refreshTasks = useCallback(async () => {
    setTaskLogState("loading");
    try {
      const log = await loadDashboardActionTasks(
        center.task_gateway.audit_endpoint,
        data.run.id,
      );
      setTasks(log.tasks);
      setTaskLogState("ready");
    } catch {
      setTaskLogState("error");
    }
  }, [center.task_gateway.audit_endpoint, data.run.id]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const submitAction = useCallback(
    async (actionId: DashboardActionId) => {
      const action = center.actions.find((item) => item.id === actionId);
      if (!action?.available || submitting) return;
      setSubmitting(actionId);
      setSubmitError(null);
      try {
        const result = await createDashboardActionTask({
          endpoint: center.task_gateway.request_endpoint,
          runId: data.run.id,
          actionId,
          expectedNextAction: center.next_action,
          evidenceIds: action.evidence_ids,
          idempotencyKey: taskKey(actionId),
        });
        setTasks((current) => {
          const withoutDuplicate = current.filter((task) => task.id !== result.task.id);
          return [...withoutDuplicate, result.task].sort(
            (left, right) => left.sequence - right.sequence,
          );
        });
        setLastCreatedId(result.task.id);
        setTaskLogState("ready");
      } catch {
        setSubmitError(t("actionTaskCreateFailed"));
      } finally {
        setSubmitting(null);
      }
    }, [center, data.run.id, submitting, t],
  );

  const primaryAttribution = center.attribution.primary;
  const orderedAttributions = useMemo(
    () =>
      attributionOrder
        .map((id) => center.attribution.items.find((item) => item.id === id))
        .filter((item): item is DashboardData["action_center"]["attribution"]["items"][number] =>
          Boolean(item),
        ),
    [center.attribution.items],
  );

  return (
    <div className="action-center" aria-label={t("actionCenter")}>
      <header className="action-hero">
        <div className="action-hero-copy">
          <span className="pane-kicker">{t("humanDecisionHandoff")}</span>
          <h2>{t("actionCenter")}</h2>
          <p>{t("actionCenterDescription")}</p>
        </div>
        <div className="state-handoff" aria-label={t("currentStateAndNextAction")}>
          <span>
            <small>{t("currentState")}</small>
            <strong>{localizeStatus(locale, data.run.status)}</strong>
          </span>
          <ArrowRight size={16} aria-hidden="true" />
          <span className="state-handoff-next">
            <small>{t("stateMachineNextAction")}</small>
            <strong>{nextActionLabel}</strong>
          </span>
          <em>
            <Bot size={14} /> {t("leadAgentOwner")}
          </em>
        </div>
      </header>

      <section className="acceptance-section" aria-labelledby="acceptance-heading">
        <div className="action-section-heading">
          <div>
            <span className="section-index">01</span>
            <h3 id="acceptance-heading">{t("candidateAcceptability")}</h3>
          </div>
          <p>{t("candidateAcceptabilityDescription")}</p>
        </div>
        <div className="decision-rail">
          <div className="decision-criteria">
            {center.acceptance.criteria.map((criterion) => {
              const satisfied = criterion.status === "satisfied";
              const failed = criterion.status === "failed";
              return (
                <article
                  className={`decision-criterion is-${criterion.status}`}
                  key={criterion.id}
                >
                  <span className="criterion-state" aria-hidden="true">
                    {satisfied ? (
                      <Check size={13} />
                    ) : failed ? (
                      <X size={13} />
                    ) : (
                      <Clock3 size={13} />
                    )}
                  </span>
                  <div>
                    <strong>{t(`criterion_${criterion.id}`)}</strong>
                    <p>{t(`criterion_${criterion.id}_description`)}</p>
                  </div>
                  <span className="criterion-score">
                    {criterion.total > 0
                      ? `${criterion.passed}/${criterion.total}`
                      : t("awaitingEvidence")}
                  </span>
                </article>
              );
            })}
          </div>
          <div className={`acceptance-verdict is-${center.acceptance.status}`}>
            <small>{t("candidateVerdict")}</small>
            <strong>{localizeStatus(locale, center.acceptance.status)}</strong>
            <p>
              {center.acceptance.accepted === true
                ? t("allAcceptanceConditionsMet")
                : center.acceptance.accepted === false
                  ? t("acceptanceConditionsNotMet")
                  : t("acceptancePendingEvidence")}
            </p>
          </div>
        </div>
      </section>

      <section className="attribution-section" aria-labelledby="attribution-heading">
        <div className="action-section-heading">
          <div>
            <span className="section-index">02</span>
            <h3 id="attribution-heading">{t("failureAttribution")}</h3>
          </div>
          <p>
            {primaryAttribution
              ? t("primaryAttributionSummary", {
                  owner: t(`attribution_${primaryAttribution}`),
                })
              : t("noFailureAttributed")}
          </p>
        </div>
        <div className="attribution-grid">
          {orderedAttributions.map((item) => (
            <article className={`attribution-item is-${item.status}`} key={item.id}>
              <header>
                <strong>{t(`attribution_${item.id}`)}</strong>
                <span>{t(`attributionStatus_${item.status}`)}</span>
              </header>
              <p>{t(`attribution_${item.id}_description`)}</p>
              {item.signals.length > 0 ? (
                <ul>
                  {item.signals.map((signal) => (
                    <li key={signal}>
                      {t(signalMessageKeys[signal] ?? "unknownAttributionSignal")}
                    </li>
                  ))}
                </ul>
              ) : (
                <small>{t("noAttributionSignal")}</small>
              )}
              {item.evidence_ids.length > 0 && (
                <button
                  type="button"
                  className="text-action"
                  onClick={() => onOpenEvidence(item.evidence_ids[0]!)}
                >
                  {t("openAttributionEvidence")}
                  <ArrowRight size={12} />
                </button>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="recommended-actions" aria-labelledby="recommended-heading">
        <div className="action-section-heading">
          <div>
            <span className="section-index">03</span>
            <h3 id="recommended-heading">{t("recommendedActions")}</h3>
          </div>
          <p>{t("recommendedActionsDescription")}</p>
        </div>
        <div className="action-queue">
          {center.actions.map((action) => {
            const Icon = actionIcon(action.id);
            const isSubmitting = submitting === action.id;
            return (
              <article
                className={`action-row ${action.recommended ? "is-recommended" : ""} ${
                  action.available ? "is-available" : "is-unavailable"
                }`}
                key={action.id}
              >
                <span className="action-icon"><Icon size={17} /></span>
                <div className="action-copy">
                  <span>
                    <strong>{t(`action_${action.id}`)}</strong>
                    {action.recommended && <em>{t("recommended")}</em>}
                  </span>
                  <p>{t(`action_${action.id}_description`)}</p>
                  {action.human_confirmation_required && (
                    <small><LockKeyhole size={11} /> {t("humanConfirmationBoundary")}</small>
                  )}
                </div>
                <button
                  type="button"
                  disabled={!action.available || submitting !== null}
                  onClick={() => void submitAction(action.id)}
                >
                  {isSubmitting
                    ? t("creatingTask")
                    : action.available
                      ? t("createLeadAgentTask")
                      : t("notAvailableInCurrentState")}
                </button>
              </article>
            );
          })}
        </div>
        {submitError && (
          <div className="action-submit-error" role="alert">
            <CircleAlert size={14} /> {submitError}
          </div>
        )}
      </section>

      <section className="task-audit" aria-labelledby="task-audit-heading">
        <div className="action-section-heading compact">
          <div>
            <span className="section-index">04</span>
            <h3 id="task-audit-heading">{t("taskAuditTrail")}</h3>
          </div>
          <button type="button" className="text-action" onClick={() => void refreshTasks()}>
            <RefreshCw size={12} /> {t("refreshTaskAudit")}
          </button>
        </div>
        {taskLogState === "loading" && tasks.length === 0 ? (
          <p className="task-audit-empty">{t("loadingTaskAudit")}</p>
        ) : taskLogState === "error" && tasks.length === 0 ? (
          <p className="task-audit-empty is-error">{t("taskAuditUnavailable")}</p>
        ) : tasks.length === 0 ? (
          <p className="task-audit-empty">{t("noActionTasks")}</p>
        ) : (
          <ol className="task-audit-list">
            {[...tasks].reverse().map((task) => (
              <li className={task.id === lastCreatedId ? "is-new" : ""} key={task.id}>
                <span>{String(task.sequence).padStart(2, "0")}</span>
                <div>
                  <strong>{t(`action_${task.action_id}`)}</strong>
                  <small>
                    {new Intl.DateTimeFormat(locale, {
                      month: "short",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(task.created_at))}
                    {" · "}{t("taskOwnedByLeadAgent")}
                  </small>
                </div>
                <em>{t("taskRequested")}</em>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export function ActionAuditGuide({ data }: { data: DashboardData }) {
  const { t } = useUiPreferences();
  const nextActionLabel = t(
    nextActionMessageKey(data.action_center.next_action) ??
      "nextActionReviewEvidence",
  );
  return (
    <div className="action-inspector-body">
      <div className="action-inspector-state">
        <span>{t("stateMachineNextAction")}</span>
        <strong>{nextActionLabel}</strong>
        <p>{t("nextActionComesFromStateMachine")}</p>
      </div>
      <section>
        <span className="section-label"><Bot size={13} /> {t("executionOwner")}</span>
        <h3>{t("leadAgentOwner")}</h3>
        <p>{t("leadAgentOwnerDescription")}</p>
      </section>
      <section>
        <span className="section-label"><ShieldCheck size={13} /> {t("whenCreatingTask")}</span>
        <ol className="action-inspector-steps">
          <li>{t("taskStepSnapshot")}</li>
          <li>{t("taskStepPrecondition")}</li>
          <li>{t("taskStepAudit")}</li>
          <li>{t("taskStepAgent")}</li>
        </ol>
      </section>
      <section className="control-boundary">
        <span className="section-label"><LockKeyhole size={13} /> {t("controlBoundary")}</span>
        <div><Check size={13} /><span><strong>{t("evidenceRemainsReadOnly")}</strong><small>{t("evidenceRemainsReadOnlyDescription")}</small></span></div>
        <div><Check size={13} /><span><strong>{t("evalRemainsImmutable")}</strong><small>{t("evalRemainsImmutableDescription")}</small></span></div>
      </section>
      <details className="inline-technical-facts">
        <summary>{t("technicalTrace")}</summary>
        <code>{data.action_center.task_gateway.request_endpoint}</code>
        <code>{data.action_center.task_gateway.audit_endpoint}</code>
      </details>
    </div>
  );
}
