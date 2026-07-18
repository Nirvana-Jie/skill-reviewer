// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DashboardErrorBoundary } from "./DashboardErrorBoundary";
import { UiPreferencesProvider } from "./ui-preferences";

function BrokenProjection(): never {
  throw new Error("nested projection field is unavailable");
}

describe("DashboardErrorBoundary", () => {
  it("turns an unexpected render failure into an actionable recovery page", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <UiPreferencesProvider>
        <DashboardErrorBoundary>
          <BrokenProjection />
        </DashboardErrorBoundary>
      </UiPreferencesProvider>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Dashboard could not render this projection",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Regenerate dashboard-data.json with the current skill-reviewer runtime, then reload this page.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("nested projection field is unavailable"),
    ).toBeInTheDocument();
  });
});
