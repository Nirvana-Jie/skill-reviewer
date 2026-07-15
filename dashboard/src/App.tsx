import {
  Activity,
  Archive,
  Beaker,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileCheck2,
  FileText,
  Fingerprint,
  FlaskConical,
  GitCompareArrows,
  Layers3,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import type { DashboardCase, DashboardData, SpineNode } from "./types";

type SplitFilter = "all" | DashboardCase["split"];
type ConnectionState = "connecting" | "live" | "stale";
type CanvasView = "evidence" | "diff";

const DiffViewer = lazy(() => import("./DiffViewer"));

const splitLabels: Array<{ value: SplitFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "development", label: "Development" },
  { value: "selection", label: "Selection" },
  { value: "audit", label: "Audit" },
];

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
    ["passed", "accepted", "audit-passed", "retained", "regression-verified", "behavior-verified"].some(
      (value) => normalized.includes(value),
    )
  ) {
    return "good";
  }
  if (
    ["failed", "rejected", "regressed", "audit-failed", "invalid", "stale", "disagreement"].some(
      (value) => normalized.includes(value),
    )
  ) {
    return "bad";
  }
  if (
    ["pending", "awaiting", "inconclusive", "incomplete", "missing", "no-change", "exhausted"].some((value) =>
      normalized.includes(value),
    )
  ) {
    return "warn";
  }
  return "neutral";
}

function shortDigest(digest?: string | null): string {
  if (!digest) return "not recorded";
  return `${digest.slice(0, 8)}…${digest.slice(-6)}`;
}

function percent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "—";
}

function StatusChip({ status }: { status: string }) {
  return <span className={`status-chip status-${statusTone(status)}`}>{status}</span>;
}

