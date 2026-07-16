import type { DashboardCase, SpineNode } from "./types";
import type { Locale } from "./ui-preferences";

export interface SemanticCopy {
  title: string;
  description: string;
  technicalLabel: string;
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
