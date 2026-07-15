import {
  Activity,
  Archive,
  Beaker,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileCheck2,
  FileText,
  Fingerprint,
  GitCompareArrows,
  Languages,
  LockKeyhole,
  Maximize2,
  Minimize2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import type { DashboardCase, DashboardData, SpineNode } from "./types";
import {
  localizeStatus,
  localizeValue,
  useUiPreferences,
} from "./ui-preferences";

type SplitFilter = "all" | DashboardCase["split"];
type ConnectionState = "connecting" | "live" | "stale";
type CanvasView = "evidence" | "diff";

const DiffViewer = lazy(() => import("./DiffViewer"));

const splitOptions: SplitFilter[] = ["all", "development", "selection", "audit"];

const iconByKind = {
  run: Activity,
  gate: ShieldCheck,
  iteration: GitCompareArrows,
  case: Beaker,
  assertion: FileCheck2,
  artifact: Archive,
} satisfies Record<SpineNode["kind"], typeof Activity>;

function statusTone(status: string): "good" | "bad" | "warn" | "neutral" {
  const normalized = status.toLowerCase();
  if (
    [
      "passed",
      "accepted",
      "audit-passed",
      "retained",
      "regression-verified",
      "behavior-verified",
    ].some((value) => normalized.includes(value))
  ) {
    return "good";
  }
  if (
    [
      "failed",
      "rejected",
      "regressed",
      "audit-failed",
      "invalid",
      "stale",
      "disagreement",
    ].some((value) => normalized.includes(value))
  ) {
    return "bad";
  }
  if (
    [
      "pending",
      "awaiting",
      "inconclusive",
      "incomplete",
      "missing",
      "no-change",
      "exhausted",
    ].some((value) => normalized.includes(value))
  ) {
    return "warn";
  }
  return "neutral";
}

function shortDigest(digest: string | null | undefined, fallback: string): string {
  if (!digest) return fallback;
  return `${digest.slice(0, 8)}…${digest.slice(-6)}`;
}

function percent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "—";
}

function StatusChip({ status }: { status: string }) {
  const { locale } = useUiPreferences();
  return (
    <span
      className={`status-chip status-${statusTone(status)}`}
      title={locale === "zh-CN" ? status : undefined}
    >
      {localizeStatus(locale, status)}
    </span>
  );
}

function nodeDepth(node: SpineNode, nodesById: Map<string, SpineNode>): number {
  let depth = 0;
  let parentId = node.parent_id;
  const visited = new Set<string>();
  while (parentId && depth < 3 && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = nodesById.get(parentId)?.parent_id ?? null;
  }
  return depth;
}

function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const dataUrl =
    import.meta.env.VITE_DASHBOARD_DATA_URL ?? "/dashboard-data.json";

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const refresh = async () => {
      try {
        const response = await fetch(dataUrl, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`read model returned ${response.status}`);
        }
        const next = (await response.json()) as DashboardData;
        if (next.contract !== "skill-reviewer.dashboard-data") {
          throw new Error(
            `unsupported dashboard contract: ${String(next.contract)}`,
          );
        }
        if (!active) return;
        setData(next);
        setError(null);
        setConnectionState("live");
        window.clearTimeout(timer);
        timer = window.setTimeout(
          refresh,
          Math.max(next.refresh_interval_ms, 1000),
        );
      } catch (cause) {
        if (!active) return;
        setError(
          cause instanceof Error ? cause.message : "unable to read dashboard data",
        );
        setConnectionState((current) =>
          current === "live" ? "stale" : "connecting",
        );
        window.clearTimeout(timer);
        timer = window.setTimeout(refresh, 3000);
      }
    };

    void refresh();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [dataUrl]);

  return { data, error, connectionState };
}

const splitMessageKeys = {
  all: "all",
  development: "development",
  selection: "selection",
  audit: "audit",
} as const;

