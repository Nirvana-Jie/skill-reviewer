import { ChevronDown, CircleAlert, FileText, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DashboardEvidenceContent, SpineNode } from "./types";
import { useUiPreferences } from "./ui-preferences";

function formattedContent(payload: DashboardEvidenceContent): string {
  if (payload.media_type !== "application/json") return payload.content;
  try {
    return JSON.stringify(JSON.parse(payload.content), null, 2);
  } catch {
    return payload.content;
  }
}

function unavailableReason(
  node: SpineNode,
  t: ReturnType<typeof useUiPreferences>["t"],
): string {
  if (node.content_unavailable_reason === "opaque") return t("opaqueEvidence");
  if (node.content_unavailable_reason === "binary") return t("binaryEvidence");
  if (node.content_unavailable_reason === "too_large") return t("oversizedEvidence");
  return t("sourceEvidenceUnavailable");
}

export function EvidenceReader({ node }: { node: SpineNode }) {
  const { locale, t } = useUiPreferences();
  const [payload, setPayload] = useState<DashboardEvidenceContent | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setPayload(null);
    setError(false);
    setExpanded(false);
    if (!node.content_url) return;
    const controller = new AbortController();
    void fetch(node.content_url, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`evidence request failed: ${response.status}`);
        const next = (await response.json()) as DashboardEvidenceContent;
        if (
          next.contract !== "skill-reviewer.dashboard-evidence" ||
          next.node_id !== node.id ||
          next.digest !== node.content_digest
        ) {
          throw new Error("evidence payload is not bound to the selected node");
        }
        setPayload(next);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(true);
      });
    return () => controller.abort();
  }, [node.content_digest, node.content_url, node.id]);

  const content = useMemo(() => (payload ? formattedContent(payload) : ""), [payload]);
  const canExpand = content.length > 900;
  const shouldRender =
    Boolean(node.content_url) ||
    Boolean(node.content_unavailable_reason) ||
    ((node.kind === "artifact" || node.kind === "assertion" || node.kind === "iteration") &&
      Boolean(node.path));
  if (!shouldRender) return null;

  return (
    <section className="source-evidence-card" aria-label={t("sourceEvidence")}>
      <div className="section-label source-evidence-heading">
        <span>
          <FileText size={13} /> {t("sourceEvidence")}
        </span>
        {payload && <span>{t("evidenceSize", { size: payload.size.toLocaleString(locale) })}</span>}
      </div>
      <p className="source-evidence-description">{t("sourceEvidenceDescription")}</p>

      {!node.content_url ? (
        <div className="source-evidence-empty">
          <CircleAlert size={14} />
          <p>{unavailableReason(node, t)}</p>
        </div>
      ) : error ? (
        <div className="source-evidence-empty tone-bad">
          <CircleAlert size={14} />
          <p>{t("sourceEvidenceLoadFailed")}</p>
        </div>
      ) : !payload ? (
        <div className="source-evidence-loading" role="status">
          <LoaderCircle size={14} /> {t("loadingSourceEvidence")}
        </div>
      ) : (
        <>
          <div className={`source-evidence-content ${expanded ? "is-expanded" : ""}`}>
            <pre>{content}</pre>
          </div>
          {(canExpand || payload.truncated) && (
            <div className="source-evidence-footer">
              {payload.truncated && <span>{t("contentTruncated")}</span>}
              {canExpand && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((current) => !current)}
                >
                  {t(expanded ? "collapseSourceContent" : "expandSourceContent")}
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
