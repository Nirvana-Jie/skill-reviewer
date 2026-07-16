import type { DashboardCase, SpineNode } from "./types";
import type { Locale } from "./ui-preferences";

export interface SemanticCopy {
  title: string;
  description: string;
  technicalLabel: string;
}

export interface EvidenceGuideInput {
  label: string;
  value: string;
}

export interface EvidenceReviewGuide {
  purpose: string;
  inputs: EvidenceGuideInput[];
  reviewerChecks: string[];
}

export interface AssertionDecisionCopy {
  rule: string;
  observed: string;
  importance: string;
}

export type DecisionBasisTone = "good" | "bad" | "warn" | "neutral";

export interface DecisionBasisItem {
  id: string;
  title: string;
  verdict: string;
  detail: string;
  tone: DecisionBasisTone;
  evidenceNodeId?: string;
}

export interface DecisionBasisCopy {
  summary: string;
  items: DecisionBasisItem[];
  nextStep?: string;
}

interface BilingualCopy {
  en: Omit<SemanticCopy, "technicalLabel">;
  "zh-CN": Omit<SemanticCopy, "technicalLabel">;
}

function localizedCopy(
  locale: Locale,
  technicalLabel: string,
  copy: BilingualCopy,
): SemanticCopy {
  return { ...copy[locale], technicalLabel };
}

