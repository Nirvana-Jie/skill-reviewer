import {
  Braces,
  Code2,
  Eye,
  FileText,
  Maximize2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { DashboardEvidenceContent } from "./types";
import { useUiPreferences } from "./ui-preferences";

const MarkdownEvidence = lazy(() => import("./MarkdownEvidence"));

export type EvidenceDocumentFormat = "json" | "jsonl" | "markdown" | "text";
type EvidenceViewMode = "preview" | "source";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ParsedJsonEvidence {
  kind: "json" | "jsonl";
  value: JsonValue;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}

export function evidenceDocumentFormat(
  payload: Pick<DashboardEvidenceContent, "media_type" | "path">,
): EvidenceDocumentFormat {
  const path = payload.path.toLocaleLowerCase();
  if (path.endsWith(".jsonl")) return "jsonl";
  if (payload.media_type === "application/json" || path.endsWith(".json")) {
    return "json";
  }
  if (payload.media_type === "text/markdown" || /\.md(?:own)?$/.test(path)) {
    return "markdown";
  }
  return "text";
}

export function parseJsonEvidence(
  payload: Pick<DashboardEvidenceContent, "content" | "media_type" | "path">,
): ParsedJsonEvidence | null {
  const format = evidenceDocumentFormat(payload);
  if (format !== "json" && format !== "jsonl") return null;

  if (format === "json") {
    try {
      const value: unknown = JSON.parse(payload.content);
      return isJsonValue(value) ? { kind: "json", value } : null;
    } catch {
      // Some emitters label JSONL as application/json. Fall through to the
      // line-oriented parser so retained traces remain readable.
    }
  }

  const lines = payload.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  try {
    const values = lines.map((line) => JSON.parse(line) as unknown);
    return values.every(isJsonValue)
      ? { kind: "jsonl", value: values as JsonValue[] }
      : null;
  } catch {
    return null;
  }
}

function primitiveLabel(value: JsonValue): ReactNode {
  if (value === null) return <span className="json-value is-null">null</span>;
  if (typeof value === "string") {
    return <span className="json-value is-string">&quot;{value}&quot;</span>;
  }
  if (typeof value === "number") {
    return <span className="json-value is-number">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-value is-boolean">{String(value)}</span>;
  }
  return null;
}

function objectHint(value: JsonValue): string | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, JsonValue>;
  const kind = typeof record.kind === "string" ? record.kind : null;
  const status = typeof record.status === "string" ? record.status : null;
  const summary = typeof record.summary === "string" ? record.summary : null;
  return [kind, status, summary].filter(Boolean).join(" · ") || null;
}

function JsonNode({
  name,
  value,
  depth,
  defaultOpen = false,
}: {
  name: string;
  value: JsonValue;
  depth: number;
  defaultOpen?: boolean;
}) {
  if (value === null || typeof value !== "object") {
    return (
      <div className="json-leaf" data-depth={depth}>
        <span className="json-key">{name}</span>
        <span className="json-separator">:</span>
        {primitiveLabel(value)}
      </div>
    );
  }

  const entries: Array<[string, JsonValue]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const marker = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  const hint = objectHint(value);

  return (
    <details className="json-branch" open={defaultOpen}>
      <summary>
        <span className="json-key">{name}</span>
        <span className="json-marker">{marker}</span>
        {hint && <span className="json-hint">{hint}</span>}
      </summary>
      <div className="json-children">
        {entries.map(([key, item], index) => (
          <JsonNode
            key={`${key}-${index}`}
            name={Array.isArray(value) ? `#${Number(key) + 1}` : key}
            value={item}
            depth={depth + 1}
            defaultOpen={depth === 0 && index < 2}
          />
        ))}
      </div>
    </details>
  );
}

function JsonDocument({ document }: { document: ParsedJsonEvidence }) {
  const { t } = useUiPreferences();
  const rootName = document.kind === "jsonl" ? t("jsonLineRecords") : t("jsonRoot");
  return (
    <div className="evidence-json-tree" data-json-kind={document.kind}>
      <JsonNode name={rootName} value={document.value} depth={0} defaultOpen />
    </div>
  );
}

function EvidenceDocument({
  payload,
  mode,
}: {
  payload: DashboardEvidenceContent;
  mode: EvidenceViewMode;
}) {
  const format = evidenceDocumentFormat(payload);
  const parsedJson = useMemo(() => parseJsonEvidence(payload), [payload]);

  if (mode === "preview" && format === "markdown") {
    return (
      <Suspense fallback={<div className="source-evidence-loading" role="status" />}>
        <MarkdownEvidence content={payload.content} />
      </Suspense>
    );
  }
  if (mode === "preview" && parsedJson) {
    return <JsonDocument document={parsedJson} />;
  }
  return (
    <pre className="evidence-source-code">
      <code>{payload.content}</code>
    </pre>
  );
}

