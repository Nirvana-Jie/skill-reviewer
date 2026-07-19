import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson } from "./agent-process.mjs";

function configurationInstruction(assignment) {
  const configuration = assignment.configuration;
  if (!configuration || typeof configuration !== "object") {
    throw new Error("assignment.configuration must be an object");
  }
  const { kind, skill_path: skillPath } = configuration;
  if (kind === "without_skill") {
    if (skillPath !== null) throw new Error("without_skill assignment must not expose a skill path");
    return "实验臂：未使用 Skill。不要查找、加载或调用任何环境 Skill；只根据评测问题与声明输入完成任务。";
  }
  if (!["with_skill", "old_skill"].includes(kind) || typeof skillPath !== "string") {
    throw new Error("assignment configuration is not a supported eval arm");
  }
  const skillFile = resolve(skillPath, "SKILL.md");
  if (!existsSync(skillFile)) throw new Error("locked skill snapshot is missing SKILL.md");
  const label = kind === "with_skill" ? "候选版 Skill" : "旧版 Skill 对照";
  return `实验臂：${label}。开始任务前必须读取并且仅遵循这个锁定快照：${skillFile}。不要使用本机安装的同名或其他 Skill。`;
}

export function buildAgentPrompt({
  assignment,
  assignmentPath,
  repeatRoot,
  accessNote,
  isolationNote,
}) {
  if (!Array.isArray(assignment.input_files)) {
    throw new Error("assignment.input_files must be an array");
  }
  const inputs = assignment.input_files.map((record) => {
    if (!record || typeof record.path !== "string") {
      throw new Error("assignment input file record is invalid");
    }
    return `- ${record.relative_path}: ${record.path}`;
  });
  if (!Array.isArray(assignment.expected_artifacts)) {
    throw new Error("assignment.expected_artifacts must be an array");
  }
  if (!assignment.permissions || typeof assignment.permissions !== "object") {
    throw new Error("assignment.permissions must be an object");
  }
  return [
    "你是单个、已锁定 Skill Eval Case 的执行 Agent。",
    "这是行为评测，不是让你修改评测器、Eval、基线、候选 Skill 或 Git 状态。",
    configurationInstruction(assignment),
    isolationNote,
    accessNote,
    `评测身份：run=${assignment.run_id} case=${assignment.case_id} arm=${assignment.arm} repeat=${assignment.repeat}`,
    `锁定 assignment（只含执行输入，不含答案）：${assignmentPath}`,
    `唯一可写执行目录：${repeatRoot}`,
    "声明的输入文件：",
    ...(inputs.length > 0 ? inputs : ["- 无"]),
    "必须保留的输出（相对于唯一可写目录）：",
    ...assignment.expected_artifacts.map((path) => `- ${path}`),
    `权限声明：${canonicalJson(assignment.permissions)}`,
    "只读取上面声明的 Skill 快照、assignment 和输入文件。不要读取 execution-plan.json、run-lock.json、evals.json、断言、answer key、其他实验臂或历史输出。",
    "只在唯一可写目录中写入声明的输出；不要访问网络、发送消息、安装依赖、提交或推送 Git，除非权限声明明确允许。",
    "不要递归启动完整的 review/evolution 流程，也不要声称批准发布；只完成下面的用户任务。",
    "不要输出或写入隐藏思维过程。可以留下可观察的命令、工具结果、产物和最终答复。",
    "用户任务：",
    String(assignment.prompt),
    "完成后，在最终可见答复中直接给出任务结果。执行框架会把最终答复保留为输出产物。",
  ].join("\n");
}
