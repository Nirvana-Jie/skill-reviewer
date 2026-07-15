// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EvidenceDashboard } from "./App";
import type { DashboardData } from "./types";

const data: DashboardData = {
  schema_version: "skill-reviewer.dashboard-data.v1",
  generated_at: null,
  refresh_interval_ms: 3000,
  run: {
    id: "run-product-test",
    status: "awaiting-audit",
    verification_level: "regression-verified",
    subject: { path: "/skills/candidate", digest: "a".repeat(64) },
    baseline: { kind: "old_skill", path: "/skills/accepted", digest: "b".repeat(64) },
    splits: ["selection", "audit"],
    integrity: { locked: true, verified: true, plan_digest: "c".repeat(64) },
  },
  summary: {
    case_count: 2,
    candidate_passed: 1,
    candidate_failed: 1,
    hard_gates_passed: 3,
    hard_gates_total: 4,
    decision_status: "accepted",
    current_round: 2,
    max_rounds: 3,
  },
  cases: [
    {
      id: "selection-quality",
      purpose: "Measure release quality.",
      split: "selection",
      determinism: "stochastic",
      repeats: 3,
      status: "passed",
      regressed: false,
      direction_disagreement: false,
      arms: [
        {
          id: "with_skill",
          complete: true,
          passed: true,
          required_pass_rate: 1,
          forbidden_actions: [],
          metrics: {},
          assertions: { passed: 3, total: 3 },
          artifact_count: 2,
        },
      ],
      semantic_assertions: [],
    },
    {
      id: "hidden-safety-audit",
      purpose: "Protect the hidden release line.",
      split: "audit",
      determinism: "deterministic",
      repeats: 1,
      status: "failed",
      regressed: true,
      direction_disagreement: false,
      arms: [],
      semantic_assertions: [],
    },
  ],
  iterations: [
    {
      iteration: 2,
      phase: "selection",
      status: "accepted",
      accepted: true,
      artifact: "iteration-2/acceptance-decision.json",
    },
  ],
  spine: [
    {
      id: "run:product-test",
      kind: "run",
      parent_id: null,
      label: "run-product-test",
      status: "awaiting-audit",
    },
    {
      id: "gate:safety",
      kind: "gate",
      parent_id: "run:product-test",
      label: "Safety hard gate",
      status: "passed",
      detail: "No forbidden action observed.",
    },
    {
      id: "case:selection-quality",
      kind: "case",
      parent_id: "run:product-test",
      label: "selection-quality",
      status: "passed",
      split: "selection",
    },
    {
      id: "artifact:review",
      kind: "artifact",
      parent_id: "case:selection-quality",
      label: "response.md",
      status: "retained",
      arm: "with_skill",
      path: "cases/selection-quality/with_skill/repeat-1/outputs/response.md",
    },
    {
      id: "case:hidden-safety-audit",
      kind: "case",
      parent_id: "run:product-test",
      label: "hidden-safety-audit",
      status: "failed",
      split: "audit",
    },
  ],
  limitations: ["Audit has not passed."],
};

describe("EvidenceDashboard", () => {
  it("exposes live release evidence without execution controls", () => {
    render(<EvidenceDashboard data={data} connectionState="live" />);

    expect(screen.getAllByText("run-product-test").length).toBeGreaterThan(0);
    expect(screen.getByText("regression-verified")).toBeInTheDocument();
    expect(screen.getAllByText("selection-quality").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /execute|approve|run eval/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(screen.getAllByText("hidden-safety-audit").length).toBeGreaterThan(0);
    expect(screen.queryByText("selection-quality")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: /Open evidence response.md/i }));
    expect(
      screen.getByText("cases/selection-quality/with_skill/repeat-1/outputs/response.md"),
    ).toBeInTheDocument();
  });
});
