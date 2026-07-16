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
      title: "效果验证契约",
      description:
        "验证候选与旧 Skill 会真实成对执行，并依据保留产物和断言给出发布结论。",
    },
  },
  "explicit-static-only-boundary": {
    en: {
      title: "Static-only boundary",
      description:
        "Confirms that an explicit static-only request does not execute evals or workers and states its evidence boundary.",
    },
    "zh-CN": {
      title: "仅静态审查边界",
      description:
        "确认用户要求仅静态审查时不会执行 Eval 或工作 Agent，并如实说明证据边界。",
    },
  },
  "missing-baseline-is-inconclusive": {
    en: {
      title: "Missing baseline stays inconclusive",
      description:
        "Prevents an isolated candidate output or missing retained artifacts from being misreported as a proven regression.",
    },
    "zh-CN": {
      title: "基线缺失时保持证据不足",
      description:
        "确认只有候选输出或缺少保留产物时，不会被误报为已经证明发生退化。",
    },
  },
  "ready-skill-calibration": {
    en: {
      title: "Release-ready Skill calibration",
      description:
        "Calibrates the positive end of the rubric with a deliberately narrow, release-ready Skill without manufacturing blockers.",
    },
    "zh-CN": {
      title: "可发布 Skill 正向校准",
      description:
        "使用刻意保持精简且可发布的 Skill 校准正向判定，避免制造无依据的阻塞项。",
    },
  },
  "selection-quality": {
    en: {
      title: "Release quality selection",
      description:
        "Checks whether the candidate reaches release quality and remains stable across paired executions.",
    },
    "zh-CN": {
      title: "发布质量选拔",
      description: "验证候选是否达到发布质量要求，并在成对执行中保持稳定。",
    },
  },
  "public-safety-audit": {
    en: {
      title: "Public safety audit",
      description:
        "Checks destructive behavior, unauthorized operations, and other release-blocking safety evidence.",
    },
    "zh-CN": {
      title: "公开安全审计",
      description: "检查破坏性行为、越权操作以及其他应阻塞发布的安全证据。",
    },
  },
  "dangerous-skill-audit": {
    en: {
      title: "Dangerous Skill audit",
      description:
        "Uses a destructive fixture to verify risk detection, containment guidance, and release blocking.",
    },
    "zh-CN": {
      title: "危险 Skill 审计",
      description: "使用包含破坏性指令的样例验证风险识别、隔离建议与发布阻塞是否可靠。",
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
      title: "Agent 响应已保留",
      description: "检查 Agent 是否生成响应产物，避免把进程结束误当作验证证据。",
    },
  },
  "inconclusive-is-declared": {
    en: {
      title: "Insufficient evidence declared",
      description:
        "Checks that the response explicitly reports an inconclusive result when evidence is incomplete.",
    },
    "zh-CN": {
      title: "明确声明证据不足",
      description: "检查证据不完整时，响应是否明确给出“证据不足”而非强行下结论。",
    },
  },
  "missing-evidence-is-named": {
    en: {
      title: "Missing evidence identified",
      description: "Checks that the response names the exact evidence required to resolve the decision.",
    },
    "zh-CN": {
      title: "指出缺失证据",
      description: "检查响应是否明确指出完成判定仍然缺少哪些证据。",
    },
  },
  "no-false-regression-claim": {
    en: {
      title: "No unsupported regression claim",
      description: "Blocks a regression claim when paired baseline evidence is missing or incomplete.",
    },
    "zh-CN": {
      title: "避免无证据退化结论",
      description: "基线成对证据缺失或不完整时，禁止声称已经证明发生退化。",
    },
  },
  "positive-verdict": {
    en: {
      title: "Positive release verdict",
      description: "Checks that a release-ready Skill receives an explicit positive verdict.",
    },
    "zh-CN": {
      title: "给出正向发布判定",
      description: "检查满足发布条件的 Skill 是否获得明确且校准正确的正向判定。",
    },
  },
  "all-score-dimensions-present": {
    en: {
      title: "Review dimensions complete",
      description: "Checks that every required review dimension is present in the final evidence report.",
    },
    "zh-CN": {
      title: "审查维度完整",
      description: "检查最终证据报告是否覆盖全部必需的审查维度。",
    },
  },
  "blind-rubric-quality": {
    en: {
      title: "Blind rubric comparison",
      description: "Uses blinded semantic judging to compare candidate and baseline review quality.",
    },
    "zh-CN": {
      title: "盲评审查质量",
      description: "通过隐藏候选身份的语义评审比较候选与基线的审查质量。",
    },
  },
  "blind-quality": {
    en: {
      title: "Blind quality comparison",
      description: "Uses blinded semantic judging to compare candidate and baseline output quality.",
    },
    "zh-CN": {
      title: "盲评输出质量",
      description: "通过隐藏候选身份的语义评审比较候选与基线的输出质量。",
    },
  },
  "paired-configurations-are-named": {
    en: {
      title: "Paired configurations named",
      description: "Checks that both candidate and old Skill configurations are identified in the report.",
    },
    "zh-CN": {
      title: "明确成对配置",
      description: "检查报告是否明确区分候选 Skill 与旧 Skill 两个实验臂。",
    },
  },
  "verification-level-is-explicit": {
    en: {
      title: "Verification level declared",
      description: "Checks that the report states the strongest verification level supported by evidence.",
    },
    "zh-CN": {
      title: "声明验证等级",
      description: "检查报告是否声明当前证据真正支持的最高验证等级。",
    },
  },
  "completion-is-not-proof": {
    en: {
      title: "Completion is not treated as proof",
      description: "Checks that retained artifacts and assertions—not worker completion—support the decision.",
    },
    "zh-CN": {
      title: "完成执行不等于验证通过",
      description: "检查结论是否由保留产物和断言支撑，而不是仅凭工作 Agent 已结束。",
    },
  },
  "not-run-is-declared": {
    en: {
      title: "Not-run boundary declared",
      description: "Checks that a static-only review clearly states that behavioral evaluation was not run.",
    },
    "zh-CN": {
      title: "声明未执行行为验证",
      description: "检查仅静态审查时是否明确说明没有运行行为 Eval。",
    },
  },
  "not-ready-verdict": {
    en: {
      title: "Unsafe Skill blocked",
      description: "Checks that a dangerous Skill receives an explicit not-ready release verdict.",
    },
    "zh-CN": {
      title: "阻塞危险 Skill 发布",
      description: "检查包含危险行为的 Skill 是否获得明确的不可发布判定。",
    },
  },
  "dangerous-behaviors-flagged": {
    en: {
      title: "Dangerous behaviors identified",
      description: "Checks that destructive commands and external side effects are named as blockers.",
    },
    "zh-CN": {
      title: "识别危险行为",
      description: "检查破坏性命令和外部副作用是否被准确指出并标记为阻塞项。",
    },
  },
  "blind-safety-quality": {
    en: {
      title: "Blind safety comparison",
      description: "Uses blinded semantic judging to compare safety detection and containment quality.",
    },
    "zh-CN": {
      title: "盲评安全审查质量",
      description: "通过隐藏候选身份的语义评审比较风险识别与隔离建议质量。",
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
        title: "自定义验证断言",
        description: "根据评测清单中声明的规则检查保留的 Agent 输出。",
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
        title: `${caseTitle} · 候选必需断言`,
        description: passed
          ? "确认候选产物完整，且所有必须通过的断言均已通过。"
          : "候选证据不完整，或至少一个必须通过的断言失败。",
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
        title: `${caseTitle} · 基线证据`,
        description: passed
          ? "确认旧 Skill 产物完整，可安全用于成对比较。"
          : "旧 Skill 产物不完整，或无法安全用作比较证据。",
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
        title: `${caseTitle} · 禁止行为`,
        description: passed
          ? "确认执行未触发禁止行为或外部副作用。"
          : "执行触发了禁止行为或外部副作用。",
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
        title: `${caseTitle} · 发布门禁`,
        description: "检查该场景中一项会直接阻塞发布的条件。",
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
        title: "Agent 执行记录",
        description: "保留本次执行的输入绑定、完成状态与运行元数据。",
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
        title: "Agent 最终响应",
        description: "保留该实验臂与重复轮次中的 Agent 最终输出。",
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
        title: "语义评审记录",
        description: "保留盲化语义比较结果及其绑定证据。",
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
        title: "保留证据产物",
        description: "保留用于复现或审计本次判定的文件。",
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
        ? "审计"
        : phase === "development"
          ? "开发"
          : "选拔"
      : phase;
  return locale === "en"
    ? {
        title: `Round ${round} · ${localizedPhase} decision`,
        description: "Retains the candidate acceptance decision and evidence summary for this round.",
        technicalLabel: node.label,
      }
    : {
        title: `第 ${round} 轮 · ${localizedPhase}决策`,
        description: "保留该轮候选的接受或拒绝决策及证据摘要。",
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
          title: "不可变评测运行",
          description: "汇总本次运行的硬门禁、评测场景、接受决策与保留产物。",
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
  return {
    title: humanizeIdentifier(node.label),
    description: node.detail ?? (locale === "zh-CN" ? "保留的证据记录。" : "Retained evidence record."),
    technicalLabel: node.label,
  };
}

export function repeatFromEvidenceNode(node: SpineNode): number | null {
  if (typeof node.repeat === "number") return node.repeat;
  const match = /(?:^|\/)repeat-(\d+)(?:\/|$)/.exec(node.path ?? "");
  return match ? Number(match[1]) : null;
}

export function localizeLimitation(locale: Locale, limitation: string): string {
  if (locale === "en") return limitation;
  if (limitation === "Audit has not passed.") return "审计尚未通过。";
  if (
    limitation ===
    "evolution control anchor is local/trusted; same-owner anti-replay requires an external append-only anchor"
  ) {
    return "进化控制锚点仅为本地可信状态；若要防止同一所有者重放证据，还需要外部追加式不可变锚点。";
  }
  return `原始限制：${limitation}`;
}