function formatLabel(format: EvidenceDocumentFormat, t: ReturnType<typeof useUiPreferences>["t"]) {
  if (format === "jsonl") return t("jsonLinesFormat");
  if (format === "json") return "JSON";
  if (format === "markdown") return "Markdown";
  return t("plainTextFormat");
}

function ViewSwitch({
  mode,
  format,
  onChange,
}: {
  mode: EvidenceViewMode;
  format: EvidenceDocumentFormat;
  onChange: (mode: EvidenceViewMode) => void;
}) {
  const { t } = useUiPreferences();
  if (format === "text") return null;
  return (
    <div className="evidence-view-switch" role="group" aria-label={t("evidenceViewMode")}>
      <button
        type="button"
        className={mode === "preview" ? "is-active" : ""}
        aria-pressed={mode === "preview"}
        onClick={() => onChange("preview")}
      >
        <Eye size={12} aria-hidden="true" />
        {format === "markdown" ? t("renderedPreview") : t("structuredPreview")}
      </button>
      <button
        type="button"
        className={mode === "source" ? "is-active" : ""}
        aria-pressed={mode === "source"}
        onClick={() => onChange("source")}
      >
        <Code2 size={12} aria-hidden="true" />
        {t("sourceView")}
      </button>
    </div>
  );
}

function EvidencePreviewDialog({
  payload,
  format,
  mode,
  onModeChange,
  onClose,
}: {
  payload: DashboardEvidenceContent;
  format: EvidenceDocumentFormat;
  mode: EvidenceViewMode;
  onModeChange: (mode: EvidenceViewMode) => void;
  onClose: () => void;
}) {
  const { locale, t } = useUiPreferences();
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])",
      ) ?? [],
    );
    if (!focusables.length) return;
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex - 1 + focusables.length) % focusables.length
      : (currentIndex + 1) % focusables.length;
    event.preventDefault();
    focusables[nextIndex]?.focus();
  };

  return createPortal(
    <div
      className="evidence-preview-scrim"
      data-testid="evidence-preview-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="evidence-preview-dialog"
        data-format={format}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <header className="evidence-preview-heading">
          <div className="evidence-preview-identity">
            <span className="evidence-format-icon" aria-hidden="true">
              {format === "json" || format === "jsonl" ? (
                <Braces size={17} />
              ) : (
                <FileText size={17} />
              )}
            </span>
            <div>
              <span>{t("evidencePreview")}</span>
              <h2 id={titleId}>{payload.path}</h2>
              <p>
                {formatLabel(format, t)} · {t("evidenceSize", { size: payload.size.toLocaleString(locale) })}
              </p>
            </div>
          </div>
          <div className="evidence-preview-actions">
            <ViewSwitch mode={mode} format={format} onChange={onModeChange} />
            <button
              ref={closeRef}
              type="button"
              className="evidence-preview-close"
              aria-label={t("closeEvidencePreview")}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="evidence-preview-body">
          <EvidenceDocument payload={payload} mode={mode} />
        </div>
        <footer className="evidence-preview-footer">
          <span>{payload.truncated ? t("contentTruncated") : t("evidenceDigestBound")}</span>
          <span><kbd>Esc</kbd> {t("close")}</span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function EvidenceContentViewer({ payload }: { payload: DashboardEvidenceContent }) {
  const { t } = useUiPreferences();
  const format = evidenceDocumentFormat(payload);
  const [mode, setMode] = useState<EvidenceViewMode>(format === "text" ? "source" : "preview");
  const [dialogOpen, setDialogOpen] = useState(false);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  useEffect(() => {
    setMode(format === "text" ? "source" : "preview");
    setDialogOpen(false);
  }, [format, payload.digest]);

  return (
    <>
      <div className="source-evidence-toolbar">
        <span className="evidence-format-badge" data-format={format}>
          {format === "json" || format === "jsonl" ? <Braces size={12} /> : <FileText size={12} />}
          {formatLabel(format, t)}
        </span>
        <ViewSwitch mode={mode} format={format} onChange={setMode} />
      </div>
      <div className="source-evidence-content" data-format={format}>
        <EvidenceDocument payload={payload} mode={mode} />
      </div>
      <div className="source-evidence-footer">
        <span>{payload.truncated ? t("contentTruncated") : t("evidencePreviewHint")}</span>
        <button type="button" onClick={() => setDialogOpen(true)}>
          <Maximize2 size={13} aria-hidden="true" />
          {t("openFullPreview")}
        </button>
      </div>
      {dialogOpen && (
        <EvidencePreviewDialog
          payload={payload}
          format={format}
          mode={mode}
          onModeChange={setMode}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
