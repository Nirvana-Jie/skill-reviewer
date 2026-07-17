// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspacePaneResizeHandle } from "./WorkspacePaneResizeHandle";

afterEach(() => {
  cleanup();
  document.body.classList.remove("is-resizing-pane");
});

describe("WorkspacePaneResizeHandle", () => {
  it("exposes separator semantics and keyboard controls", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <WorkspacePaneResizeHandle
        pane="rail"
        value={270}
        range={{ min: 220, max: 480 }}
        label="Resize evaluation scenarios"
        hint="Drag or use arrow keys"
        controls="case-rail evidence-workspace"
        onChange={onChange}
        onReset={onReset}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize evaluation scenarios",
    });
    expect(separator).toHaveAttribute("aria-valuemin", "220");
    expect(separator).toHaveAttribute("aria-valuemax", "480");
    expect(separator).toHaveAttribute("aria-valuenow", "270");
    expect(separator).toHaveAttribute(
      "aria-controls",
      "case-rail evidence-workspace",
    );

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(286);
    fireEvent.keyDown(separator, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(480);
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onReset).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(separator);
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("clamps pointer movement and reverses the right divider direction", () => {
    const onChange = vi.fn();
    render(
      <WorkspacePaneResizeHandle
        pane="inspector"
        value={390}
        range={{ min: 280, max: 560 }}
        label="Resize evidence inspector"
        hint="Drag or use arrow keys"
        controls="evidence-workspace evidence-inspector"
        onChange={onChange}
        onReset={() => undefined}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize evidence inspector",
    });
    fireEvent.pointerDown(separator, {
      button: 0,
      pointerId: 7,
      isPrimary: true,
      clientX: 500,
    });
    expect(document.body).toHaveClass("is-resizing-pane");
    fireEvent.pointerMove(window, {
      pointerId: 7,
      isPrimary: true,
      clientX: 300,
    });
    expect(onChange).toHaveBeenLastCalledWith(560);
    fireEvent.pointerMove(window, {
      pointerId: 7,
      isPrimary: true,
      clientX: 900,
    });
    expect(onChange).toHaveBeenLastCalledWith(280);
    fireEvent.pointerUp(window, {
      pointerId: 7,
      isPrimary: true,
      clientX: 900,
    });
    expect(document.body).not.toHaveClass("is-resizing-pane");
  });

  it("does not lose a fast pointer move before React renders drag styling", () => {
    const onChange = vi.fn();
    render(
      <WorkspacePaneResizeHandle
        pane="rail"
        value={270}
        range={{ min: 220, max: 480 }}
        label="Resize evaluation scenarios"
        hint="Drag or use arrow keys"
        controls="case-rail evidence-workspace"
        onChange={onChange}
        onReset={() => undefined}
      />,
    );
    const separator = screen.getByRole("separator", {
      name: "Resize evaluation scenarios",
    });

    act(() => {
      fireEvent.pointerDown(separator, {
        button: 0,
        pointerId: 9,
        isPrimary: true,
        clientX: 270,
      });
      fireEvent.pointerMove(separator, {
        pointerId: 9,
        isPrimary: true,
        clientX: 420,
      });
      fireEvent.pointerUp(separator, {
        pointerId: 9,
        isPrimary: true,
        clientX: 420,
      });
    });

    expect(onChange).toHaveBeenLastCalledWith(420);
    expect(document.body).not.toHaveClass("is-resizing-pane");
  });

  it("cleans up a drag when the browser window loses focus", () => {
    const onChange = vi.fn();
    render(
      <WorkspacePaneResizeHandle
        pane="rail"
        value={270}
        range={{ min: 220, max: 480 }}
        label="Resize evaluation scenarios"
        hint="Drag or use arrow keys"
        controls="case-rail evidence-workspace"
        onChange={onChange}
        onReset={() => undefined}
      />,
    );
    const separator = screen.getByRole("separator", {
      name: "Resize evaluation scenarios",
    });

    fireEvent.pointerDown(separator, {
      button: 0,
      pointerId: 12,
      isPrimary: true,
      clientX: 270,
    });
    expect(document.body).toHaveClass("is-resizing-pane");
    fireEvent.blur(window);
    expect(document.body).not.toHaveClass("is-resizing-pane");
    fireEvent.pointerMove(window, {
      pointerId: 12,
      isPrimary: true,
      clientX: 420,
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