function DisplayPreferences() {
  const { locale, theme, setLocale, setTheme, t } = useUiPreferences();
  const nextTheme = theme === "light" ? "dark" : "light";

  return (
    <div className="display-controls" aria-label={t("displayPreferences")}>
      <div className="locale-control" role="group" aria-label={t("language")}>
        <Languages size={13} aria-hidden="true" />
        <button
          type="button"
          className={locale === "en" ? "is-active" : ""}
          aria-label={t("switchToEnglish")}
          aria-pressed={locale === "en"}
          onClick={() => setLocale("en")}
        >
          EN
        </button>
        <button
          type="button"
          className={locale === "zh-CN" ? "is-active" : ""}
          aria-label={t("switchToChinese")}
          aria-pressed={locale === "zh-CN"}
          onClick={() => setLocale("zh-CN")}
        >
          中
        </button>
      </div>
      <button
        type="button"
        className="theme-control"
        aria-label={
          nextTheme === "dark" ? t("switchToDarkTheme") : t("switchToLightTheme")
        }
        title={
          nextTheme === "dark" ? t("switchToDarkTheme") : t("switchToLightTheme")
        }
        onClick={() => setTheme(nextTheme)}
      >
        <span className="theme-swatch" aria-hidden="true" />
        <span>{nextTheme === "dark" ? t("darkTheme") : t("lightTheme")}</span>
      </button>
    </div>
  );
}

