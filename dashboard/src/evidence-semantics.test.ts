import { describe, expect, it } from "vitest";

import {
  describeAssertion,
  describeDashboardCase,
  describeEvidenceNode,
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
      title: "发布质量选拔",
      description: "验证候选是否达到发布质量要求，并在成对执行中保持稳定。",
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
      title: "发布质量选拔 · 候选必需断言",
      description: "候选证据不完整，或至少一个必须通过的断言失败。",
    });
  });

  it("gives known assertions a semantic name and keeps unknown IDs traceable", () => {
    expect(describeAssertion("zh-CN", "response-exists", "file_exists")).toMatchObject({
      title: "Agent 响应已保留",
      technicalLabel: "response-exists",
    });
    expect(describeAssertion("zh-CN", "custom-check", "custom_type")).toEqual({
      title: "自定义验证断言",
      description: "根据评测清单中声明的规则检查保留的 Agent 输出。",
      technicalLabel: "custom-check",
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

  it("localizes known evidence limitations without mutating source data", () => {
    expect(localizeLimitation("zh-CN", "Audit has not passed.")).toBe(
      "审计尚未通过。",
    );
    expect(localizeLimitation("en", "Audit has not passed.")).toBe(
      "Audit has not passed.",
    );
  });
});
