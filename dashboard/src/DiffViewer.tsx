import {
  MultiFileDiff,
  type WorkerInitializationRenderOptions,
  Virtualizer,
  WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, useState } from "react";

import type { DashboardDiff, DashboardDiffPayload } from "./types";

const workerPoolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: 2,
};

const highlighterOptions = {
  langs: ["markdown", "typescript", "javascript", "python", "json"],
} satisfies WorkerInitializationRenderOptions;

function diffTone(status: DashboardDiff["status"]): "good" | "bad" | "neutral" {
  if (status === "added") return "good";
  if (status === "removed") return "bad";
  return "neutral";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function validatePayload(
  payload: DashboardDiffPayload,
  metadata: DashboardDiff,
): DashboardDiffPayload {
  if (
    !metadata.payload_digest ||
    !/^[a-f0-9]{64}$/.test(metadata.payload_digest) ||
    payload.contract !== "skill-reviewer.dashboard-diff" ||
    payload.id !== metadata.id ||
    payload.path !== metadata.path ||
    payload.old_digest !== metadata.old_digest ||
    payload.new_digest !== metadata.new_digest
  ) {
    throw new Error("diff payload is not bound to its read-model metadata");
  }
  return payload;
}

function DiffBrowser({
  diffs,
  enableWorkerPool,
}: {
  diffs: DashboardDiff[];
  enableWorkerPool: boolean;
}) {
  const [selectedId, setSelectedId] = useState(diffs[0]?.id ?? "");
  const [payloads, setPayloads] = useState<Record<string, DashboardDiffPayload>>(
    {},
  );
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => diffs.find((diff) => diff.id === selectedId) ?? diffs[0],
    [diffs, selectedId],
  );

  useEffect(() => {
    if (!diffs.some((diff) => diff.id === selectedId)) {
      setSelectedId(diffs[0]?.id ?? "");
    }
  }, [diffs, selectedId]);

  useEffect(() => {
    if (
      !selected ||
      selected.render_mode !== "lazy" ||
      !selected.content_url ||
      payloads[selected.id]
    ) {
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoadingId(selected.id);
    setError(null);
    void fetch(selected.content_url, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`diff payload returned ${response.status}`);
        return validatePayload(
          (await response.json()) as DashboardDiffPayload,
          selected,
        );
      })
      .then((payload) => {
        setPayloads((current) => ({ ...current, [selected.id]: payload }));
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "unable to load diff");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingId(null);
      });
    return () => controller.abort();
  }, [payloads, selected]);

  if (!selected) return null;
  const payload = payloads[selected.id];
  const note =
    selected.summary ??
    `Old ${formatBytes(selected.old_size)} · new ${formatBytes(selected.new_size)}`;
  const browser = (
    <div className="diff-browser">
      <nav className="diff-file-list" aria-label="Changed runtime files">
        {diffs.map((diff) => (
          <button
            type="button"
            key={diff.id}
            className={diff.id === selected.id ? "is-selected" : ""}
            aria-pressed={diff.id === selected.id}
            onClick={() => setSelectedId(diff.id)}
          >
            <span className={`status-chip status-${diffTone(diff.status)}`}>
              {diff.status}
            </span>
            <code>{diff.path}</code>
            <small>
              {formatBytes(diff.old_size)} → {formatBytes(diff.new_size)}
            </small>
          </button>
        ))}
      </nav>
      <article className="diff-card" key={selected.id}>
        <div className="diff-card-heading">
          <span className={`status-chip status-${diffTone(selected.status)}`}>
            {selected.status}
          </span>
          <code>{selected.path}</code>
        </div>
        {selected.render_mode !== "lazy" ? (
          <p className="binary-diff-note">{note}</p>
        ) : loadingId === selected.id ? (
          <p className="binary-diff-note">Loading bounded diff payload…</p>
        ) : error ? (
          <p className="binary-diff-note">Unable to render diff: {error}</p>
        ) : payload ? (
          <Virtualizer className="diff-virtualizer" contentClassName="diff-stack">
            <MultiFileDiff
              oldFile={{
                name: selected.path,
                contents: payload.old_content,
                cacheKey: selected.old_digest ?? `absent:${selected.path}`,
              }}
              newFile={{
                name: selected.path,
                contents: payload.new_content,
                cacheKey: selected.new_digest ?? `absent:${selected.path}`,
              }}
              options={{ diffStyle: "split", overflow: "scroll" }}
              disableWorkerPool={!enableWorkerPool}
            />
          </Virtualizer>
        ) : null}
      </article>
    </div>
  );
  return enableWorkerPool ? (
    <WorkerPoolContextProvider
      poolOptions={workerPoolOptions}
      highlighterOptions={highlighterOptions}
    >
      {browser}
    </WorkerPoolContextProvider>
  ) : (
    browser
  );
}

export default function DiffViewer({
  diffs,
  enableWorkerPool = import.meta.env.MODE !== "test",
}: {
  diffs: DashboardDiff[];
  enableWorkerPool?: boolean;
}) {
  return <DiffBrowser diffs={diffs} enableWorkerPool={enableWorkerPool} />;
}
