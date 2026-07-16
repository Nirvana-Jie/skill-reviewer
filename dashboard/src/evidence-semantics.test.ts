import { describe, expect, it } from "vitest";

import {
  describeAssertion,
  describeDashboardCase,
  describeEvidenceNode,
  describeLimitation,
  describeReviewStatus,
  localizeLimitation,
  repeatFromEvidenceNode,
} from "./evidence-semantics";
import type { DashboardCase, SpineNode } from "./types";

const selectionCase: DashboardCase = {
  id: "selection-quality",
  purpose: "Measure release quality.",
  split: "selection",
  determinism: "stochastic",
  repeats: 3,
  holdout_visibility: "public",
  status: "passed",
  regressed: false,
  direction_disagreement: false,
  missing_objective_metrics: [],
  arms: [],
  semantic_assertions: [],
};

function node(overrides: Partial<SpineNode>): SpineNode {
  return {
    id: "node:test",
    kind: "artifact",
    parent_id: null,
    label: "response.md",
    status: "retained",
    ...overrides,
  };
}

describe("evidence semantics", () => {
  it("presents localized human meaning while retaining the immutable case ID", () => {
    expect(describeDashboardCase("zh-CN", selectionCase)).toEqual({
      title: "候选质量是否达到发布要求",
      description: "通过候选版与旧版的多轮对照，判断质量提升是否稳定且足以进入发布。",
      technicalLabel: "selection-quality",
    });
  });

  it("explains gate outcomes in terms of their review purpose", () => {
    const gate = node({
      id: "gate:selection-quality:candidate-required-assertions",
      kind: "gate",
      label: "selection-quality:candidate-required-assertions",
      status: "failed",
    });

    expect(
      describeEvidenceNode("zh-CN", gate, [selectionCase]),
    ).toMatchObject({
      title: "候选质量是否达到发布要求｜候选结果检查",
      description: "候选版缺少必需证据，或至少一项检查未通过；本场景不能判定通过。",
    });
  });

  it("gives known assertions a semantic name and keeps unknown IDs traceable", () => {
    expect(describeAssertion("zh-CN", "response-exists", "file_exists")).toMatchObject({
      title: "已生成并保留 Agent 回答",
      technicalLabel: "response-exists",
    });
    expect(describeAssertion("zh-CN", "custom-check", "custom_type")).toEqual({
      title: "自定义检查项",
      description: "按照评测清单中声明的规则检查保留的 Agent 回答。",
      technicalLabel: "custom-check",
    });
  });

  it("explains evidence-insufficiency checks without exposing implementation jargon", () => {
    const missingBaselineCase: DashboardCase = {
      ...selectionCase,
      id: "missing-baseline-is-inconclusive",
      status: "failed",
    };
    expect(describeDashboardCase("zh-CN", missingBaselineCase)).toMatchObject({
      title: "缺少基线时，不判定退化",
    });
    expect(
      describeAssertion("zh-CN", "no-false-regression-claim", "text_not_contains"),
    ).toMatchObject({
      title: "没有在缺少基线时声称退化",
      description: "旧版对照证据缺失或不完整时，不允许把候选版描述为已经退化。",
    });
  });

  it("derives repeat metadata from retained artifact paths", () => {
    expect(
      repeatFromEvidenceNode(
        node({
          path: "cases/selection-quality/with_skill/repeat-3/outputs/response.md",
        }),
      ),
    ).toBe(3);
  });

  it("explains review status in terms of its consequence", () => {
    expect(describeReviewStatus("zh-CN", "failed")).toEqual({
      title: "检查未通过",
      description: "现有证据未满足这项要求；请继续查看失败检查或缺失产物。",
      technicalLabel: "failed",
    });
    expect(describeReviewStatus("zh-CN", "awaiting-audit")).toMatchObject({
      title: "等待安全审计",
    });
  });

  it.each([
    "passed",
    "failed",
    "audit-passed",
    "audit-failed",
    "behavior-verified",
    "regression-verified",
    "regressed",
    "disagreement",
    "pending",
    "incomplete",
    "missing",
    "retained",
    "optimizing",
    "awaiting-audit",
    "inconclusive",
    "agreement",
    "no-change",
    "exhausted",
    "completed",
    "accepted",
    "rejected",
    "invalid",
    "stale",
    "blocked",
  ])("provides reviewer-facing Chinese for the %s state", (status) => {
    expect(describeReviewStatus("zh-CN", status).title).not.toBe(
      "当前状态待进一步解释",
    );
  });

  it("turns recorded limitations into reviewer-facing explanations", () => {
    expect(describeLimitation("zh-CN", "Audit has not passed.")).toEqual({
      title: "安全审计尚未通过",
      description: "发布仍被审计结果阻塞；请先处理审计场景中的失败项。",
      technicalLabel: "Audit has not passed.",
    });
    expect(localizeLimitation("zh-CN", "Audit has not passed.")).toBe(
      "发布仍被审计结果阻塞；请先处理审计场景中的失败项。",
    );
    expect(localizeLimitation("en", "Audit has not passed.")).toBe(
      "Release remains blocked until the failed audit checks are resolved.",
    );
  });
});
