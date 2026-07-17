// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DashboardEvidenceContent } from "./types";
import {
  EvidenceContentViewer,
  evidenceDocumentFormat,
  parseJsonEvidence,
} from "./EvidenceContentViewer";
import { UiPreferencesProvider } from "./ui-preferences";

function payload(
  overrides: Partial<DashboardEvidenceContent> = {},
): DashboardEvidenceContent {
  const content = overrides.content ?? "plain evidence";
  return {
    contract: "skill-reviewer.dashboard-evidence",
    node_id: "artifact:example",
    path: "outputs/evidence.txt",
    media_type: "text/plain",
    content,
    digest: "a".repeat(64),
    size: new TextEncoder().encode(content).byteLength,
    truncated: false,
    ...overrides,
  };
}

function renderViewer(value: DashboardEvidenceContent) {
  return render(
    <UiPreferencesProvider>
      <EvidenceContentViewer payload={value} />
    </UiPreferencesProvider>,
  );
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  window.localStorage.clear();
});

describe("evidence document parsing", () => {
  it("recognizes JSONL and parses each retained trace event", () => {
    const value = payload({
      path: "cases/example/agent-trace.jsonl",
      media_type: "application/json",
      content: [
        JSON.stringify({ sequence: 1, kind: "execution_started" }),
        JSON.stringify({ sequence: 2, kind: "tool_call", status: "completed" }),
      ].join("\n"),
    });

    expect(evidenceDocumentFormat(value)).toBe("jsonl");
    expect(parseJsonEvidence(value)).toEqual({
      kind: "jsonl",
      value: [
        { sequence: 1, kind: "execution_started" },
        { sequence: 2, kind: "tool_call", status: "completed" },
      ],
    });
  });

  it("falls back to JSONL when a trace is mislabeled as a JSON document", () => {
    const value = payload({
      path: "retained-trace.json",
      media_type: "application/json",
      content: '{"kind":"message"}\n{"kind":"tool_call"}',
    });

    expect(parseJsonEvidence(value)?.kind).toBe("jsonl");
  });
});

describe("EvidenceContentViewer", () => {
  it("renders Markdown as a readable preview and retains an exact source view", async () => {
    const markdown = [
      "# Review result",
      "",
      "- [x] Evidence retained",
      "- [ ] Human decision",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| Safety | Pass |",
      "",
      "![remote image](https://example.com/private.png)",
    ].join("\n");
    renderViewer(payload({ path: "response.md", media_type: "text/markdown", content: markdown }));

    expect(await screen.findByRole("heading", { name: "Review result" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Image not loaded: remote image")).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(document.querySelector(".evidence-source-code code")).toHaveTextContent(markdown, {
      normalizeWhitespace: false,
    });
  });

  it("opens a focused reading dialog and dismisses it from the backdrop", () => {
    renderViewer(payload({
      path: "execution.json",
      media_type: "application/json",
      content: JSON.stringify({ status: "completed", artifacts: ["response.md"] }),
    }));

    fireEvent.click(screen.getByRole("button", { name: "Open full preview" }));
    const dialog = screen.getByRole("dialog", { name: "execution.json" });
    expect(dialog).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(dialog).getByText("JSON document")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("evidence-preview-scrim"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes the reading dialog with Escape", () => {
    renderViewer(payload({ path: "notes.md", media_type: "text/markdown", content: "## Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Open full preview" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
