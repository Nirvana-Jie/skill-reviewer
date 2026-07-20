// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  FileTypeIcon,
  FolderTypeIcon,
  fileSymbolDescriptor,
  folderSymbolDescriptor,
} from "./file-icons";

describe("file explorer symbols", () => {
  it("distinguishes the Skill package's common artifact types", () => {
    expect(fileSymbolDescriptor("SKILL.md").kind).toBe("markdown");
    expect(
      fileSymbolDescriptor("references/eval-prompts-template.csv").kind,
    ).toBe("csv");
    expect(
      fileSymbolDescriptor("scripts/check.py").kind,
    ).toBe("python");
    expect(fileSymbolDescriptor("evals/evals.json").kind).toBe("json");
    expect(fileSymbolDescriptor("references/schema.yaml").kind).toBe("yaml");
  });

  it("prioritizes named tool files and test variants over raw extensions", () => {
    expect(fileSymbolDescriptor("package.json").kind).toBe("npm");
    expect(fileSymbolDescriptor("pnpm-lock.yaml").kind).toBe("pnpm");
    expect(fileSymbolDescriptor("dashboard/vite.config.ts").kind).toBe("vite");
    expect(fileSymbolDescriptor("dashboard/tsconfig.json").kind).toBe(
      "tsconfig",
    );
    expect(fileSymbolDescriptor("dashboard/src/App.test.tsx").kind).toBe(
      "react-test",
    );
    expect(fileSymbolDescriptor("tests/runtime.test.mjs").kind).toBe(
      "javascript-test",
    );
  });

  it("assigns semantic folder symbols while preserving a generic open state", () => {
    expect(folderSymbolDescriptor("references", true).kind).toBe("documents");
    expect(folderSymbolDescriptor("scripts", true).kind).toBe("scripts");
    expect(folderSymbolDescriptor("dashboard", false).kind).toBe("react");
    expect(folderSymbolDescriptor("tests", true).kind).toBe("tests");
    expect(folderSymbolDescriptor("custom", false).kind).toBe("folder");
    expect(folderSymbolDescriptor("custom", true).kind).toBe("folder");
  });

  it("renders decorative SVGs with stable semantic hooks", () => {
    const { container } = render(
      <>
        <FileTypeIcon path="dashboard/src/App.tsx" />
        <FolderTypeIcon name="references" expanded />
      </>,
    );

    expect(container.querySelector('[data-file-icon="react"]')).toBeTruthy();
    expect(
      container.querySelector('[data-folder-icon="documents"]'),
    ).toBeTruthy();
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
  });
});