function humanizeIdentifier(identifier: string): string {
  const words = identifier.replace(/[_:.-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : identifier;
}

const caseCopies: Record<string, BilingualCopy> = {
  "effect-verification-contract": {
    en: {
      title: "Effect verification contract",
      description:
        "Verifies that candidate and baseline runs produce artifact-backed assertions before a release claim is made.",
    },
    "zh-CN": {
      title: "真实执行并以证据判定效果",
      description:
        "候选版与旧版会真实对照执行，只有产物和检查项都支持时，才允许给出发布结论。",
    },
  },
  "explicit-static-only-boundary": {
    en: {
      title: "Static-only boundary",
      description:
        "Confirms that an explicit static-only request does not execute evals or workers and states its evidence boundary.",
    },
    "zh-CN": {
      title: "仅静态审查时不执行评测",
      description:
        "用户明确要求静态审查时，不启动行为评测，并在结论中清楚说明验证边界。",
    },
  },
  "missing-baseline-is-inconclusive": {
    en: {
      title: "Missing baseline stays inconclusive",
      description:
        "Prevents an isolated candidate output or missing retained artifacts from being misreported as a proven regression.",
    },
    "zh-CN": {
      title: "缺少基线时，不判定退化",
      description:
        "没有旧版对照或保留产物不完整时，只能标记证据不足，不能声称候选版已经退化。",
    },
  },
  "ready-skill-calibration": {
    en: {
      title: "Release-ready Skill calibration",
      description:
        "Calibrates the positive end of the rubric with a deliberately narrow, release-ready Skill without manufacturing blockers.",
    },
    "zh-CN": {
      title: "可发布样例不应被误判",
      description:
        "用已知可发布的精简 Skill 校准审查标准，避免 Reviewer 凭空制造阻塞项。",
    },
  },
  "selection-quality": {
    en: {
      title: "Release quality selection",
      description:
        "Checks whether the candidate reaches release quality and remains stable across paired executions.",
    },
    "zh-CN": {
      title: "候选质量是否达到发布要求",
      description: "通过候选版与旧版的多轮对照，判断质量提升是否稳定且足以进入发布。",
    },
  },
  "public-safety-audit": {
    en: {
      title: "Public safety audit",
      description:
        "Checks destructive behavior, unauthorized operations, and other release-blocking safety evidence.",
    },
    "zh-CN": {
      title: "发布前安全检查",
      description: "检查是否存在破坏性行为、越权操作或其他必须阻塞发布的安全风险。",
    },
  },
  "dangerous-skill-audit": {
    en: {
      title: "Dangerous Skill audit",
      description:
        "Uses a destructive fixture to verify risk detection, containment guidance, and release blocking.",
    },
    "zh-CN": {
      title: "危险 Skill 必须被阻塞",
      description: "用包含破坏性指令的样例确认 Reviewer 能识别风险、给出隔离建议并阻止发布。",
    },
  },
};

export function describeDashboardCase(
  locale: Locale,
  item: DashboardCase,
): SemanticCopy {
  const known = caseCopies[item.id];
  if (known) return localizedCopy(locale, item.id, known);
  if (locale === "en") {
    return {
      title: humanizeIdentifier(item.id),
      description:
        item.purpose ??
        `Checks the expected behavior of this ${item.split} evaluation scenario.`,
      technicalLabel: item.id,
    };
  }
  const split =
    item.split === "development" ? "开发" : item.split === "audit" ? "审计" : "选拔";
  return {
    title: "自定义评测场景",
    description: `验证该场景在${split}阶段是否满足声明的预期行为。`,
    technicalLabel: item.id,
  };
}

const assertionCopies: Record<string, BilingualCopy> = {
  "response-exists": {
    en: {
      title: "Agent response retained",
      description:
        "Checks that the Agent produced a response artifact instead of treating process completion as evidence.",
    },
    "zh-CN": {
      title: "已生成并保留 Agent 回答",
      description: "确认本轮真实产生了可审阅的回答文件，而不是只记录任务已结束。",
    },
  },
  "inconclusive-is-declared": {
    en: {
      title: "Insufficient evidence declared",
      description:
        "Checks that the response explicitly reports an inconclusive result when evidence is incomplete.",
    },
    "zh-CN": {
      title: "证据不足时明确不下结论",
      description: "证据不完整时必须明确标记无法判定，不能强行给出通过或退化结论。",
    },
  },
  "missing-evidence-is-named": {
    en: {
      title: "Missing evidence identified",
      description: "Checks that the response names the exact evidence required to resolve the decision.",
    },
    "zh-CN": {
      title: "明确说明还缺什么证据",
      description: "列出完成判定仍需补充的具体基线、产物或检查结果。",
    },
  },
  "no-false-regression-claim": {
    en: {
      title: "No unsupported regression claim",
      description: "Blocks a regression claim when paired baseline evidence is missing or incomplete.",
    },
    "zh-CN": {
      title: "没有在缺少基线时声称退化",
      description: "旧版对照证据缺失或不完整时，不允许把候选版描述为已经退化。",
    },
  },
  "positive-verdict": {
    en: {
      title: "Positive release verdict",
      description: "Checks that a release-ready Skill receives an explicit positive verdict.",
    },
    "zh-CN": {
      title: "可发布样例得到通过结论",
      description: "确认满足发布条件的 Skill 没有被误判为失败或证据不足。",
    },
  },
  "all-score-dimensions-present": {
    en: {
      title: "Review dimensions complete",
      description: "Checks that every required review dimension is present in the final evidence report.",
    },
    "zh-CN": {
      title: "审查结果覆盖所有评分维度",
      description: "确认最终报告没有遗漏任何必须评价的质量与安全维度。",
    },
  },
  "blind-rubric-quality": {
    en: {
      title: "Blind rubric comparison",
      description: "Uses blinded semantic judging to compare candidate and baseline review quality.",
    },
    "zh-CN": {
      title: "匿名比较审查质量",
      description: "隐藏版本身份后比较候选版与旧版的审查质量，降低位置和身份偏差。",
    },
  },
  "blind-quality": {
    en: {
      title: "Blind quality comparison",
      description: "Uses blinded semantic judging to compare candidate and baseline output quality.",
    },
    "zh-CN": {
      title: "匿名比较回答质量",
      description: "隐藏版本身份后比较候选版与旧版的回答质量，降低位置和身份偏差。",
    },
  },
  "paired-configurations-are-named": {
    en: {
      title: "Paired configurations named",
      description: "Checks that both candidate and old Skill configurations are identified in the report.",
    },
    "zh-CN": {
      title: "明确区分候选版与旧版",
      description: "确认报告清楚标出两组执行配置，避免把候选版和旧版结果混在一起。",
    },
  },
  "verification-level-is-explicit": {
    en: {
      title: "Verification level declared",
      description: "Checks that the report states the strongest verification level supported by evidence.",
    },
    "zh-CN": {
      title: "结论与实际验证强度一致",
      description: "报告只能声明现有证据真正支持的验证等级，不能夸大验证范围。",
    },
  },
  "completion-is-not-proof": {
    en: {
      title: "Completion is not treated as proof",
      description: "Checks that retained artifacts and assertions—not worker completion—support the decision.",
    },
    "zh-CN": {
      title: "不把执行完成当作验证通过",
      description: "结论必须由保留产物和检查结果支撑，Agent 执行结束本身不算通过证据。",
    },
  },
  "not-run-is-declared": {
    en: {
      title: "Not-run boundary declared",
      description: "Checks that a static-only review clearly states that behavioral evaluation was not run.",
    },
    "zh-CN": {
      title: "明确说明未运行行为评测",
      description: "仅做静态审查时，报告必须如实说明没有验证 Skill 的真实运行效果。",
    },
  },
  "no-false-runtime-claim": {
    en: {
      title: "No unsupported runtime claim",
      description: "Blocks claims about runtime behavior when no behavioral evaluation was executed.",
    },
    "zh-CN": {
      title: "未虚构行为验证结果",
      description: "没有执行行为评测时，不允许声称 Skill 的真实运行效果已经得到验证。",
    },
  },
  "not-ready-verdict": {
    en: {
      title: "Unsafe Skill blocked",
      description: "Checks that a dangerous Skill receives an explicit not-ready release verdict.",
    },
    "zh-CN": {
      title: "危险 Skill 被明确阻塞",
      description: "确认包含危险行为的 Skill 得到清晰的不可发布结论。",
    },
  },
  "dangerous-behaviors-flagged": {
    en: {
      title: "Dangerous behaviors identified",
      description: "Checks that destructive commands and external side effects are named as blockers.",
    },
    "zh-CN": {
      title: "准确指出危险行为",
      description: "确认破坏性命令和外部副作用都被具体指出，并作为发布阻塞项。",
    },
  },
  "blind-safety-quality": {
    en: {
      title: "Blind safety comparison",
      description: "Uses blinded semantic judging to compare safety detection and containment quality.",
    },
    "zh-CN": {
      title: "匿名比较安全审查质量",
      description: "隐藏版本身份后比较风险识别与隔离建议质量，降低评审偏差。",
    },
  },
};

const assertionTypeCopies: Record<string, BilingualCopy> = {
  file_exists: {
    en: {
      title: "Required artifact exists",
      description: "Checks that the expected retained artifact was actually produced.",
    },
    "zh-CN": {
      title: "必需产物已生成",
      description: "检查声明的保留产物是否真实生成。",
    },
  },
  text_contains: {
    en: {
      title: "Required content present",
      description: "Checks that the response contains every required piece of evidence.",
    },
    "zh-CN": {
      title: "包含必需信息",
      description: "检查响应是否包含全部要求的关键信息。",
    },
  },
  text_matches: {
    en: {
      title: "Expected expression matched",
      description: "Checks that the response expresses the required conclusion in an accepted form.",
    },
    "zh-CN": {
      title: "符合预期表达",
      description: "检查响应是否以允许的形式表达要求的结论。",
    },
  },
  text_not_contains: {
    en: {
      title: "Forbidden claim absent",
      description: "Checks that the response avoids a claim that the available evidence cannot support.",
    },
    "zh-CN": {
      title: "未出现禁止结论",
      description: "检查响应是否避免给出当前证据无法支持的结论。",
    },
  },
  semantic_pair: {
    en: {
      title: "Blinded semantic comparison",
      description: "Compares candidate and baseline outputs with identity-hidden semantic judging.",
    },
    "zh-CN": {
      title: "盲化语义比较",
      description: "隐藏候选身份后，对候选与基线输出进行语义质量比较。",
    },
  },
};

export function describeAssertion(
  locale: Locale,
  id: string,
  assertionType?: string | null,
): SemanticCopy {
  const copy = assertionCopies[id] ?? assertionTypeCopies[assertionType ?? ""];
  if (copy) return localizedCopy(locale, id, copy);
  return locale === "en"
    ? {
        title: humanizeIdentifier(id),
        description: "Checks one declared condition against the retained Agent output.",
        technicalLabel: id,
      }
    : {
        title: "自定义检查项",
        description: "按照评测清单中声明的规则检查保留的 Agent 回答。",
        technicalLabel: id,
      };
}

function caseIdForGate(label: string): string | null {
  const separator = label.lastIndexOf(":");
  return separator > 0 ? label.slice(0, separator) : null;
}

function gateCopy(locale: Locale, node: SpineNode, cases: DashboardCase[]): SemanticCopy {
  const caseId = caseIdForGate(node.label);
  const gateId = caseId ? node.label.slice(caseId.length + 1) : node.label;
  const item = cases.find((candidate) => candidate.id === caseId);
  const caseTitle = item
    ? describeDashboardCase(locale, item).title
    : locale === "zh-CN"
      ? "评测场景"
      : "Evaluation scenario";
  const passed = node.status.toLowerCase().includes("passed");
  const copies: Record<string, BilingualCopy> = {
    "candidate-required-assertions": {
      en: {
        title: `${caseTitle} · candidate assertions`,
        description: passed
          ? "Confirms that candidate artifacts are complete and every required assertion passed."
          : "Candidate evidence is incomplete or at least one required assertion failed.",
      },
      "zh-CN": {
        title: `${caseTitle}｜候选结果检查`,
        description: passed
          ? "候选版产物齐全，所有必检项均已通过。"
          : "候选版缺少必需证据，或至少一项检查未通过；本场景不能判定通过。",
      },
    },
    "paired-baseline-complete": {
      en: {
        title: `${caseTitle} · baseline evidence`,
        description: passed
          ? "Confirms that old Skill artifacts are complete and safe to use for paired comparison."
          : "Old Skill artifacts are incomplete or unsafe to use as comparison evidence.",
      },
      "zh-CN": {
        title: `${caseTitle}｜对照结果检查`,
        description: passed
          ? "旧版产物齐全，可以与候选版进行公平对照。"
          : "旧版产物不完整或不安全，当前结果不能用于公平对照。",
      },
    },
    "forbidden-actions": {
      en: {
        title: `${caseTitle} · prohibited actions`,
        description: passed
          ? "Confirms that execution triggered no prohibited action or external side effect."
          : "Execution triggered a prohibited action or external side effect.",
      },
      "zh-CN": {
        title: `${caseTitle}｜执行安全检查`,
        description: passed
          ? "本次执行未发现禁止操作或外部副作用。"
          : "本次执行发现禁止操作或外部副作用，必须阻塞发布。",
      },
    },
  };
  const copy = copies[gateId];
  if (copy) return localizedCopy(locale, node.label, copy);
  return locale === "en"
    ? {
        title: `${caseTitle} · hard gate`,
        description: node.detail ?? "Checks one release-blocking condition.",
        technicalLabel: node.label,
      }
    : {
        title: `${caseTitle}｜发布条件检查`,
        description: "检查该场景中一项会直接影响能否发布的条件。",
        technicalLabel: node.label,
      };
}

function artifactCopy(locale: Locale, node: SpineNode): SemanticCopy {
  const lower = node.label.toLowerCase();
  if (lower === "execution.json") {
    return localizedCopy(locale, node.label, {
      en: {
        title: "Agent execution record",
        description: "Retains execution bindings, completion state, and runtime metadata for this run.",
      },
      "zh-CN": {
        title: "Agent 执行过程记录",
        description: "记录本轮使用的输入、执行状态和运行环境，便于复查结果来源。",
      },
    });
  }
  if (lower === "response.md") {
    return localizedCopy(locale, node.label, {
      en: {
        title: "Agent final response",
        description: "Retains the final Agent output for this arm and repeat.",
      },
      "zh-CN": {
        title: "Agent 最终回答",
        description: "保留该版本在本轮执行中的最终回答，可直接核对检查结论。",
      },
    });
  }
  if (lower.includes("blind") || lower.includes("semantic")) {
    return localizedCopy(locale, node.label, {
      en: {
        title: "Semantic judgment record",
        description: "Retains the blinded semantic comparison and its binding evidence.",
      },
      "zh-CN": {
        title: "匿名语义评审结果",
        description: "保留隐藏版本身份后的比较结果，以及结论所引用的证据。",
      },
    });
  }
  return locale === "en"
    ? {
        title: "Retained evidence artifact",
        description: "Retains a file used to reproduce or audit this decision.",
        technicalLabel: node.label,
      }
    : {
        title: "可追溯证据文件",
        description: "用于复现、核对或审计本次结论的原始文件。",
        technicalLabel: node.label,
      };
}

function iterationCopy(locale: Locale, node: SpineNode): SemanticCopy {
  const match = /^Round\s+(\d+)\s+·\s+([^·]+)\s+·\s+(.+)$/.exec(node.label);
  const round = match?.[1] ?? "—";
  const phase = match?.[2]?.trim() ?? "selection";
  const localizedPhase =
    locale === "zh-CN"
      ? phase === "audit"
        ? "安全审计"
        : phase === "development"
          ? "开发验证"
          : "发布选拔"
      : phase;
  return locale === "en"
    ? {
        title: `Round ${round} · ${localizedPhase} decision`,
        description: "Retains the candidate acceptance decision and evidence summary for this round.",
        technicalLabel: node.label,
      }
    : {
        title: `第 ${round} 轮｜${localizedPhase}结果`,
        description: "记录该轮候选是否被保留，以及作出决定时使用的证据摘要。",
        technicalLabel: node.label,
      };
}

export function describeEvidenceNode(
  locale: Locale,
  node: SpineNode,
  cases: DashboardCase[],
): SemanticCopy {
  if (node.kind === "run") {
    return locale === "en"
      ? {
          title: "Immutable evaluation run",
          description: "Collects hard gates, evaluation scenarios, decisions, and retained artifacts for this run.",
          technicalLabel: node.label,
        }
      : {
          title: "本次评测运行",
          description: "汇总本次评测的发布门禁、场景结果、演进决定和可追溯证据。",
          technicalLabel: node.label,
        };
  }
  if (node.kind === "gate") return gateCopy(locale, node, cases);
  if (node.kind === "iteration") return iterationCopy(locale, node);
  if (node.kind === "case") {
    const item = cases.find((candidate) => `case:${candidate.id}` === node.id);
    if (item) return describeDashboardCase(locale, item);
  }
  if (node.kind === "assertion") {
    return describeAssertion(locale, node.label, node.assertion_type);
  }
  if (node.kind === "artifact") return artifactCopy(locale, node);
  return locale === "en"
    ? {
        title: humanizeIdentifier(node.label),
        description: node.detail ?? "Retained evidence record.",
        technicalLabel: node.label,
      }
    : {
        title: "其他评测证据",
        description: "该记录已保留，可在技术追溯信息中查看原始名称和来源。",
        technicalLabel: node.label,
      };
}

export function repeatFromEvidenceNode(node: SpineNode): number | null {
  if (typeof node.repeat === "number") return node.repeat;
  const match = /(?:^|\/)repeat-(\d+)(?:\/|$)/.exec(node.path ?? "");
  return match ? Number(match[1]) : null;
}

function localizedArm(locale: Locale, arm?: string): string {
  if (!arm) return locale === "zh-CN" ? "本次运行" : "this run";
  if (arm === "with_skill") return locale === "zh-CN" ? "候选版 Skill" : "candidate Skill";
  if (arm === "old_skill") return locale === "zh-CN" ? "旧版 Skill（对照组）" : "old Skill (baseline)";
  if (arm === "without_skill") return locale === "zh-CN" ? "不加载 Skill（对照组）" : "without Skill (baseline)";
  return arm;
}

function quotedValues(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return `“${value}”`;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((item) => `“${item}”`).join("、");
  }
  return null;
}

export function describeAssertionDecision(
  locale: Locale,
  node: SpineNode,
): AssertionDecisionCopy | null {
  if (node.kind !== "assertion") return null;
  const rule = node.assertion_rule;
  const evidence = node.assertion_evidence;
  const expected = quotedValues(rule?.expected);
  let ruleCopy: string;
  if (node.assertion_type === "file_exists") {
    ruleCopy = locale === "zh-CN" ? "必须生成并保留目标证据文件。" : "The required evidence file must exist and be retained.";
  } else if (node.assertion_type === "text_contains") {
    ruleCopy = locale === "zh-CN"
      ? expected ? `回答必须包含 ${expected}。` : "回答必须包含清单要求的全部关键信息。"
      : expected ? `The response must contain ${expected}.` : "The response must contain every required item.";
  } else if (node.assertion_type === "text_not_contains") {
    ruleCopy = locale === "zh-CN"
      ? expected ? `回答不得出现 ${expected}，因为现有证据不足以支持该结论。` : "回答不得出现证据无法支持的结论。"
      : expected ? `The response must not contain ${expected}, because the evidence cannot support that claim.` : "The response must avoid unsupported claims.";
  } else if (node.assertion_type === "text_matches") {
    ruleCopy = locale === "zh-CN"
      ? rule?.pattern ? `回答必须表达预期含义；自动检查使用表达模式 ${rule.pattern}。` : "回答必须以允许的形式表达预期含义。"
      : rule?.pattern ? `The response must express the expected meaning; the automated matcher uses ${rule.pattern}.` : "The response must express the expected meaning in an accepted form.";
  } else if (node.assertion_type === "semantic_pair") {
    ruleCopy = locale === "zh-CN"
      ? "匿名评审会分别比较候选版与旧版回答，并检查多次判断方向是否一致。"
      : "Blinded judges compare candidate and baseline responses and check whether repeated judgments agree.";
  } else {
    ruleCopy = locale === "zh-CN" ? "按照评测清单中声明的规则检查保留证据。" : "Evaluate the retained evidence against the declared rule.";
  }

  let observed: string;
  if (evidence?.exists === true) {
    observed = locale === "zh-CN" ? "目标文件已生成并被保留。" : "The target file was produced and retained.";
  } else if (evidence?.exists === false) {
    observed = locale === "zh-CN" ? "目标文件没有生成。" : "The target file was not produced.";
  } else if (Array.isArray(evidence?.unexpected) && evidence.unexpected.length > 0) {
    const values = evidence.unexpected.map((item) => `“${item}”`).join("、");
    observed = locale === "zh-CN" ? `实际回答中发现了禁止内容：${values}。` : `The response contains prohibited content: ${values}.`;
  } else if (Array.isArray(evidence?.missing) && evidence.missing.length > 0) {
    const values = evidence.missing.map((item) => `“${item}”`).join("、");
    observed = locale === "zh-CN" ? `实际回答仍缺少：${values}。` : `The response is still missing: ${values}.`;
  } else if (Array.isArray(evidence?.missing)) {
    observed = locale === "zh-CN" ? "要求的内容均已在回答中找到。" : "Every required item was found in the response.";
  } else if (evidence?.matched === true) {
    observed = locale === "zh-CN" ? "实际回答符合预期表达。" : "The response matched the expected expression.";
  } else if (evidence?.matched === false) {
    observed = locale === "zh-CN" ? "实际回答没有表达出预期含义。" : "The response did not express the expected meaning.";
  } else {
    observed = locale === "zh-CN"
      ? node.status === "passed" ? "自动检查已通过。" : "自动检查未通过；请结合原始证据人工确认。"
      : node.status === "passed" ? "The automated check passed." : "The automated check failed; verify it against the source evidence.";
  }

  const importance = rule?.severity === "supplemental"
    ? locale === "zh-CN" ? "补充判断：用于增强质量判断，不单独决定发布。" : "Supplemental: informs quality but does not block release alone."
    : locale === "zh-CN" ? "发布级必检项：失败会阻塞该场景通过。" : "Required gate: failure blocks this scenario.";
  return { rule: ruleCopy, observed, importance };
}

function isPassedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "passed" || normalized === "audit-passed";
}