function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const dataUrl = import.meta.env.VITE_DASHBOARD_DATA_URL ?? "/dashboard-data.json";

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const refresh = async () => {
      try {
        const response = await fetch(dataUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`read model returned ${response.status}`);
        const next = (await response.json()) as DashboardData;
        if (next.contract !== "skill-reviewer.dashboard-data") {
          throw new Error(`unsupported dashboard contract: ${String(next.contract)}`);
        }
        if (!active) return;
        setData(next);
        setError(null);
        setConnectionState("live");
        window.clearTimeout(timer);
        timer = window.setTimeout(refresh, Math.max(next.refresh_interval_ms, 1000));
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "unable to read dashboard data");
        setConnectionState((current) => (current === "live" ? "stale" : "connecting"));
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

export function EvidenceDashboard({
  data,
  connectionState,
}: {
  data: DashboardData;
  connectionState: ConnectionState;
}) {
  const [split, setSplit] = useState<SplitFilter>("all");
  const [selectedId, setSelectedId] = useState(data.spine[0]?.id ?? "");
  const [canvasView, setCanvasView] = useState<CanvasView>("evidence");

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
        if (node.kind === "run" || node.kind === "gate" || node.kind === "iteration") return true;
        if (node.kind === "case") return visibleCaseNodeIds.has(node.id);
        return node.parent_id ? visibleCaseNodeIds.has(node.parent_id) : false;
      }),
    [data.spine, split, visibleCaseNodeIds],
  );

  useEffect(() => {
    if (!visibleNodes.some((node) => node.id === selectedId)) {
      setSelectedId(visibleNodes[0]?.id ?? "");
    }
  }, [selectedId, visibleNodes]);

  const selected = data.spine.find((node) => node.id === selectedId) ?? visibleNodes[0];
  const selectedCase = selected?.kind === "case" ? data.cases.find((item) => `case:${item.id}` === selected.id) : null;
  const runTone = statusTone(data.run.status);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <FlaskConical size={21} strokeWidth={1.8} />
          </div>
          <div>
            <p className="eyebrow">Skill Reviewer</p>
            <h1>Evidence Lab</h1>
          </div>
        </div>
        <div className="run-identity">
          <div className="run-title-row">
            <span className={`live-dot live-${connectionState}`} aria-hidden="true" />
            <span className="connection-label">{connectionState === "live" ? "Live read model" : connectionState}</span>
            <span className="top-divider" />
            <code>{data.run.id}</code>
          </div>
          <div className="run-badges">
            <StatusChip status={data.run.verification_level} />
            <StatusChip status={data.run.status} />
            <span className="readonly-pill"><LockKeyhole size={12} /> read-only</span>
          </div>
        </div>
      </header>

      <section className={`release-strip release-${runTone}`} aria-label="Behavioral gate state">
        <div>
          <span className="release-kicker">Behavioral signal</span>
          <strong>{data.run.status}</strong>
        </div>
        <p>
          {data.summary.hard_gates_passed}/{data.summary.hard_gates_total || 0} hard gates · {data.run.evidence_scope} · round {data.summary.current_round ?? "—"}/{data.summary.max_rounds}
        </p>
        <div className="integrity-mark">
          {data.run.integrity?.verified ? <ShieldCheck size={16} /> : <CircleAlert size={16} />}
          <span>
            {data.run.integrity?.verified ? "Inputs locked" : "Integrity pending"}
            {` · ${data.run.release_eligible ? "behaviorally release-eligible" : "behavioral evidence blocked"}`}
          </span>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="rail panel" aria-label="Run overview">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Run rail</p>
              <h2>Release posture</h2>
            </div>
            <Layers3 size={18} aria-hidden="true" />
          </div>

          <div className="metric-grid">
            <article className="metric-card metric-good">
              <span>Passed cases</span>
              <strong>{data.summary.candidate_passed}</strong>
              <small>of {data.summary.case_count}</small>
            </article>
            <article className="metric-card metric-bad">
              <span>Failed cases</span>
              <strong>{data.summary.candidate_failed}</strong>
              <small>candidate arm</small>
            </article>
            <article className="metric-card metric-wide">
              <span>Current decision</span>
              <strong>{data.summary.decision_status ?? "pending"}</strong>
              <small>hard gate + Pareto</small>
            </article>
          </div>

          <div className="evolution-card">
            <div className="section-label"><GitCompareArrows size={13} /> Evolution control</div>
            <div className="query-row">
              <span>Selection queries</span>
              <strong>{data.summary.selection_queries} / {data.evolution.selection_query_limit}</strong>
            </div>
            <div className="query-row">
              <span>Audit queries</span>
              <strong>{data.summary.audit_queries} / {data.evolution.audit_query_limit}</strong>
            </div>
            <p>
              continuity epoch {data.summary.continuity_epoch ?? "—"} · {data.summary.rejected_candidates} rejected
            </p>
            <div className="lineage-list" aria-label="Candidate lineage">
              {data.evolution.candidate_lineage.slice(-3).map((candidate) => (
                <div key={`${candidate.run_id}-${candidate.round}`}>
                  <span>R{candidate.round ?? "—"}</span>
                  <code>{shortDigest(candidate.candidate_digest)}</code>
                  <em>{candidate.continuity ?? "continue"}</em>
                </div>
              ))}
            </div>
          </div>

          <div className="filter-block">
            <div className="section-label"><SlidersHorizontal size={13} /> Evidence split</div>
            <div className="segmented-control">
              {splitLabels.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  className={split === item.value ? "is-active" : ""}
                  aria-pressed={split === item.value}
                  onClick={() => setSplit(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="case-list" aria-live="polite">
            {visibleCases.map((item) => (
              <button
                type="button"
                className={`case-row ${selectedId === `case:${item.id}` ? "is-selected" : ""}`}
                key={item.id}
                onClick={() => setSelectedId(`case:${item.id}`)}
              >
                <span className={`case-status status-${statusTone(item.status)}`} aria-hidden="true" />
                <span className="case-copy">
                  <strong>{item.id}</strong>
                  <small>{item.split} · {item.holdout_visibility} · {item.determinism === "stochastic" ? `${item.repeats}× paired` : "1× paired"}</small>
                </span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ))}
            {visibleCases.length === 0 && <p className="empty-note">No cases in this split.</p>}
          </div>
        </aside>

        <section className="evidence-canvas panel" aria-label="Evidence spine">
          <div className="panel-heading canvas-heading">
            <div>
              <p className="eyebrow">{canvasView === "evidence" ? "Evidence spine" : "Candidate diff"}</p>
              <h2>{canvasView === "evidence" ? "Run → gate → case → artifact" : `${data.diffs.length} runtime files changed`}</h2>
            </div>
            <div className="canvas-switch" aria-label="Canvas view">
              <button
                type="button"
                className={canvasView === "evidence" ? "is-active" : ""}
                aria-pressed={canvasView === "evidence"}
                onClick={() => setCanvasView("evidence")}
              >
                Evidence
              </button>
              <button
                type="button"
                className={canvasView === "diff" ? "is-active" : ""}
                aria-pressed={canvasView === "diff"}
                onClick={() => setCanvasView("diff")}
              >
                Diff ({data.diffs.length})
              </button>
            </div>
          </div>

          {canvasView === "evidence" ? (
            <div className="spine-stage">
              <div className="spine-line" aria-hidden="true" />
              {visibleNodes.map((node, index) => {
                const Icon = iconByKind[node.kind];
                return (
                  <button
                    type="button"
                    className={`spine-node node-${node.kind} tone-${statusTone(node.status)} ${selectedId === node.id ? "is-selected" : ""}`}
                    key={node.id}
                    aria-label={`Open evidence ${node.label}`}
                    onClick={() => setSelectedId(node.id)}
                    style={{ "--node-index": index } as React.CSSProperties}
                  >
                    <span className="node-icon"><Icon size={15} strokeWidth={1.8} /></span>
                    <span className="node-copy">
                      <small>{node.kind}{node.arm ? ` · ${node.arm}` : ""}</small>
                      <strong>{node.label}</strong>
                      <em>{node.status}</em>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : data.diffs.length ? (
            <Suspense fallback={<div className="diff-empty"><p>Loading diff renderer…</p></div>}>
              <DiffViewer diffs={data.diffs} />
            </Suspense>
          ) : (
            <div className="diff-empty">
              <GitCompareArrows size={28} />
              <p>No runtime-surface changes in this plan.</p>
            </div>
          )}
        </section>

        <aside className="inspector panel" aria-label="Evidence inspector">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Inspector</p>
              <h2>{selected?.kind ?? "Evidence"}</h2>
            </div>
            <Fingerprint size={18} aria-hidden="true" />
          </div>

          {selected ? (
            <div className="inspector-body">
              <div className="inspector-title">
                <StatusChip status={selected.status} />
                <h3>{selected.label}</h3>
                <p>{selected.detail ?? "Retained evidence from the immutable run workspace."}</p>
              </div>

              <dl className="fact-list">
                <div><dt>Evidence ID</dt><dd><code>{selected.id}</code></dd></div>
                {selected.arm && <div><dt>Arm</dt><dd>{selected.arm}</dd></div>}
                {selected.repeat && <div><dt>Repeat</dt><dd>{selected.repeat}</dd></div>}
                {selected.assertion_type && <div><dt>Assertion</dt><dd>{selected.assertion_type}</dd></div>}
                {selected.path && <div className="fact-path"><dt>Artifact path</dt><dd>{selected.path}</dd></div>}
                {selected.artifact && <div className="fact-path"><dt>Decision artifact</dt><dd>{selected.artifact}</dd></div>}
              </dl>

              {selectedCase && (
                <div className="arm-matrix">
                  <div className="section-label"><GitCompareArrows size={13} /> Paired arms</div>
                  {selectedCase.missing_objective_metrics.length > 0 && (
                    <p className="arm-warning">
                      Missing objective metrics: {selectedCase.missing_objective_metrics.join(", ")}
                    </p>
                  )}
                  {selectedCase.arms.map((arm) => (
                    <article key={arm.id}>
                      <div><strong>{arm.id}</strong><StatusChip status={arm.passed ? "passed" : arm.complete ? "failed" : "incomplete"} /></div>
                      <p>{arm.assertions.passed}/{arm.assertions.total} assertions · {percent(arm.required_pass_rate)}</p>
                      {((arm.forbidden_actions?.length ?? 0) > 0 || (arm.side_effects?.length ?? 0) > 0 || (arm.binding_errors?.length ?? 0) > 0) && (
                        <p className="arm-warning">
                          {arm.binding_errors?.length ?? 0} binding · {arm.forbidden_actions?.length ?? 0} forbidden · {arm.side_effects?.length ?? 0} side effects
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              )}

              {selectedCase && selectedCase.semantic_assertions.length > 0 && (
                <div className="arm-matrix semantic-matrix">
                  <div className="section-label"><Beaker size={13} /> Semantic evidence</div>
                  {selectedCase.semantic_assertions.map((assertion) => (
                    <article key={assertion.id}>
                      <div>
                        <strong>{assertion.id}</strong>
                        <StatusChip status={assertion.passed ? "passed" : assertion.status} />
                      </div>
                      <p>
                        preference {assertion.preference ?? "unresolved"}
                        {assertion.resolved_winners?.length
                          ? ` · ${assertion.resolved_winners.join(" / ")}`
                          : ""}
                      </p>
                      {assertion.reason && <p className="arm-warning">{assertion.reason}</p>}
                      {assertion.artifact && <p>{assertion.artifact}</p>}
                    </article>
                  ))}
                </div>
              )}

              <div className="provenance-card">
                <div className="section-label"><Fingerprint size={13} /> Provenance</div>
                <dl>
                  <div><dt>Subject</dt><dd>{shortDigest(data.run.subject?.digest)}</dd></div>
                  <div><dt>Baseline</dt><dd>{data.run.baseline?.kind ?? "none"}</dd></div>
                  <div><dt>Plan</dt><dd>{shortDigest(data.run.integrity?.plan_digest)}</dd></div>
                  <div><dt>Profile</dt><dd>{shortDigest(data.run.execution_profile?.digest)}</dd></div>
                  <div><dt>Target</dt><dd>{data.run.execution_profile?.target ?? "unknown"}</dd></div>
                  <div><dt>Harness</dt><dd>{data.run.execution_profile?.harness ?? "unknown"}</dd></div>
                  <div><dt>Holdout</dt><dd>{data.run.holdout?.visibility ?? "public"}</dd></div>
                  <div><dt>Evidence</dt><dd>{data.run.evidence_scope}</dd></div>
                  <div><dt>Control anchor</dt><dd>{data.run.control_anchor ?? "not used"}</dd></div>
                </dl>
              </div>
            </div>
          ) : (
            <p className="empty-note">Select an evidence node.</p>
          )}

          <div className="limitations-card">
            <div className="section-label"><CircleAlert size={13} /> Limitations</div>
            {data.limitations.length ? (
              <ul>{data.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
            ) : (
              <p>No recorded limitations.</p>
            )}
          </div>
        </aside>
      </div>

      <footer>
        <span><Clock3 size={13} /> refresh {Math.round(data.refresh_interval_ms / 1000)}s</span>
        <span><RefreshCw size={13} /> projected from retained JSON artifacts</span>
        <span><FileText size={13} /> {data.contract}</span>
      </footer>
    </main>
  );
}

export default function App() {
  const { data, error, connectionState } = useDashboardData();

  if (!data) {
    return (
      <main className="loading-shell">
        <div className="loading-mark"><FlaskConical size={28} /></div>
        <p className="eyebrow">Skill Reviewer</p>
        <h1>Connecting to Evidence Lab</h1>
        <p>{error ?? "Waiting for dashboard-data.json…"}</p>
      </main>
    );
  }

  return <EvidenceDashboard data={data} connectionState={connectionState} />;
}
