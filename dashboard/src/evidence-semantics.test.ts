import { describe, expect, it } from "vitest";

import {
  describeAssertion,
  describeAssertionDecision,
  describeDashboardCase,
  describeDecisionBasis,
  describeEvidenceNode,
  describeEvidenceReviewGuide,
  describeLimitation,
  describeReviewStatus,
  localizeLimitation,
  repeatFromEvidenceNode,
} from "./evidence-semantics";
import type { DashboardCase, SpineNode } from "./types";

const selectionCase: DashboardCase = {
  id: "selection-quality",
  purpose: "Measure release quality.",
  prompt: "Review this Skill and decide whether it is ready.",
  input_files: ["fixtures/SKILL.md"],
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

  it("explains what a check reads, why it exists, and what its actual failure means", () => {
    const assertion = node({
      id: "assertion:selection-quality:with_skill:1:no-false-regression-claim",
      kind: "assertion",
      parent_id: "case:selection-quality",
      label: "no-false-regression-claim",
      status: "failed",
      arm: "with_skill",
      repeat: 1,
      assertion_type: "text_not_contains",
      assertion_rule: {
        severity: "must_pass",
        artifact: "outputs/response.md",
        expected: "regression-verified",
      },
      assertion_evidence: {
        artifact: "outputs/response.md",
        unexpected: ["regression-verified"],
      },
      path: "cases/selection-quality/with_skill/repeat-1/outputs/response.md",
    });

    expect(
      describeEvidenceReviewGuide("zh-CN", assertion, selectionCase),
    ).toMatchObject({
      purpose: expect.stringContaining("自动检查会读取指定证据"),
      inputs: expect.arrayContaining([
        { label: "评测问题", value: selectionCase.prompt },
        { label: "被测版本", value: "候选版 Skill" },
        { label: "读取的证据", value: "outputs/response.md" },
      ]),
      reviewerChecks: expect.arrayContaining([
        expect.stringContaining("断言本身过窄、过宽"),
      ]),
    });
    expect(describeAssertionDecision("zh-CN", assertion)).toEqual({
      rule: "回答不得出现 “regression-verified”，因为现有证据不足以支持该结论。",
      observed: "实际回答中发现了禁止内容：“regression-verified”。",
      importance: "发布级必检项：失败会阻塞该场景通过。",
    });
  });

  it("explains a failed candidate gate with counts and a direct link to the failed check", () => {
    const caseWithFailure: DashboardCase = {
      ...selectionCase,
      id: "missing-baseline-is-inconclusive",
      status: "failed",
      arms: [
        {
          id: "with_skill",
          complete: true,
          passed: false,
          required_pass_rate: 0.75,
          forbidden_actions: [],
          side_effects: [],
          binding_errors: [],
          metrics: {},
          assertions: { passed: 3, total: 4 },
          artifact_count: 2,
        },
      ],
    };
    const gate = node({
      id: "gate:missing-baseline-is-inconclusive:candidate-required-assertions",
      kind: "gate",
      label: "missing-baseline-is-inconclusive:candidate-required-assertions",
      status: "failed",
    });
    const assertions = [
      node({
        id: "assertion:missing-baseline-is-inconclusive:with_skill:1:response-exists",
        kind: "assertion",
        parent_id: "case:missing-baseline-is-inconclusive",
        label: "response-exists",
        status: "passed",
        arm: "with_skill",
        repeat: 1,
        assertion_type: "file_exists",
        assertion_rule: { severity: "must_pass", artifact: "outputs/response.md" },
        assertion_evidence: { exists: true },
      }),
      node({
        id: "assertion:missing-baseline-is-inconclusive:with_skill:1:no-false-regression-claim",
        kind: "assertion",
        parent_id: "case:missing-baseline-is-inconclusive",
        label: "no-false-regression-claim",
        status: "failed",
        arm: "with_skill",
        repeat: 1,
        assertion_type: "text_not_contains",
        assertion_rule: {
          severity: "must_pass",
          artifact: "outputs/response.md",
          expected: "regression-verified",
        },
        assertion_evidence: {
          artifact: "outputs/response.md",
          unexpected: ["regression-verified"],
        },
      }),
      ...[2, 3].map((repeat) =>
        node({
          id: `assertion:missing-baseline-is-inconclusive:with_skill:${repeat}:response-exists`,
          kind: "assertion",
          parent_id: "case:missing-baseline-is-inconclusive",
          label: "response-exists",
          status: "passed",
          arm: "with_skill",
          repeat,
          assertion_type: "file_exists",
          assertion_rule: { severity: "must_pass", artifact: "outputs/response.md" },
          assertion_evidence: { exists: true },
        }),
      ),
    ];

    const basis = describeDecisionBasis(
      "zh-CN",
      gate,
      caseWithFailure,
      [gate, ...assertions],
      [caseWithFailure],
    );

    expect(basis?.summary).toBe(
      "候选版执行与产物完整，但 4 项发布级检查中有 1 项未通过，因此门禁未通过。",
    );
    expect(basis?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "发布级检查",
          verdict: "未满足",
          detail: "通过 3/4 项；1 项未通过。",
        }),
        expect.objectContaining({
          title: "第 1 次执行｜没有在缺少基线时声称退化",
          detail: "实际回答中发现了禁止内容：“regression-verified”。",
          evidenceNodeId:
            "assertion:missing-baseline-is-inconclusive:with_skill:1:no-false-regression-claim",
        }),
      ]),
    );
  });

  it("makes clear that a passing baseline gate only validates comparison evidence", () => {
    const pairedCase: DashboardCase = {
      ...selectionCase,
      arms: [
        {
          id: "old_skill",
          complete: true,
          passed: false,
          required_pass_rate: 0.75,
          forbidden_actions: [],
          side_effects: [],
          binding_errors: [],
          metrics: {},
          assertions: { passed: 3, total: 4 },
          artifact_count: 2,
        },
      ],
    };
    const gate = node({
      id: "gate:selection-quality:paired-baseline-complete",
      kind: "gate",
      label: "selection-quality:paired-baseline-complete",
      status: "passed",
    });

    const basis = describeDecisionBasis(
      "zh-CN",
      gate,
      pairedCase,
      [gate],
      [pairedCase],
    );

    expect(basis?.summary).toContain("因此可作为公平对照");
    expect(basis?.nextStep).toBe(
      "该门禁只确认对照证据可用，不代表候选版本身已经通过。",
    );
  });

  it("does not disclose opaque holdout prompts in reviewer guidance", () => {
    const opaqueCase = {
      ...selectionCase,
      prompt: null,
      input_files: [],
      holdout_visibility: "opaque" as const,
    };
    expect(
      describeEvidenceReviewGuide(
        "zh-CN",
        node({ kind: "case", id: "case:selection-quality" }),
        opaqueCase,
      ).inputs,
    ).toContainEqual({
      label: "评测问题",
      value: "隐藏审计输入（为避免演进过程针对测试集调参，不在此处公开）",
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
      title: "等待发布审计",
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
      title: "发布审计尚未通过",
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