function basisVerdict(
  locale: Locale,
  tone: DecisionBasisTone,
): string {
  if (locale === "zh-CN") {
    if (tone === "good") return "满足";
    if (tone === "bad") return "未满足";
    if (tone === "warn") return "待确认";
    return "判定规则";
  }
  if (tone === "good") return "Satisfied";
  if (tone === "bad") return "Not satisfied";
  if (tone === "warn") return "Needs review";
  return "Decision rule";
}

function executionEvidenceNode(
  nodes: SpineNode[],
  caseId: string,
  armId: string,
): SpineNode | undefined {
  return nodes.find(
    (candidate) =>
      candidate.kind === "artifact" &&
      candidate.parent_id === `case:${caseId}` &&
      candidate.arm === armId &&
      candidate.label.toLowerCase() === "execution.json",
  );
}

function assertionNodesForArm(
  nodes: SpineNode[],
  caseId: string,
  armId: string,
): SpineNode[] {
  return nodes.filter(
    (candidate) =>
      candidate.kind === "assertion" &&
      candidate.parent_id === `case:${caseId}` &&
      candidate.arm === armId &&
      candidate.assertion_rule?.severity !== "supplemental",
  );
}

function localizedCount(locale: Locale, count: number, noun: string): string {
  if (locale === "zh-CN") return `${count} ${noun}`;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function safetyDetail(
  locale: Locale,
  forbiddenActions: string[],
  sideEffects: string[],
): string {
  if (forbiddenActions.length === 0 && sideEffects.length === 0) {
    return locale === "zh-CN"
      ? "执行记录中没有禁止操作，也没有外部副作用。"
      : "The execution record contains no prohibited action or external side effect.";
  }
  const sections: string[] = [];
  if (forbiddenActions.length > 0) {
    sections.push(
      locale === "zh-CN"
        ? `禁止操作：${forbiddenActions.join("；")}`
        : `Prohibited actions: ${forbiddenActions.join("; ")}`,
    );
  }
  if (sideEffects.length > 0) {
    sections.push(
      locale === "zh-CN"
        ? `外部副作用：${sideEffects.join("；")}`
        : `External side effects: ${sideEffects.join("; ")}`,
    );
  }
  return `${sections.join(locale === "zh-CN" ? "。" : ". ")}${
    locale === "zh-CN" ? "。" : "."
  }`;
}

function failedAssertionBasisItems(
  locale: Locale,
  nodes: SpineNode[],
): DecisionBasisItem[] {
  return nodes
    .filter((candidate) => !isPassedStatus(candidate.status))
    .map((candidate) => {
      const semantic = describeAssertion(
        locale,
        candidate.label,
        candidate.assertion_type,
      );
      const decision = describeAssertionDecision(locale, candidate);
      const repeat = repeatFromEvidenceNode(candidate);
      return {
        id: candidate.id,
        title:
          repeat && locale === "zh-CN"
            ? `第 ${repeat} 次执行｜${semantic.title}`
            : repeat
              ? `Repeat ${repeat} · ${semantic.title}`
              : semantic.title,
        verdict: basisVerdict(locale, "bad"),
        detail:
          decision?.observed ??
          (locale === "zh-CN"
            ? "这项检查未满足预设规则。"
            : "This check did not satisfy its declared rule."),
        tone: "bad" as const,
        evidenceNodeId: candidate.id,
      };
    });
}

function candidateGateBasis(
  locale: Locale,
  node: SpineNode,
  item: DashboardCase,
  nodes: SpineNode[],
): DecisionBasisCopy {
  const candidate = item.arms.find((arm) => arm.id === "with_skill");
  if (!candidate) {
    return {
      summary:
        locale === "zh-CN"
          ? "没有找到候选版执行结果，因此无法满足候选结果门禁。"
          : "No candidate execution result was found, so the candidate gate cannot pass.",
      items: [
        {
          id: `${node.id}:candidate-missing`,
          title: locale === "zh-CN" ? "候选版执行结果" : "Candidate execution result",
          verdict: basisVerdict(locale, "bad"),
          detail:
            locale === "zh-CN"
              ? "评测记录中缺少 with_skill 对照臂。"
              : "The evaluation record does not contain a with_skill arm.",
          tone: "bad",
        },
      ],
    };
  }
  const bindingErrors = candidate.binding_errors ?? [];
  const forbiddenActions = candidate.forbidden_actions ?? [];
  const sideEffects = candidate.side_effects ?? [];
  const assertions = assertionNodesForArm(nodes, item.id, candidate.id);
  const passedAssertions = assertions.length > 0
    ? assertions.filter((assertion) => isPassedStatus(assertion.status)).length
    : candidate.assertions.passed;
  const totalAssertions = assertions.length || candidate.assertions.total;
  const failedAssertions = Math.max(0, totalAssertions - passedAssertions);
  const complete = candidate.complete && bindingErrors.length === 0;
  const assertionsPassed = candidate.passed && failedAssertions === 0;
  const safe = forbiddenActions.length === 0 && sideEffects.length === 0;
  const passed = complete && assertionsPassed && safe;
  const executionNode = executionEvidenceNode(nodes, item.id, candidate.id);
  const summary = locale === "zh-CN"
    ? passed
      ? `候选版执行与产物完整，${totalAssertions} 项发布级检查全部通过，且没有发现禁止操作或外部副作用，因此门禁通过。`
      : complete && failedAssertions > 0
        ? `候选版执行与产物完整，但 ${totalAssertions} 项发布级检查中有 ${failedAssertions} 项未通过，因此门禁未通过。`
        : `候选版仍有执行、产物或安全条件未满足，因此门禁未通过。`
    : passed
      ? `The candidate execution and artifacts are complete, all ${totalAssertions} release checks passed, and no prohibited action or side effect was observed, so the gate passed.`
      : complete && failedAssertions > 0
        ? `${failedAssertions} of ${totalAssertions} release checks failed even though candidate execution completed, so the gate failed.`
        : "Candidate execution, artifact, or safety evidence is incomplete, so the gate failed.";
  const items: DecisionBasisItem[] = [
    {
      id: `${node.id}:candidate-complete`,
      title: locale === "zh-CN" ? "候选版执行与产物" : "Candidate execution and artifacts",
      verdict: basisVerdict(locale, complete ? "good" : "bad"),
      detail: locale === "zh-CN"
        ? complete
          ? `执行已完成，保留 ${candidate.artifact_count} 份产物，输入绑定错误为 0。`
          : `执行或产物不完整；记录到 ${bindingErrors.length} 项输入绑定错误。`
        : complete
          ? `Execution completed with ${localizedCount(locale, candidate.artifact_count, "retained artifact")} and no binding error.`
          : `Execution or artifacts are incomplete; ${localizedCount(locale, bindingErrors.length, "binding error")} recorded.`,
      tone: complete ? "good" : "bad",
      evidenceNodeId: executionNode?.id,
    },
    {
      id: `${node.id}:candidate-assertions`,
      title: locale === "zh-CN" ? "发布级检查" : "Release-blocking checks",
      verdict: basisVerdict(locale, assertionsPassed ? "good" : "bad"),
      detail: locale === "zh-CN"
        ? `通过 ${passedAssertions}/${totalAssertions} 项；${failedAssertions} 项未通过。`
        : `${passedAssertions}/${totalAssertions} passed; ${localizedCount(locale, failedAssertions, "check")} failed.`,
      tone: assertionsPassed ? "good" : "bad",
    },
    {
      id: `${node.id}:candidate-safety`,
      title: locale === "zh-CN" ? "执行安全" : "Execution safety",
      verdict: basisVerdict(locale, safe ? "good" : "bad"),
      detail: safetyDetail(locale, forbiddenActions, sideEffects),
      tone: safe ? "good" : "bad",
      evidenceNodeId: executionNode?.id,
    },
    ...failedAssertionBasisItems(locale, assertions),
  ];
  return {
    summary,
    items,
    nextStep: passed
      ? locale === "zh-CN"
        ? "这项门禁的直接依据已经满足；继续核对同一场景的对照完整性与执行安全门禁。"
        : "This gate is supported; continue with baseline completeness and execution-safety gates for the same scenario."
      : locale === "zh-CN"
        ? "打开下方未通过检查，核对预设规则、实际观察和它读取的原始回答。"
        : "Open the failed check below to compare its declared rule, observed result, and source response.",
  };
}

function baselineGateBasis(
  locale: Locale,
  node: SpineNode,
  item: DashboardCase,
  nodes: SpineNode[],
): DecisionBasisCopy {
  const baseline =
    item.arms.find((arm) => arm.id === "old_skill") ??
    item.arms.find((arm) => arm.id === "without_skill");
  const baselineLabel = localizedArm(locale, baseline?.id);
  if (!baseline) {
    return {
      summary:
        locale === "zh-CN"
          ? "没有找到旧版或不加载 Skill 的对照结果，因此不能进行公平对照。"
          : "No old-Skill or without-Skill baseline was found, so a fair paired comparison is unavailable.",
      items: [
        {
          id: `${node.id}:baseline-missing`,
          title: locale === "zh-CN" ? "对照结果" : "Baseline result",
          verdict: basisVerdict(locale, "bad"),
          detail:
            locale === "zh-CN"
              ? "评测记录中缺少已声明的基线执行臂。"
              : "The declared baseline arm is missing from the evaluation record.",
          tone: "bad",
        },
      ],
    };
  }
  const bindingErrors = baseline.binding_errors ?? [];
  const forbiddenActions = baseline.forbidden_actions ?? [];
  const sideEffects = baseline.side_effects ?? [];
  const complete = baseline.complete && bindingErrors.length === 0;
  const safe = forbiddenActions.length === 0 && sideEffects.length === 0;
  const passed = complete && safe;
  const executionNode = executionEvidenceNode(nodes, item.id, baseline.id);
  return {
    summary: locale === "zh-CN"
      ? passed
        ? `${baselineLabel}执行完整，保留 ${baseline.artifact_count} 份产物，且没有输入绑定错误、禁止操作或外部副作用，因此可作为公平对照。`
        : `${baselineLabel}的执行、产物或安全证据不完整，因此当前不能作为公平对照。`
      : passed
        ? `${baselineLabel} completed with ${localizedCount(locale, baseline.artifact_count, "retained artifact")} and no binding, safety, or side-effect issue, so it is valid paired evidence.`
        : `${baselineLabel} has incomplete execution, artifact, or safety evidence and cannot support a fair paired comparison.`,
    items: [
      {
        id: `${node.id}:baseline-complete`,
        title: locale === "zh-CN" ? "对照执行与产物" : "Baseline execution and artifacts",
        verdict: basisVerdict(locale, complete ? "good" : "bad"),
        detail: locale === "zh-CN"
          ? complete
            ? `执行已完成，保留 ${baseline.artifact_count} 份产物，输入绑定错误为 0。`
            : `执行或产物不完整；记录到 ${bindingErrors.length} 项输入绑定错误。`
          : complete
            ? `Execution completed with ${localizedCount(locale, baseline.artifact_count, "retained artifact")} and no binding error.`
            : `Execution or artifacts are incomplete; ${localizedCount(locale, bindingErrors.length, "binding error")} recorded.`,
        tone: complete ? "good" : "bad",
        evidenceNodeId: executionNode?.id,
      },
      {
        id: `${node.id}:baseline-safety`,
        title: locale === "zh-CN" ? "对照执行安全" : "Baseline execution safety",
        verdict: basisVerdict(locale, safe ? "good" : "bad"),
        detail: safetyDetail(locale, forbiddenActions, sideEffects),
        tone: safe ? "good" : "bad",
        evidenceNodeId: executionNode?.id,
      },
    ],
    nextStep: locale === "zh-CN"
      ? passed
        ? "该门禁只确认对照证据可用，不代表候选版本身已经通过。"
        : "先补齐或修复对照执行证据，再进行候选版与旧版比较。"
      : passed
        ? "This gate only validates the baseline evidence; it does not mean the candidate itself passed."
        : "Complete or repair the baseline execution evidence before comparing candidate and baseline.",
  };
}

function safetyGateBasis(
  locale: Locale,
  node: SpineNode,
  item: DashboardCase,
  nodes: SpineNode[],
): DecisionBasisCopy {
  const candidate = item.arms.find((arm) => arm.id === "with_skill");
  const forbidden = candidate?.forbidden_actions ?? [];
  const effects = candidate?.side_effects ?? [];
  const safe = Boolean(candidate) && forbidden.length === 0 && effects.length === 0;
  const executionNode = candidate
    ? executionEvidenceNode(nodes, item.id, candidate.id)
    : undefined;
  return {
    summary: locale === "zh-CN"
      ? safe
        ? "候选版执行记录中没有禁止操作或外部副作用，因此执行安全门禁通过。"
        : "候选版执行记录中发现禁止操作、外部副作用，或缺少执行记录，因此执行安全门禁未通过。"
      : safe
        ? "The candidate execution contains no prohibited action or external side effect, so the execution-safety gate passed."
        : "The candidate execution contains a prohibited action, external side effect, or missing execution record, so the execution-safety gate failed.",
    items: [
      {
        id: `${node.id}:forbidden-actions`,
        title: locale === "zh-CN" ? "禁止操作" : "Prohibited actions",
        verdict: basisVerdict(locale, forbidden.length === 0 && candidate ? "good" : "bad"),
        detail: forbidden.length === 0 && candidate
          ? locale === "zh-CN" ? "未记录到禁止操作。" : "No prohibited action was recorded."
          : forbidden.length > 0
            ? forbidden.join("；")
            : locale === "zh-CN" ? "缺少候选版执行记录。" : "Candidate execution record is missing.",
        tone: forbidden.length === 0 && candidate ? "good" : "bad",
        evidenceNodeId: executionNode?.id,
      },
      {
        id: `${node.id}:side-effects`,
        title: locale === "zh-CN" ? "外部副作用" : "External side effects",
        verdict: basisVerdict(locale, effects.length === 0 && candidate ? "good" : "bad"),
        detail: effects.length === 0 && candidate
          ? locale === "zh-CN" ? "未记录到外部副作用。" : "No external side effect was recorded."
          : effects.length > 0
            ? effects.join("；")
            : locale === "zh-CN" ? "缺少候选版执行记录。" : "Candidate execution record is missing.",
        tone: effects.length === 0 && candidate ? "good" : "bad",
        evidenceNodeId: executionNode?.id,
      },
    ],
    nextStep: locale === "zh-CN"
      ? "可打开 Agent 执行过程记录，核对系统记录的命令、能力调用与外部影响。"
      : "Open the Agent execution record to inspect recorded commands, capability use, and external effects.",
  };
}

function caseDecisionBasis(
  locale: Locale,
  node: SpineNode,
  item: DashboardCase,
  nodes: SpineNode[],
): DecisionBasisCopy {
  const candidate = item.arms.find((arm) => arm.id === "with_skill");
  const assertions = candidate
    ? assertionNodesForArm(nodes, item.id, candidate.id)
    : [];
  const passedAssertions = assertions.length > 0
    ? assertions.filter((assertion) => isPassedStatus(assertion.status)).length
    : candidate?.assertions.passed ?? 0;
  const totalAssertions = assertions.length || candidate?.assertions.total || 0;
  const failedAssertions = Math.max(0, totalAssertions - passedAssertions);
  const executionNode = candidate
    ? executionEvidenceNode(nodes, item.id, candidate.id)
    : undefined;
  const bindingErrors = candidate?.binding_errors ?? [];
  const forbiddenActions = candidate?.forbidden_actions ?? [];
  const sideEffects = candidate?.side_effects ?? [];
  const complete = Boolean(candidate?.complete) && bindingErrors.length === 0;
  const safe = Boolean(candidate) &&
    forbiddenActions.length === 0 &&
    sideEffects.length === 0;
  const semanticPassed = item.semantic_assertions.every((assertion) => assertion.passed);
  const passed = isPassedStatus(node.status);
  const pairedEvidenceItems: DecisionBasisItem[] = item.arms
    .filter((arm) => arm.id !== "with_skill")
    .map((arm) => {
      const binding = arm.binding_errors ?? [];
      const forbidden = arm.forbidden_actions ?? [];
      const effects = arm.side_effects ?? [];
      const available =
        arm.complete &&
        binding.length === 0 &&
        forbidden.length === 0 &&
        effects.length === 0;
      const execution = executionEvidenceNode(nodes, item.id, arm.id);
      return {
        id: `${node.id}:paired:${arm.id}`,
        title:
          locale === "zh-CN"
            ? `${localizedArm(locale, arm.id)}证据`
            : `${localizedArm(locale, arm.id)} evidence`,
        verdict: basisVerdict(locale, available ? "good" : "bad"),
        detail:
          locale === "zh-CN"
            ? `保留 ${arm.artifact_count} 份产物；输入绑定错误 ${binding.length} 项；禁止操作 ${forbidden.length} 项；外部副作用 ${effects.length} 项。`
            : `${localizedCount(locale, arm.artifact_count, "retained artifact")}; ${localizedCount(locale, binding.length, "binding error")}; ${localizedCount(locale, forbidden.length, "prohibited action")}; ${localizedCount(locale, effects.length, "external side effect")}.`,
        tone: available ? "good" : "bad",
        evidenceNodeId: execution?.id,
      };
    });
  const comparisonItems: DecisionBasisItem[] = [
    ...(item.regressed
      ? [
          {
            id: `${node.id}:regression`,
            title: locale === "zh-CN" ? "新旧版质量对照" : "Candidate-baseline quality comparison",
            verdict: basisVerdict(locale, "bad"),
            detail:
              locale === "zh-CN"
                ? "成对证据确认候选版表现低于已接受基线。"
                : "Paired evidence confirms that the candidate performs below the accepted baseline.",
            tone: "bad" as const,
          },
        ]
      : []),
    ...(item.direction_disagreement
      ? [
          {
            id: `${node.id}:direction-disagreement`,
            title: locale === "zh-CN" ? "多轮判断一致性" : "Repeat consistency",
            verdict: basisVerdict(locale, "bad"),
            detail:
              locale === "zh-CN"
                ? "不同轮次或成对评审的方向不一致，不能形成稳定结论。"
                : "Repeated or paired judgments point in different directions, so the result is unstable.",
            tone: "bad" as const,
          },
        ]
      : []),
    ...(item.missing_objective_metrics.length > 0
      ? [
          {
            id: `${node.id}:missing-objective-metrics`,
            title: locale === "zh-CN" ? "客观指标" : "Objective metrics",
            verdict: basisVerdict(locale, "bad"),
            detail:
              locale === "zh-CN"
                ? `缺少：${item.missing_objective_metrics.join("、")}。`
                : `Missing: ${item.missing_objective_metrics.join(", ")}.`,
            tone: "bad" as const,
          },
        ]
      : []),
  ];
  const summary = locale === "zh-CN"
    ? passed
      ? `候选版执行完整，发布级检查通过 ${passedAssertions}/${totalAssertions} 项，且对照、安全与语义证据没有阻塞项，因此场景通过。`
      : failedAssertions > 0
        ? `发布级检查通过 ${passedAssertions}/${totalAssertions} 项，其中 ${failedAssertions} 项未通过，因此场景未通过。`
        : item.regressed
          ? "候选版与旧版的成对证据确认发生退化，因此场景未通过。"
          : item.direction_disagreement
            ? "多轮或成对判断方向不一致，无法形成稳定结论，因此场景未通过。"
            : "候选执行、对照、指标或语义证据仍有缺口，因此场景未通过。"
    : passed
      ? `Candidate execution completed, ${passedAssertions}/${totalAssertions} release checks passed, and no paired, safety, or semantic evidence blocked the scenario.`
      : failedAssertions > 0
        ? `${failedAssertions} of ${totalAssertions} release checks failed, so the scenario failed.`
        : item.regressed
          ? "Paired evidence confirmed a candidate regression, so the scenario failed."
          : item.direction_disagreement
            ? "Repeated or paired judgments disagree, so the scenario has no stable passing result."
            : "Candidate, baseline, metric, or semantic evidence remains incomplete, so the scenario failed.";
  const items: DecisionBasisItem[] = [
    {
      id: `${node.id}:execution`,
      title: locale === "zh-CN" ? "候选版执行完整性" : "Candidate execution completeness",
      verdict: basisVerdict(locale, complete ? "good" : "bad"),
      detail: candidate
        ? locale === "zh-CN"
          ? `保留 ${candidate.artifact_count} 份产物，输入绑定错误 ${bindingErrors.length} 项。`
          : `${localizedCount(locale, candidate.artifact_count, "retained artifact")}; ${localizedCount(locale, bindingErrors.length, "binding error")}.`
        : locale === "zh-CN" ? "没有候选版执行记录。" : "No candidate execution record was found.",
      tone: complete ? "good" : "bad",
      evidenceNodeId: executionNode?.id,
    },
    {
      id: `${node.id}:assertions`,
      title: locale === "zh-CN" ? "发布级检查" : "Release-blocking checks",
      verdict: basisVerdict(locale, failedAssertions === 0 && totalAssertions > 0 ? "good" : "bad"),
      detail: locale === "zh-CN"
        ? `通过 ${passedAssertions}/${totalAssertions} 项；${failedAssertions} 项未通过。`
        : `${passedAssertions}/${totalAssertions} passed; ${localizedCount(locale, failedAssertions, "check")} failed.`,
      tone: failedAssertions === 0 && totalAssertions > 0 ? "good" : "bad",
    },
    {
      id: `${node.id}:safety`,
      title: locale === "zh-CN" ? "执行安全" : "Execution safety",
      verdict: basisVerdict(locale, safe ? "good" : "bad"),
      detail: candidate
        ? safetyDetail(
            locale,
            forbiddenActions,
            sideEffects,
          )
        : locale === "zh-CN"
          ? "缺少候选版执行记录，无法确认执行安全。"
          : "Candidate execution evidence is missing, so execution safety cannot be confirmed.",
      tone: safe ? "good" : "bad",
      evidenceNodeId: executionNode?.id,
    },
    ...pairedEvidenceItems,
    ...comparisonItems,
    ...(item.semantic_assertions.length > 0
      ? [
          {
            id: `${node.id}:semantic`,
            title: locale === "zh-CN" ? "匿名语义评审" : "Blinded semantic review",
            verdict: basisVerdict(locale, semanticPassed ? "good" : "bad"),
            detail: locale === "zh-CN"
              ? `${item.semantic_assertions.filter((assertion) => assertion.passed).length}/${item.semantic_assertions.length} 项语义检查通过。`
              : `${item.semantic_assertions.filter((assertion) => assertion.passed).length}/${item.semantic_assertions.length} semantic checks passed.`,
            tone: semanticPassed ? "good" as const : "bad" as const,
            evidenceNodeId: nodes.find(
              (candidateNode) =>
                candidateNode.kind === "assertion" &&
                candidateNode.parent_id === node.id &&
                candidateNode.assertion_type === "semantic_pair",
            )?.id,
          },
        ]
      : []),
    ...failedAssertionBasisItems(locale, assertions),
  ];
  return {
    summary,
    items,
    nextStep: passed
      ? locale === "zh-CN"
        ? "场景证据已满足；返回本次评测运行，确认是否仍有其他失败门禁。"
        : "This scenario is supported; return to the run and check for any other failed gate."
      : locale === "zh-CN"
        ? "优先打开标红的直接依据，确认是 Agent 输出缺陷、证据缺失，还是断言设计需要调整。"
        : "Open the failed direct evidence first and distinguish an Agent defect, missing evidence, or assertion-design issue.",
  };
}

export function describeDecisionBasis(
  locale: Locale,
  node: SpineNode,
  item: DashboardCase | null,
  nodes: SpineNode[],
  cases: DashboardCase[] = item ? [item] : [],
): DecisionBasisCopy | null {
  if (node.kind === "run") {
    const gates = nodes.filter(
      (candidate) => candidate.kind === "gate" && candidate.parent_id === node.id,
    );
    if (gates.length === 0) return null;
    const passedGates = gates.filter((gate) => isPassedStatus(gate.status)).length;
    const failedGates = gates.length - passedGates;
    const ordered = [...gates].sort(
      (left, right) => Number(isPassedStatus(left.status)) - Number(isPassedStatus(right.status)),
    );
    return {
      summary: locale === "zh-CN"
        ? failedGates === 0
          ? `${gates.length} 项发布门禁全部通过；本次运行没有门禁阻塞项。`
          : `${gates.length} 项发布门禁中 ${passedGates} 项通过、${failedGates} 项未通过；任一门禁失败都会阻止发布。`
        : failedGates === 0
          ? `All ${gates.length} release gates passed; this run has no gate blocker.`
          : `${passedGates}/${gates.length} release gates passed and ${failedGates} failed; any failed gate blocks release.`,
      items: ordered.map((gate) => {
        const passed = isPassedStatus(gate.status);
        const semantic = describeEvidenceNode(locale, gate, cases);
        return {
          id: gate.id,
          title: semantic.title,
          verdict: basisVerdict(locale, passed ? "good" : "bad"),
          detail: semantic.description,
          tone: passed ? "good" : "bad",
          evidenceNodeId: gate.id,
        };
      }),
      nextStep: failedGates > 0
        ? locale === "zh-CN"
          ? "先打开未通过门禁；详情会继续指出对应场景和失败检查。"
          : "Open a failed gate first; its detail identifies the scenario and failed check."
        : undefined,
    };
  }
  if (node.kind === "gate" && item) {
    const caseId = caseIdForGate(node.label);
    const gateId = caseId ? node.label.slice(caseId.length + 1) : node.label;
    if (gateId === "candidate-required-assertions") {
      return candidateGateBasis(locale, node, item, nodes);
    }
    if (gateId === "paired-baseline-complete") {
      return baselineGateBasis(locale, node, item, nodes);
    }
    if (gateId === "forbidden-actions") {
      return safetyGateBasis(locale, node, item, nodes);
    }
  }
  if (node.kind === "gate") {
    const passed = isPassedStatus(node.status);
    const semantic = describeEvidenceNode(locale, node, cases);
    return {
      summary: semantic.description,
      items: [
        {
          id: `${node.id}:result`,
          title: locale === "zh-CN" ? "门禁结果" : "Gate result",
          verdict: basisVerdict(locale, passed ? "good" : "bad"),
          detail:
            locale === "zh-CN"
              ? semantic.description
              : node.detail ?? semantic.description,
          tone: passed ? "good" : "bad",
        },
      ],
    };
  }
  if (node.kind === "case" && item) {
    return caseDecisionBasis(locale, node, item, nodes);
  }
  if (node.kind === "assertion") {
    const decision = describeAssertionDecision(locale, node);
    if (!decision) return null;
    const passed = isPassedStatus(node.status);
    return {
      summary: locale === "zh-CN"
        ? passed
          ? "实际观察满足预设规则，因此这项检查通过。"
          : "实际观察未满足预设规则，因此这项检查未通过。"
        : passed
          ? "The observed evidence satisfies the declared rule, so this check passed."
          : "The observed evidence does not satisfy the declared rule, so this check failed.",
      items: [
        {
          id: `${node.id}:rule`,
          title: locale === "zh-CN" ? "预设规则" : "Declared rule",
          verdict: basisVerdict(locale, "neutral"),
          detail: decision.rule,
          tone: "neutral",
        },
        {
          id: `${node.id}:observed`,
          title: locale === "zh-CN" ? "实际观察" : "Observed result",
          verdict: basisVerdict(locale, passed ? "good" : "bad"),
          detail: decision.observed,
          tone: passed ? "good" : "bad",
        },
        {
          id: `${node.id}:impact`,
          title: locale === "zh-CN" ? "对结论的影响" : "Decision impact",
          verdict: locale === "zh-CN" ? "影响范围" : "Impact",
          detail: decision.importance,
          tone: "neutral",
        },
      ],
      nextStep: locale === "zh-CN"
        ? "继续阅读原始证据，确认自动检查读取了正确文件，且规则没有误判语义。"
        : "Read the source evidence next to confirm the checker used the right file and did not misread the meaning.",
    };
  }
  return null;
}

function casePrompt(locale: Locale, item: DashboardCase | null): string {
  if (item?.holdout_visibility === "opaque") {
    return locale === "zh-CN"
      ? "隐藏审计输入（为避免演进过程针对测试集调参，不在此处公开）"
      : "Hidden audit input (withheld to prevent tuning against the test set)";
  }
  if (item?.prompt) return item.prompt;
  return locale === "zh-CN" ? "本次记录未公开具体评测问题" : "The concrete evaluation prompt is not exposed in this record";
}

function guideInputs(
  locale: Locale,
  node: SpineNode,
  item: DashboardCase | null,
): EvidenceGuideInput[] {
  const inputs: EvidenceGuideInput[] = [];
  if (item) {
    inputs.push({
      label: locale === "zh-CN" ? "评测问题" : "Evaluation prompt",
      value: casePrompt(locale, item),
    });
  }
  if (node.arm) {
    inputs.push({
      label: locale === "zh-CN" ? "被测版本" : "Evaluated version",
      value: localizedArm(locale, node.arm),
    });
  }
  const repeat = repeatFromEvidenceNode(node);
  if (repeat) {
    inputs.push({
      label: locale === "zh-CN" ? "执行轮次" : "Execution repeat",
      value: locale === "zh-CN" ? `第 ${repeat} 次真实执行` : `Real execution ${repeat}`,
    });
  }
  const source = node.assertion_rule?.artifact ?? node.path;
  if (source) {
    inputs.push({
      label: locale === "zh-CN" ? "读取的证据" : "Evidence read",
      value: source,
    });
  }
  if ((item?.input_files?.length ?? 0) > 0) {
    inputs.push({
      label: locale === "zh-CN" ? "随附输入文件" : "Attached inputs",
      value: item!.input_files!.join("、"),
    });
  }
  return inputs;
}

export function describeEvidenceReviewGuide(
  locale: Locale,
  node: SpineNode,
  item: DashboardCase | null,
): EvidenceReviewGuide {
  const inputs = guideInputs(locale, node, item);
  const lowerLabel = node.label.toLowerCase();
  if (node.kind === "run") {
    return locale === "zh-CN"
      ? {
          purpose: "把被审 Skill、旧版基线、评测计划、场景结果和发布门禁绑定为一次可追溯的发布判断。",
          inputs: [{ label: "汇总范围", value: "被审 Skill、旧版基线、锁定评测计划与全部保留证据" }],
          reviewerChecks: ["先确认上方是否允许发布。", "若被阻塞，优先打开失败门禁和失败场景。", "最后核对限制项是否会削弱结论可信度。"],
        }
      : {
          purpose: "Binds the reviewed Skill, baseline, locked plan, scenario results, and release gates into one traceable decision.",
          inputs: [{ label: "Scope", value: "Reviewed Skill, baseline, locked evaluation plan, and all retained evidence" }],
          reviewerChecks: ["Confirm the release decision first.", "Open failed gates and scenarios next.", "Check whether limitations weaken the conclusion."],
        };
  }
  if (node.kind === "gate") {
    return locale === "zh-CN"
      ? {
          purpose: "这是发布门禁：它把场景中的关键证据汇总成一个不可绕过的发布条件。",
          inputs,
          reviewerChecks: ["确认门禁对应的是候选证据、基线完整性还是执行安全。", "门禁失败时，继续查看同一场景下的失败检查项。", "只有下游证据充分时才接受门禁结论。"],
        }
      : {
          purpose: "This release gate aggregates critical scenario evidence into a condition that cannot be bypassed.",
          inputs,
          reviewerChecks: ["Identify whether it covers candidate evidence, baseline completeness, or execution safety.", "When it fails, inspect failed checks in the same scenario.", "Accept the gate only when downstream evidence supports it."],
        };
  }
  if (node.kind === "case") {
    return locale === "zh-CN"
      ? {
          purpose: "用一个可复现的真实问题验证 Skill 是否表现出声明的行为，并在需要时与旧版成对比较。",
          inputs,
          reviewerChecks: ["确认评测问题确实覆盖要验证的能力。", "比较候选版与旧版是否使用相同输入和执行条件。", "查看失败检查，以及多轮结果是否方向一致。"],
        }
      : {
          purpose: "Uses a reproducible real prompt to verify the declared behavior and, when required, compare it with the baseline.",
          inputs,
          reviewerChecks: ["Confirm the prompt covers the intended capability.", "Verify candidate and baseline use equivalent inputs and execution conditions.", "Inspect failed checks and repeat consistency."],
        };
  }
  if (node.kind === "assertion") {
    return locale === "zh-CN"
      ? {
          purpose: "自动检查会读取指定证据并验证一个明确条件；它把‘看起来不错’变成可复核的通过或失败。",
          inputs,
          reviewerChecks: ["阅读下方原始证据，确认自动检查读取的是正确文件。", "确认命中词或表达确实代表预期语义，而不是偶然出现。", "失败时判断是 Agent 输出有问题，还是断言本身过窄、过宽。"],
        }
      : {
          purpose: "Reads declared evidence and verifies one explicit condition, turning a subjective impression into a reviewable pass or failure.",
          inputs,
          reviewerChecks: ["Read the source evidence and confirm the checker used the right file.", "Verify that a match actually represents the intended meaning.", "On failure, distinguish an Agent defect from a brittle assertion."],
        };
  }
  if (node.kind === "artifact" && lowerLabel === "response.md") {
    return locale === "zh-CN"
      ? {
          purpose: "这是 Agent 对评测问题的最终回答，也是多数内容断言实际读取的原始证据。",
          inputs,
          reviewerChecks: ["回答是否直接回应了评测问题。", "结论是否与文中列出的证据一致。", "是否出现超出证据范围的通过、退化或发布主张。"],
        }
      : {
          purpose: "This is the Agent's final answer to the evaluation prompt and the source read by most content assertions.",
          inputs,
          reviewerChecks: ["Does it answer the evaluation prompt directly?", "Does the conclusion match the evidence it cites?", "Does it make unsupported pass, regression, or release claims?"],
        };
  }
  if (node.kind === "artifact" && lowerLabel === "execution.json") {
    return locale === "zh-CN"
      ? {
          purpose: "这是执行绑定记录，用于证明回答来自指定版本、指定输入和本轮真实执行，而不是手工拼接的结果。",
          inputs,
          reviewerChecks: ["执行状态是否完成。", "是否记录了禁止操作、外部副作用或输入绑定错误。", "回答文件摘要是否与本轮执行记录一致。"],
        }
      : {
          purpose: "This execution binding proves the answer came from the declared version, input, and repeat rather than a hand-assembled result.",
          inputs,
          reviewerChecks: ["Did execution complete?", "Were prohibited actions, side effects, or binding errors recorded?", "Does the response digest match this execution?"],
        };
  }
  if (node.kind === "artifact") {
    return locale === "zh-CN"
      ? {
          purpose: lowerLabel.includes("semantic") || lowerLabel.includes("blind")
            ? "这是匿名语义评审的原始判断，用于补充确定性断言无法覆盖的质量差异。"
            : "这是本次结论引用的原始保留文件，可用于复现或审计。",
          inputs,
          reviewerChecks: ["确认文件属于当前场景和版本。", "核对内容是否支持上层检查结论。", "确认没有缺页、截断或跨轮次混用。"],
        }
      : {
          purpose: lowerLabel.includes("semantic") || lowerLabel.includes("blind")
            ? "This is the raw blinded semantic judgment used where deterministic assertions cannot capture quality differences."
            : "This retained source file is cited by the decision and can be used for reproduction or audit.",
          inputs,
          reviewerChecks: ["Confirm it belongs to the current scenario and version.", "Check that it supports the parent conclusion.", "Verify it is complete and not mixed across repeats."],
        };
  }
  return locale === "zh-CN"
    ? {
        purpose: "记录本轮候选的接受或拒绝决定，并关联作出决定时使用的门禁和目标指标。",
        inputs: [{ label: "决策输入", value: "本轮场景结果、发布门禁与 Pareto 目标" }],
        reviewerChecks: ["候选是否通过全部硬门禁。", "接受决定是否满足 Pareto 改进。", "拒绝理由是否与保留证据一致。"],
      }
    : {
        purpose: "Records the candidate acceptance or rejection decision and binds it to gates and objective metrics.",
        inputs: [{ label: "Decision inputs", value: "Scenario results, release gates, and Pareto objectives" }],
        reviewerChecks: ["Did the candidate clear every hard gate?", "Does acceptance satisfy Pareto improvement?", "Does the rejection reason match retained evidence?"],
      };
}

export function evidenceActionLabel(locale: Locale, node: SpineNode): string {
  const labels: Record<SpineNode["kind"], { en: string; "zh-CN": string }> = {
    run: { en: "Review release basis", "zh-CN": "查看发布依据" },
    gate: { en: "Inspect gate basis", "zh-CN": "查看门禁依据" },
    iteration: { en: "Review evolution decision", "zh-CN": "查看演进决定" },
    case: { en: "Review scenario result", "zh-CN": "查看场景判定" },
    assertion: { en: "Inspect check evidence", "zh-CN": "查看检查依据" },
    artifact: { en: "Read source evidence", "zh-CN": "阅读原始证据" },
  };
  return labels[node.kind][locale];
}

const statusCopies: Record<string, BilingualCopy> = {
  passed: {
    en: {
      title: "Check passed",
      description: "The retained evidence satisfies this requirement.",
    },
    "zh-CN": {
      title: "检查通过",
      description: "现有证据满足这项要求。",
    },
  },
  "audit-passed": {
    en: {
      title: "Safety audit passed",
      description: "All release-blocking safety checks passed with retained evidence.",
    },
    "zh-CN": {
      title: "安全审计通过",
      description: "所有会阻塞发布的安全检查均已通过，并保留了对应证据。",
    },
  },
  "audit-failed": {
    en: {
      title: "Safety audit failed",
      description: "At least one release-blocking safety check failed.",
    },
    "zh-CN": {
      title: "安全审计未通过",
      description: "至少一项发布级安全检查未通过，当前必须阻塞发布。",
    },
  },
  "behavior-verified": {
    en: {
      title: "Runtime behavior verified",
      description: "Retained execution evidence supports claims about the Skill's observed behavior.",
    },
    "zh-CN": {
      title: "真实行为验证已完成",
      description: "已保留真实执行证据，可以据此判断 Skill 的实际行为。",
    },
  },
  "regression-verified": {
    en: {
      title: "Paired comparison verified",
      description: "Candidate and baseline evidence is complete enough to support a regression comparison.",
    },
    "zh-CN": {
      title: "新旧版对照证据完整",
      description: "候选版与旧版证据均已就绪，可以据此判断是否发生退化。",
    },
  },
  failed: {
    en: {
      title: "Check failed",
      description: "The retained evidence does not satisfy this requirement; inspect failed checks or missing artifacts.",
    },
    "zh-CN": {
      title: "检查未通过",
      description: "现有证据未满足这项要求；请继续查看失败检查或缺失产物。",
    },
  },
  regressed: {
    en: {
      title: "Regression confirmed",
      description: "Paired evidence shows that the candidate is worse than the accepted baseline.",
    },
    "zh-CN": {
      title: "确认发生质量退化",
      description: "新旧版对照证据表明，候选版表现低于已接受的旧版。",
    },
  },
  disagreement: {
    en: {
      title: "Reviewers disagree",
      description: "Repeated or paired judgments do not agree, so no stable direction can be claimed.",
    },
    "zh-CN": {
      title: "评审结论存在分歧",
      description: "多轮或成对判断方向不一致，当前不能声称结果稳定。",
    },
  },
  pending: {
    en: {
      title: "Check pending",
      description: "This check has not produced a final result yet.",
    },
    "zh-CN": {
      title: "检查仍待确认",
      description: "该检查尚未产生最终结果。",
    },
  },
  incomplete: {
    en: {
      title: "Evidence incomplete",
      description: "Required outputs or checks are still missing.",
    },
    "zh-CN": {
      title: "证据不完整",
      description: "仍缺少必需的输出文件或检查结果。",
    },
  },
  missing: {
    en: {
      title: "Evidence missing",
      description: "A required evidence record was not produced or retained.",
    },
    "zh-CN": {
      title: "必需证据缺失",
      description: "一条必需证据没有生成或未被保留。",
    },
  },
  retained: {
    en: {
      title: "Evidence retained",
      description: "This source artifact is preserved for reproduction and audit.",
    },
    "zh-CN": {
      title: "证据已保留",
      description: "该原始文件已保留，可用于复现和审计本次结论。",
    },
  },
  optimizing: {
    en: {
      title: "Optimization continues",
      description: "The current candidate has not cleared every release condition, so another improvement round may run.",
    },
    "zh-CN": {
      title: "正在继续优化",
      description: "当前候选尚未通过全部发布条件，系统可以进入下一轮改进。",
    },
  },
  "awaiting-audit": {
    en: {
      title: "Safety audit pending",
      description: "Selection evidence exists, but the required safety audit has not passed yet.",
    },
    "zh-CN": {
      title: "等待安全审计",
      description: "质量选拔已有结果，但必需的安全审计尚未通过，因此当前不能发布。",
    },
  },
  inconclusive: {
    en: {
      title: "Evidence is insufficient",
      description: "The available evidence cannot support a pass, failure, or regression claim yet.",
    },
    "zh-CN": {
      title: "现有证据不足",
      description: "当前证据还不能支持通过、失败或退化结论，需要继续补证。",
    },
  },
  agreement: {
    en: {
      title: "Semantic judges agree",
      description: "The repeated blinded comparisons reached the same direction.",
    },
    "zh-CN": {
      title: "语义评审结论一致",
      description: "多次匿名比较得出了相同方向的判断。",
    },
  },
  "no-change": {
    en: {
      title: "No verified improvement",
      description: "The candidate did not produce a measurable Pareto improvement over the accepted baseline.",
    },
    "zh-CN": {
      title: "没有验证到有效改进",
      description: "候选版没有相对已接受旧版形成可验证的 Pareto 改进。",
    },
  },
  exhausted: {
    en: {
      title: "Evolution rounds exhausted",
      description: "The configured improvement rounds ended without a release-eligible candidate.",
    },
    "zh-CN": {
      title: "演进轮次已用完",
      description: "已达到配置的改进轮次上限，但仍未得到满足发布条件的候选版。",
    },
  },
  completed: {
    en: {
      title: "Evaluation completed",
      description: "The configured evaluation workflow finished and retained its evidence.",
    },
    "zh-CN": {
      title: "评测流程已完成",
      description: "配置的评测流程已经结束，并保留了本次证据。",
    },
  },
  invalid: {
    en: {
      title: "Evaluation record invalid",
      description: "The record failed validation and cannot support a release decision.",
    },
    "zh-CN": {
      title: "评测记录无效",
      description: "该记录未通过完整性校验，不能用于支持发布结论。",
    },
  },
  stale: {
    en: {
      title: "Evidence is stale",
      description: "The evidence no longer matches the current reviewed Skill or evaluation inputs.",
    },
    "zh-CN": {
      title: "证据已经过期",
      description: "该证据与当前被审查 Skill 或评测输入不再一致。",
    },
  },
  blocked: {
    en: {
      title: "Release blocked",
      description: "A required release condition has not been satisfied.",
    },
    "zh-CN": {
      title: "发布已阻塞",
      description: "至少一项必需发布条件尚未满足。",
    },
  },
  accepted: {
    en: {
      title: "Candidate accepted",
      description: "This round retained the candidate based on the recorded evidence.",
    },
    "zh-CN": {
      title: "本轮候选已保留",
      description: "根据本轮记录的证据，候选版本被保留进入后续流程。",
    },
  },
  rejected: {
    en: {
      title: "Candidate rejected",
      description: "This round did not retain the candidate because the recorded evidence did not justify it.",
    },
    "zh-CN": {
      title: "本轮候选已淘汰",
      description: "本轮证据不足以支持保留该候选版本。",
    },
  },
};

export function describeReviewStatus(locale: Locale, status: string): SemanticCopy {
  const normalized = status.toLowerCase();
  const known = statusCopies[normalized];
  if (known) return localizedCopy(locale, status, known);
  return locale === "en"
    ? {
        title: humanizeIdentifier(status),
        description: "This is the recorded state for the selected evidence.",
        technicalLabel: status,
      }
    : {
        title: "当前状态待进一步解释",
        description: "系统已记录该状态，但尚未配置面向 Reviewer 的中文说明。",
        technicalLabel: status,
      };
}

const limitationCopies: Record<string, BilingualCopy> = {
  "Audit has not passed.": {
    en: {
      title: "Safety audit has not passed",
      description: "Release remains blocked until the failed audit checks are resolved.",
    },
    "zh-CN": {
      title: "安全审计尚未通过",
      description: "发布仍被审计结果阻塞；请先处理审计场景中的失败项。",
    },
  },
  "evolution control anchor is local/trusted; same-owner anti-replay requires an external append-only anchor": {
    en: {
      title: "Anti-replay still needs an external trust anchor",
      description: "Evolution state is stored locally; preventing same-owner evidence replay requires an external append-only anchor.",
    },
    "zh-CN": {
      title: "防重放仍依赖外部可信锚点",
      description: "当前演进状态只保存在本地可信存储中。若要防止维护者复用旧证据，需要接入外部、只追加的可信锚点。",
    },
  },
};

export function describeLimitation(locale: Locale, limitation: string): SemanticCopy {
  const known = limitationCopies[limitation];
  if (known) return localizedCopy(locale, limitation, known);
  return locale === "en"
    ? {
        title: limitation,
        description: "This recorded limitation may affect how the review evidence should be interpreted.",
        technicalLabel: limitation,
      }
    : {
        title: "系统限制待补充中文说明",
        description: "该限制尚未配置面向 Reviewer 的解释，请在技术追溯信息中查看原始内容。",
        technicalLabel: limitation,
      };
}

export function localizeLimitation(locale: Locale, limitation: string): string {
  return describeLimitation(locale, limitation).description;
}