export function EvidenceDashboard({
  data,
  connectionState,
}: {
  data: DashboardData;
  connectionState: ConnectionState;
}) {
  const { locale, t } = useUiPreferences();
  const [split, setSplit] = useState<SplitFilter>("all");
  const [selectedId, setSelectedId] = useState(data.spine[0]?.id ?? "");
  const [canvasView, setCanvasView] = useState<CanvasView>("evidence");
  const [focusMode, setFocusMode] = useState(false);

  const visibleCases = useMemo(
    () => data.cases.filter((item) => split === "all" || item.split === split),
    [data.cases, split],
  );
  const visibleCaseNodeIds = useMemo(
    () => new Set(visibleCases.map((item) => `case:${item.id}`)),
    [visibleCases],
  );
  const visibleNodes = useMemo(
    () =>
      data.spine.filter((node) => {
        if (split === "all") return true;
        if (
          node.kind === "run" ||
          node.kind === "gate" ||
          node.kind === "iteration"
        ) {
          return true;
        }
        if (node.kind === "case") return visibleCaseNodeIds.has(node.id);
        return node.parent_id ? visibleCaseNodeIds.has(node.parent_id) : false;
      }),
    [data.spine, split, visibleCaseNodeIds],
  );
  const nodesById = useMemo(
    () => new Map(data.spine.map((node) => [node.id, node])),
    [data.spine],
  );

  useEffect(() => {
    if (!visibleNodes.some((node) => node.id === selectedId)) {
      setSelectedId(visibleNodes[0]?.id ?? "");
    }
  }, [selectedId, visibleNodes]);

  useEffect(() => {
    if (canvasView !== "diff") setFocusMode(false);
  }, [canvasView]);

  const selected =
    data.spine.find((node) => node.id === selectedId) ?? visibleNodes[0];
  const selectedCase =
    selected?.kind === "case"
      ? data.cases.find((item) => `case:${item.id}` === selected.id)
      : null;
  const runTone = statusTone(data.run.status);
  const releaseMessage = data.run.release_eligible
    ? t("releaseEligible")
    : t("releaseBlocked");

  return (
    <main className={`app-shell ${focusMode ? "is-focus-mode" : ""}`}>
      <h1 className="sr-only">{t("appTitle")}</h1>

      <header className="app-chrome">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            SR
          </span>
          <div className="brand-copy">
            <strong>Skill Reviewer</strong>
            <span>/</span>
            <span>{t("brandEvidence")}</span>
          </div>
        </div>

        <div className="chrome-utilities">
          <div className="run-identity">
            <span className={`live-dot live-${connectionState}`} aria-hidden="true" />
            <span className="connection-label">
              {t(connectionState)}
            </span>
            <code>{data.run.id}</code>
            <StatusChip status={data.run.verification_level} />
            <StatusChip status={data.run.status} />
            <span className="readonly-pill">
              <LockKeyhole size={12} /> {t("readOnly")}
            </span>
          </div>
          <DisplayPreferences />
        </div>
      </header>

      <section
        className={`run-summary summary-${runTone}`}
        aria-label={t("behavioralGateState")}
      >
        <div className="release-state">
          <span>{t("releaseState")}</span>
          <strong>{localizeStatus(locale, data.run.status)}</strong>
        </div>
        <div className="summary-metrics" role="list" aria-label={t("runSummary")}>
          <div role="listitem">
            <span>{t("hardGates")}</span>
            <strong>
              {data.summary.hard_gates_passed} / {data.summary.hard_gates_total}
            </strong>
          </div>
          <div role="listitem">
            <span>{t("casesPassed")}</span>
            <strong>
              {data.summary.candidate_passed} / {data.summary.case_count}
            </strong>
          </div>
          <div role="listitem">
            <span>{t("round")}</span>
            <strong>
              {data.summary.current_round ?? "—"} / {data.summary.max_rounds}
            </strong>
          </div>
          <div role="listitem">
            <span>{t("evidence")}</span>
            <strong>{localizeValue(locale, data.run.evidence_scope)}</strong>
          </div>
        </div>
        <div className="integrity-mark">
          {data.run.integrity?.verified ? (
            <ShieldCheck size={15} />
          ) : (
            <CircleAlert size={15} />
          )}
          <span>
            {data.run.integrity?.verified ? t("inputsLocked") : t("integrityPending")}
            <small>{releaseMessage}</small>
          </span>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="rail pane" aria-label={t("runOverview")}>
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">{t("evaluationSuite")}</span>
              <h2>{t("cases")}</h2>
            </div>
            <span className="count-badge">{visibleCases.length}</span>
          </div>

          <div className="filter-block">
            <div className="section-label">
              <SlidersHorizontal size={13} /> {t("split")}
            </div>
            <div className="segmented-control">
              {splitOptions.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={split === item ? "is-active" : ""}
                  aria-pressed={split === item}
                  onClick={() => setSplit(item)}
                >
                  {t(splitMessageKeys[item])}
                </button>
              ))}
            </div>
          </div>

          <div className="case-list" aria-live="polite">
            {visibleCases.map((item) => (
              <button
                type="button"
                className={`case-row ${
                  selectedId === `case:${item.id}` ? "is-selected" : ""
                }`}
                key={item.id}
                onClick={() => setSelectedId(`case:${item.id}`)}
              >
                <span
                  className={`case-status status-${statusTone(item.status)}`}
                  aria-hidden="true"
                />
                <span className="case-copy">
                  <strong>{item.id}</strong>
                  <small>
                    {localizeValue(locale, item.split)} ·{" "}
                    {localizeValue(locale, item.holdout_visibility)}
                  </small>
                  <small>
                    {t("pairedRuns", {
                      count: item.determinism === "stochastic" ? item.repeats : 1,
                    })}
                  </small>
                </span>
                <StatusChip status={item.status} />
              </button>
            ))}
            {visibleCases.length === 0 && (
              <p className="empty-note">{t("noCasesInSplit")}</p>
            )}
          </div>

          <div className="evolution-summary">
            <div className="section-label">
              <GitCompareArrows size={13} /> {t("evolution")}
            </div>
            <div className="query-grid">
              <div>
                <span>{t("selection")}</span>
                <strong>
                  {data.summary.selection_queries} / {data.evolution.selection_query_limit}
                </strong>
              </div>
              <div>
                <span>{t("audit")}</span>
                <strong>
                  {data.summary.audit_queries} / {data.evolution.audit_query_limit}
                </strong>
              </div>
            </div>
            <p>
              {t("continuitySummary", {
                epoch: data.summary.continuity_epoch ?? "—",
                count: data.summary.rejected_candidates,
              })}
            </p>
            <div className="lineage-list" aria-label={t("candidateLineage")}>
              {data.evolution.candidate_lineage.slice(-2).map((candidate) => (
                <div key={`${candidate.run_id}-${candidate.round}`}>
                  <span>R{candidate.round ?? "—"}</span>
                  <code>{shortDigest(candidate.candidate_digest, t("notRecorded"))}</code>
                  <em>{localizeValue(locale, candidate.continuity ?? "continue")}</em>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <section className="evidence-canvas pane" aria-label={t("evidenceWorkspace")}>
          <div className="canvas-toolbar">
            <div className="canvas-switch" aria-label={t("canvasView")}>
              <button
                type="button"
                className={canvasView === "evidence" ? "is-active" : ""}
                aria-pressed={canvasView === "evidence"}
                onClick={() => setCanvasView("evidence")}
              >
                {t("evidence")}
              </button>
              <button
                type="button"
                className={canvasView === "diff" ? "is-active" : ""}
                aria-pressed={canvasView === "diff"}
                onClick={() => setCanvasView("diff")}
              >
                {t("diff")} ({data.diffs.length})
              </button>
            </div>
            <div className="canvas-context">
              <span>
                {canvasView === "evidence"
                  ? t("retainedNodes", { count: visibleNodes.length })
                  : t("runtimeFilesChanged", { count: data.diffs.length })}
              </span>
              {canvasView === "diff" && data.diffs.length > 0 && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={focusMode ? t("exitDiffFocus") : t("enterDiffFocus")}
                  title={focusMode ? t("exitFocus") : t("focusOnDiff")}
                  onClick={() => setFocusMode((current) => !current)}
                >
                  {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
              )}
            </div>
          </div>

          {canvasView === "evidence" ? (
            <div className="evidence-stage">
              <div className="stage-intro">
                <div>
                  <span className="pane-kicker">{t("immutableRunRecord")}</span>
                  <h2>{t("evidenceChain")}</h2>
                  <p>{t("evidenceChainDescription")}</p>
                </div>
                <div className="legend" aria-label={t("statusLegend")}>
                  <span><i className="legend-dot good" /> {t("passed")}</span>
                  <span><i className="legend-dot warn" /> {t("pending")}</span>
                  <span><i className="legend-dot bad" /> {t("blocked")}</span>
                </div>
              </div>

              <div className="evidence-list">
                {visibleNodes.map((node) => {
                  const Icon = iconByKind[node.kind];
                  const depth = nodeDepth(node, nodesById);
                  return (
                    <button
                      type="button"
                      className={`evidence-row tone-${statusTone(node.status)} ${
                        selectedId === node.id ? "is-selected" : ""
                      }`}
                      key={node.id}
                      aria-label={t("openEvidence", { label: node.label })}
                      onClick={() => setSelectedId(node.id)}
                      style={{ "--node-depth": depth } as React.CSSProperties}
                    >
                      <span className="node-icon">
                        <Icon size={15} strokeWidth={1.8} />
                      </span>
                      <span className="node-copy">
                        <span className="node-meta">
                          {localizeValue(locale, node.kind)}
                          {node.arm ? ` · ${node.arm}` : ""}
                          {node.repeat
                            ? ` · ${t("repeatMeta", { count: node.repeat })}`
                            : ""}
                        </span>
                        <strong>{node.label}</strong>
                        <small>
                          {node.detail ?? node.path ?? t("retainedEvidenceRecord")}
                        </small>
                      </span>
                      <StatusChip status={node.status} />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : data.diffs.length ? (
            <Suspense
              fallback={
                <div className="diff-empty">
                  <p>{t("loadingDiffRenderer")}</p>
                </div>
              }
            >
              <DiffViewer diffs={data.diffs} />
            </Suspense>
          ) : (
            <div className="diff-empty">
              <GitCompareArrows size={24} />
              <strong>{t("noRuntimeChanges")}</strong>
              <p>{t("candidateMatchesRuntime")}</p>
            </div>
          )}
        </section>

        <aside className="inspector pane" aria-label={t("evidenceInspector")}>
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">{t("inspector")}</span>
              <h2>
                {selected ? localizeValue(locale, selected.kind) : t("evidence")}
              </h2>
            </div>
            <Fingerprint size={17} aria-hidden="true" />
          </div>

          {selected ? (
            <div className="inspector-body">
              <div className="inspector-title">
                <StatusChip status={selected.status} />
                <h3>{selected.label}</h3>
                <p>
                  {selected.detail ??
                    t("retainedEvidenceDescription")}
                </p>
              </div>

              <dl className="fact-list">
                <div>
                  <dt>{t("evidenceId")}</dt>
                  <dd><code>{selected.id}</code></dd>
                </div>
                {selected.arm && <div><dt>{t("arm")}</dt><dd>{selected.arm}</dd></div>}
                {selected.repeat && <div><dt>{t("repeat")}</dt><dd>{selected.repeat}</dd></div>}
                {selected.assertion_type && (
                  <div><dt>{t("assertion")}</dt><dd>{selected.assertion_type}</dd></div>
                )}
                {selected.path && (
                  <div className="fact-path"><dt>{t("artifactPath")}</dt><dd>{selected.path}</dd></div>
                )}
                {selected.artifact && (
                  <div className="fact-path"><dt>{t("decisionArtifact")}</dt><dd>{selected.artifact}</dd></div>
                )}
              </dl>

              {selectedCase && (
                <div className="arm-matrix">
                  <div className="section-label">
                    <GitCompareArrows size={13} /> {t("pairedArms")}
                  </div>
                  {selectedCase.missing_objective_metrics.length > 0 && (
                    <p className="arm-warning">
                      {t("missingObjectiveMetrics", {
                        metrics: selectedCase.missing_objective_metrics.join(", "),
                      })}
                    </p>
                  )}
                  {selectedCase.arms.map((arm) => (
                    <article key={arm.id}>
                      <div>
                        <strong>{arm.id}</strong>
                        <StatusChip
                          status={
                            arm.passed
                              ? "passed"
                              : arm.complete
                                ? "failed"
                                : "incomplete"
                          }
                        />
                      </div>
                      <p>
                        {t("assertionsSummary", {
                          passed: arm.assertions.passed,
                          total: arm.assertions.total,
                          rate: percent(arm.required_pass_rate),
                        })}
                      </p>
                      {((arm.forbidden_actions?.length ?? 0) > 0 ||
                        (arm.side_effects?.length ?? 0) > 0 ||
                        (arm.binding_errors?.length ?? 0) > 0) && (
                        <p className="arm-warning">
                          {t("bindingSummary", {
                            binding: arm.binding_errors?.length ?? 0,
                            forbidden: arm.forbidden_actions?.length ?? 0,
                            effects: arm.side_effects?.length ?? 0,
                          })}
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              )}

              {selectedCase && selectedCase.semantic_assertions.length > 0 && (
                <div className="arm-matrix semantic-matrix">
                  <div className="section-label">
                    <Beaker size={13} /> {t("semanticEvidence")}
                  </div>
                  {selectedCase.semantic_assertions.map((assertion) => (
                    <article key={assertion.id}>
                      <div>
                        <strong>{assertion.id}</strong>
                        <StatusChip
                          status={assertion.passed ? "passed" : assertion.status}
                        />
                      </div>
                      <p>
                        {t("preference", {
                          value: assertion.preference ?? t("unresolved"),
                        })}
                        {assertion.resolved_winners?.length
                          ? ` · ${assertion.resolved_winners.join(" / ")}`
                          : ""}
                      </p>
                      {assertion.reason && (
                        <p className="arm-warning">{assertion.reason}</p>
                      )}
                      {assertion.artifact && <p>{assertion.artifact}</p>}
                    </article>
                  ))}
                </div>
              )}

              <div className="provenance-card">
                <div className="section-label">
                  <Fingerprint size={13} /> {t("provenance")}
                </div>
                <dl>
                  <div><dt>{t("subject")}</dt><dd>{shortDigest(data.run.subject?.digest, t("notRecorded"))}</dd></div>
                  <div><dt>{t("baseline")}</dt><dd>{data.run.baseline?.kind ? localizeValue(locale, data.run.baseline.kind) : t("none")}</dd></div>
                  <div><dt>{t("plan")}</dt><dd>{shortDigest(data.run.integrity?.plan_digest, t("notRecorded"))}</dd></div>
                  <div><dt>{t("profile")}</dt><dd>{shortDigest(data.run.execution_profile?.digest, t("notRecorded"))}</dd></div>
                  <div><dt>{t("target")}</dt><dd>{data.run.execution_profile?.target ?? t("unknown")}</dd></div>
                  <div><dt>{t("harness")}</dt><dd>{data.run.execution_profile?.harness ?? t("unknown")}</dd></div>
                  <div><dt>{t("holdout")}</dt><dd>{localizeValue(locale, data.run.holdout?.visibility ?? "public")}</dd></div>
                  <div><dt>{t("evidence")}</dt><dd>{localizeValue(locale, data.run.evidence_scope)}</dd></div>
                  <div><dt>{t("controlAnchor")}</dt><dd>{data.run.control_anchor ?? t("notUsed")}</dd></div>
                </dl>
              </div>
            </div>
          ) : (
            <p className="empty-note">{t("selectEvidence")}</p>
          )}

          <div className="limitations-card">
            <div className="section-label">
              <CircleAlert size={13} /> {t("limitations")}
            </div>
            {data.limitations.length ? (
              <ul>
                {data.limitations.map((item) => <li key={item}>{item}</li>)}
              </ul>
            ) : (
              <p>{t("noLimitations")}</p>
            )}
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <span><Clock3 size={12} /> {t("refreshEvery", { seconds: Math.round(data.refresh_interval_ms / 1000) })}</span>
        <span><RefreshCw size={12} /> {t("retainedJsonArtifacts")}</span>
        <span><FileText size={12} /> {data.contract}</span>
      </footer>
    </main>
  );
}

export default function App() {
  const { data, error, connectionState } = useDashboardData();
  const { t } = useUiPreferences();

  if (!data) {
    return (
      <main className="loading-shell">
        <div className="loading-mark">SR</div>
        <p className="pane-kicker">Skill Reviewer</p>
        <h1>{t("connectingToEvidence")}</h1>
        <p>{error ?? t("waitingForData")}</p>
      </main>
    );
  }

  return <EvidenceDashboard data={data} connectionState={connectionState} />;
}
