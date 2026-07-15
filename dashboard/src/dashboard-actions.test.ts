// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./dashboard-actions";

const originalExecCommand = document.execCommand;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: originalExecCommand,
    });
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  document.querySelectorAll("textarea").forEach((field) => field.remove());
});

describe("dashboard presentation actions", () => {
  it("uses the async Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyText("run evidence");

    expect(writeText).toHaveBeenCalledWith("run evidence");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to a transient selected field when Clipboard access is denied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await copyText("portable reference");

    expect(writeText).toHaveBeenCalledWith("portable reference");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("preserves the Clipboard failure when both copy paths are blocked", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("clipboard policy blocked")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    await expect(copyText("reference")).rejects.toThrow("clipboard policy blocked");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
