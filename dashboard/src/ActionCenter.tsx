import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  ClipboardCopy,
  Clock3,
  FilePenLine,
  HardDrive,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildAgentResumeInstructions,
  copyText,
  createDashboardActionTask,
  loadDashboardActionTasks,
} from "./dashboard-actions";
import type {
  ActionAttributionId,
  DashboardAgentHandoff,
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
  if (actionId === "prepare_audit") return ShieldCheck;
  if (actionId === "rerun_execution") return RefreshCw;
  if (actionId === "propose_eval_change") return FilePenLine;
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
  if (nextAction === "prepare_audit") return "action_prepare_audit";
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
  interactive = true,
  connectionState = "live",
}: {
  data: DashboardData;
  onOpenEvidence: (evidenceId: string) => void;
  interactive?: boolean;
  connectionState?: "connecting" | "live" | "stale";
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
  const [lastCreateWasNew, setLastCreateWasNew] = useState<boolean | null>(null);
  const [handoff, setHandoff] = useState<DashboardAgentHandoff | null>(null);
  const [currentDashboardDigest, setCurrentDashboardDigest] = useState<string | null>(null);
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);

  const refreshTasks = useCallback(async () => {
    if (!interactive) {
      setTaskLogState("ready");
      return;
    }
    setTaskLogState("loading");
    try {
      const log = await loadDashboardActionTasks(
        center.task_gateway.audit_endpoint,
        data.run.id,
      );
      setTasks(log.tasks);
      setHandoff(log.handoff);
      setCurrentDashboardDigest(log.current_dashboard_digest);
      setTaskLogState("ready");
    } catch {
      setTaskLogState("error");
    }
  }, [center.task_gateway.audit_endpoint, data.run.id, interactive]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const submitAction = useCallback(
    async (actionId: DashboardActionId) => {
      const action = center.actions.find((item) => item.id === actionId);
      if (!interactive || !action?.available || !action.requestable || submitting) return;
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
        setLastCreateWasNew(result.created);
        setHandoff(result.handoff);
        setTaskLogState("ready");
      } catch {
        setSubmitError(t("actionTaskCreateFailed"));
      } finally {
        setSubmitting(null);
      }
    }, [center, data.run.id, interactive, submitting, t],
  );

  const copyResumeInstructions = useCallback(
    async (task: DashboardActionTask) => {
      if (!handoff) return;
      setCopyError(false);
      try {
        await copyText(
          buildAgentResumeInstructions({ task, handoff, locale }),
        );
        setCopiedTaskId(task.id);
      } catch {
        setCopyError(true);
      }
    },
    [handoff, locale],
  );

  const primaryAttribution = center.attribution.primary;
  const automaticContinuation = center.continuation.mode === "automatic";
  const orderedAttributions = useMemo(
    () =>
      attributionOrder
        .map((id) => center.attribution.items.find((item) => item.id === id))
        .filter((item): item is DashboardData["action_center"]["attribution"]["items"][number] =>
          Boolean(item),
        ),
    [center.attribution.items],
  );
  const recommendedAction =
    center.actions.find((action) => action.available && action.recommended) ??
    center.actions.find((action) => action.available) ??
    null;
  const otherAvailableActions = center.actions.filter(
    (action) => action.available && action.id !== recommendedAction?.id,
  );
  const primaryAttributionItem = primaryAttribution
    ? orderedAttributions.find((item) => item.id === primaryAttribution) ?? null
    : null;
  const currentTasksByAction = useMemo(() => {
    const byAction = new Map<DashboardActionId, DashboardActionTask>();
    for (const task of tasks) {
      if (
        task.expected_next_action === center.next_action &&
        currentDashboardDigest !== null &&
        task.dashboard_digest === currentDashboardDigest
      ) {
        byAction.set(task.action_id, task);
      }
    }
    return byAction;
  }, [center.next_action, currentDashboardDigest, tasks]);
  const lastCreatedTask = lastCreatedId
    ? tasks.find((task) => task.id === lastCreatedId) ?? null
    : null;
  const sessionEnded = connectionState === "stale";

  return (
    <div className="action-center" aria-label={t("actionCenter")}>
      <header className="action-hero">
        <div className="action-hero-copy">
          <span className="pane-kicker">{t("humanDecisionHandoff")}</span>
          <h2>{t("actionCenter")}</h2>
          <p>{t("actionCenterDescription")}</p>
        </div>
      </header>

      {!interactive && !sessionEnded && (
        <div className="action-demo-notice" role="note">
          <LockKeyhole size={15} />
          <div>
            <strong>{t("hostedDemoActionsDisabled")}</strong>
            <p>{t("hostedDemoActionsDisabledDescription")}</p>
          </div>
        </div>
      )}

      <section className="agent-handoff-banner" aria-labelledby="agent-handoff-heading">
        <WifiOff size={18} aria-hidden="true" />
        <div>
          <span className="pane-kicker">{t("agentHandoffStatus")}</span>
          <strong id="agent-handoff-heading">
            {t(
              sessionEnded
                ? "dashboardSessionEndedTitle"
                : "agentSessionUnboundTitle",
            )}
          </strong>
          <p>
            {t(
              sessionEnded
                ? "dashboardSessionEndedDescription"
                : "agentSessionUnboundDescription",
            )}
          </p>
        </div>
        <div className="agent-handoff-facts" aria-label={t("agentHandoffFacts")}>
          <span><HardDrive size={13} /> {t("handoffStoredLocally")}</span>
          <span><Clock3 size={13} /> {t("handoffSurvivesSessionEnd")}</span>
        </div>
      </section>

      <section className="recommended-actions action-primary-section" aria-labelledby="recommended-heading">
        <div className="action-section-heading">
          <div>
            <h3 id="recommended-heading">{t("recommendedActions")}</h3>
          </div>
          <p>
            {t(
              automaticContinuation
                ? "automaticActionDescription"
                : "recommendedActionsDescription",
            )}
          </p>
        </div>
        {recommendedAction ? (() => {
          const Icon = actionIcon(recommendedAction.id);
          const isSubmitting = submitting === recommendedAction.id;
          const existingTask = currentTasksByAction.get(recommendedAction.id);
          return (
            <article className="action-primary-card">
              <span className="action-icon"><Icon size={18} /></span>
              <div className="action-copy">
                <span>
                  <strong>{t(`action_${recommendedAction.id}`)}</strong>
                  <em>{t("recommended")}</em>
                </span>
                <p>{t(`action_${recommendedAction.id}_description`)}</p>
                <small>
                  <Bot size={11} />{" "}
                  {t(
                    recommendedAction.execution_mode === "automatic"
                      ? "automaticLeadAgentOwnerDescription"
                      : "leadAgentOwnerDescription",
                  )}
                </small>
                {recommendedAction.human_confirmation_required && (
                  <small><LockKeyhole size={11} /> {t("humanConfirmationBoundary")}</small>
                )}
              </div>
              {recommendedAction.execution_mode === "automatic" ? (
                <span className="action-auto-status" role="status">
                  <Bot size={15} /> {t("automaticContinuation")}
                </span>
              ) : sessionEnded ? (
                <span className="action-auto-status is-stale" role="status">
                  <WifiOff size={14} /> {t("dashboardSessionEndedTitle")}
                </span>
              ) : recommendedAction.requestable ? (
                existingTask && handoff ? (
                  existingTask.id === lastCreatedId ? (
                    <span className="action-auto-status" role="status">
                      <HardDrive size={14} /> {t("handoffStoredLocally")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="is-secondary"
                      onClick={() => void copyResumeInstructions(existingTask)}
                    >
                      <ClipboardCopy size={13} />
                      {copiedTaskId === existingTask.id
                        ? t("agentResumeInstructionsCopied")
                        : t("copyAgentResumeInstructions")}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={!interactive || submitting !== null}
                    onClick={() => void submitAction(recommendedAction.id)}
                  >
                    {isSubmitting ? t("savingHandoff") : t("saveAgentHandoff")}
                  </button>
                )
              ) : null}
            </article>
          );
        })() : (
          <div className="action-primary-empty">
            <strong>{nextActionLabel}</strong>
            <p>{t("notAvailableInCurrentState")}</p>
          </div>
        )}
        {submitError && (
          <div className="action-submit-error" role="alert">
            <CircleAlert size={14} /> {submitError}
          </div>
        )}
        {lastCreatedTask && handoff && (
          <div className="action-handoff-receipt" role="status">
            <Clock3 size={16} aria-hidden="true" />
            <div>
              <strong>
                {t(
                  lastCreateWasNew
                    ? "handoffSavedTitle"
                    : "handoffAlreadyExistsTitle",
                )}
              </strong>
              <p>{t("handoffSavedDescription")}</p>
            </div>
            <button
              type="button"
              onClick={() => void copyResumeInstructions(lastCreatedTask)}
            >
              <ClipboardCopy size={13} />
              {copiedTaskId === lastCreatedTask.id
                ? t("agentResumeInstructionsCopied")
                : t("copyAgentResumeInstructions")}
            </button>
          </div>
        )}
        {copyError && (
          <div className="action-submit-error" role="alert">
            <CircleAlert size={14} /> {t("agentResumeInstructionsCopyFailed")}
          </div>
        )}
      </section>

      <section className="action-rationale" aria-labelledby="action-rationale-heading">
        <div className="action-section-heading">
          <div>
            <h3 id="action-rationale-heading">{t("whyRecommendedAction")}</h3>
          </div>
          <p>{t("whyRecommendedActionDescription")}</p>
        </div>
        <div className="action-rationale-grid">
          <article>
            <header>
              <strong>{t("candidateAcceptability")}</strong>
              <span>{localizeStatus(locale, center.acceptance.status)}</span>
            </header>
            <ul className="action-criteria-list">
              {center.acceptance.criteria.map((criterion) => (
                <li className={`is-${criterion.status}`} key={criterion.id}>
                  <span aria-hidden="true">
                    {criterion.status === "satisfied" ? (
                      <Check size={12} />
                    ) : criterion.status === "failed" ? (
                      <X size={12} />
                    ) : (
                      <Clock3 size={12} />
                    )}
                  </span>
                  <div>
                    <strong>{t(`criterion_${criterion.id}`)}</strong>
                    <small>{t(`criterion_${criterion.id}_description`)}</small>
                  </div>
                  <em>{criterion.total > 0 ? `${criterion.passed}/${criterion.total}` : "—"}</em>
                </li>
              ))}
            </ul>
          </article>
          <article>
            <header>
              <strong>{t("failureAttribution")}</strong>
              <span>
                {primaryAttribution
                  ? t(`attribution_${primaryAttribution}`)
                  : t("noFailureAttributed")}
              </span>
            </header>
            {primaryAttributionItem ? (
              <>
                <p>{t(`attribution_${primaryAttributionItem.id}_description`)}</p>
                {primaryAttributionItem.signals.length > 0 && (
                  <ul className="action-signal-list">
                    {primaryAttributionItem.signals.map((signal) => (
                      <li key={signal}>
                        {t(signalMessageKeys[signal] ?? "unknownAttributionSignal")}
                      </li>
                    ))}
                  </ul>
                )}
                {primaryAttributionItem.evidence_ids.length > 0 && (
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => onOpenEvidence(primaryAttributionItem.evidence_ids[0]!)}
                  >
                    {t("openAttributionEvidence")}
                    <ArrowRight size={12} />
                  </button>
                )}
              </>
            ) : (
              <p>{t("noFailureAttributed")}</p>
            )}
          </article>
        </div>
      </section>

      {otherAvailableActions.length > 0 && (
        <section className="other-actions" aria-labelledby="other-actions-heading">
          <div className="action-section-heading">
            <div><h3 id="other-actions-heading">{t("otherAvailableActions")}</h3></div>
            <p>{t("otherAvailableActionsDescription")}</p>
          </div>
          <div className="action-queue">
            {otherAvailableActions.map((action) => {
              const Icon = actionIcon(action.id);
              const isSubmitting = submitting === action.id;
              const existingTask = currentTasksByAction.get(action.id);
              return (
                <article className="action-row is-available" key={action.id}>
                  <span className="action-icon"><Icon size={17} /></span>
                  <div className="action-copy">
                    <strong>{t(`action_${action.id}`)}</strong>
                    <p>{t(`action_${action.id}_description`)}</p>
                  </div>
                  {action.execution_mode === "automatic" ? (
                    <span className="action-auto-status">
                      <Bot size={14} /> {t("automaticContinuation")}
                    </span>
                  ) : sessionEnded ? (
                    <span className="action-auto-status is-stale" role="status">
                      <WifiOff size={14} /> {t("dashboardSessionEndedTitle")}
                    </span>
                  ) : action.requestable ? (
                    existingTask && handoff ? (
                      existingTask.id === lastCreatedId ? (
                        <span className="action-auto-status" role="status">
                          <HardDrive size={14} /> {t("handoffStoredLocally")}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void copyResumeInstructions(existingTask)}
                        >
                          <ClipboardCopy size={13} />
                          {copiedTaskId === existingTask.id
                            ? t("agentResumeInstructionsCopied")
                            : t("copyAgentResumeInstructions")}
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        disabled={!interactive || submitting !== null}
                        onClick={() => void submitAction(action.id)}
                      >
                        {isSubmitting ? t("savingHandoff") : t("saveAgentHandoff")}
                      </button>
                    )
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="intervention-policy" aria-labelledby="intervention-policy-heading">
        <div className="action-section-heading">
          <div><h3 id="intervention-policy-heading">{t("interventionPolicy")}</h3></div>
          <p>{t("interventionPolicyDescription")}</p>
        </div>
        <div className="intervention-policy-grid">
          <article>
            <Bot size={16} />
            <div>
              <strong>{t("agentAutomaticBoundary")}</strong>
              <p>{t("agentAutomaticBoundaryDescription")}</p>
            </div>
          </article>
          <article>
            <UserRoundCheck size={16} />
            <div>
              <strong>{t("humanInterventionBoundary")}</strong>
              <p>{t("humanInterventionBoundaryDescription")}</p>
            </div>
          </article>
        </div>
      </section>

      <details className="task-audit">
        <summary id="task-audit-heading">{t("taskAuditTrail")}</summary>
        <div className="action-section-heading compact">
          <div><p>{t("taskAuditDescription")}</p></div>
          <button
            type="button"
            className="text-action"
            disabled={!interactive}
            onClick={() => void refreshTasks()}
          >
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
                <div className="task-audit-actions">
                  <em>
                    {task.expected_next_action === center.next_action &&
                    task.dashboard_digest === currentDashboardDigest
                      ? t("taskAwaitingAgent")
                      : t("taskNeedsRevalidation")}
                  </em>
                  {handoff && (
                    <button
                      type="button"
                      aria-label={t("copyTaskResumeInstructions", { id: task.id })}
                      title={t("copyAgentResumeInstructions")}
                      onClick={() => void copyResumeInstructions(task)}
                    >
                      {copiedTaskId === task.id ? <Check size={12} /> : <ClipboardCopy size={12} />}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}

export function ActionAuditGuide({
  data,
  connectionState = "live",
}: {
  data: DashboardData;
  connectionState?: "connecting" | "live" | "stale";
}) {
  const { t } = useUiPreferences();
  const automaticContinuation =
    data.action_center.continuation.mode === "automatic";
  const sessionEnded = connectionState === "stale";
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
        <p>
          {t(
            automaticContinuation
              ? "automaticLeadAgentOwnerDescription"
              : "leadAgentOwnerDescription",
          )}
        </p>
      </section>
      <section>
        <span className="section-label"><WifiOff size={13} /> {t("agentHandoffStatus")}</span>
        <h3>{t(sessionEnded ? "dashboardSessionEndedTitle" : "agentSessionUnboundTitle")}</h3>
        <p>{t(sessionEnded ? "dashboardSessionEndedDescription" : "agentSessionUnboundDescription")}</p>
      </section>
      <section>
        <span className="section-label">
          <ShieldCheck size={13} />{" "}
          {t(automaticContinuation ? "automaticExecutionSteps" : "whenCreatingTask")}
        </span>
        <ol className="action-inspector-steps">
          {automaticContinuation ? (
            <>
              <li>{t("automaticStepPrecondition")}</li>
              <li>{t("automaticStepExecute")}</li>
              <li>{t("automaticStepEvidence")}</li>
              <li>{t("automaticStepProject")}</li>
            </>
          ) : (
            <>
              <li>{t("taskStepSnapshot")}</li>
              <li>{t("taskStepPrecondition")}</li>
              <li>{t("taskStepAudit")}</li>
              <li>{t("taskStepAgent")}</li>
            </>
          )}
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
