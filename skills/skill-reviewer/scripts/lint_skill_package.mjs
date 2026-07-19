#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { validateManifest } from "./lib/skill-eval-authority.mjs";
import { MANIFEST_CONTRACT, ManifestError } from "./lib/skill-eval-contracts.mjs";
import { isMainModule } from "./lib/module-entrypoint.mjs";
import { readUtf8File } from "./lib/strict-utf8.mjs";

const STATIC_ANALYSIS_CONTRACT = "skill-reviewer.static-analysis";
const RESOURCE_DIRS = ["references", "scripts", "assets", "evals"];
const IGNORED_PARTS = new Set([
  ".git",
  ".playwright-cli",
  "__pycache__",
  "node_modules",
  ".DS_Store",
  "coverage",
  "skill-reviewer-workspace",
]);
const IGNORED_TOP_LEVEL_DIRS = new Set(["dist", "build"]);
const SEVERITY_ORDER = { info: 0, warning: 1, error: 2 };
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isWithin(path, root) {
  const delta = relative(root, path);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

function addFinding(findings, ruleId, severity, path, message, line = null) {
  findings.push({ rule_id: ruleId, severity, path, line, message });
}

export function visibleFiles(root) {
  const files = [];
  function visit(current, parts = []) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const nextParts = [...parts, entry.name];
      if (IGNORED_TOP_LEVEL_DIRS.has(nextParts[0]) || nextParts.some((part) => IGNORED_PARTS.has(part))) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path, nextParts);
      else if (entry.isFile()) files.push(path);
    }
  }
  visit(root);
  return files.sort((left, right) => {
    const leftPath = relative(root, left).split(sep).join("/");
    const rightPath = relative(root, right).split(sep).join("/");
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

export function packageDigest(root, files) {
  const digest = createHash("sha256");
  for (const path of files) {
    digest.update(relative(root, path).split(sep).join("/"));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function parseSupportedScalar(raw) {
  const value = raw.trim();
  if (!value) return { value: "", issue: null };
  if (value[0] === '"') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") {
        return { value: null, issue: "double-quoted front matter values must be strings" };
      }
      return { value: parsed, issue: null };
    } catch {
      return { value: null, issue: "invalid or unterminated double-quoted scalar" };
    }
  }
  if (value[0] === "'") {
    if (value.length < 2 || !value.endsWith("'")) return { value: null, issue: "unterminated quoted scalar" };
    const inner = value.slice(1, -1);
    if (inner.replaceAll("''", "").includes("'")) {
      return { value: null, issue: "single quotes inside a quoted scalar must be doubled" };
    }
    return { value: inner.replaceAll("''", "'"), issue: null };
  }
  if (["'", '"'].includes(value.at(-1))) return { value: null, issue: "unexpected closing quote in plain scalar" };
  if ("-?:,[]{}#&*!|>%@`".includes(value[0])) {
    return { value: null, issue: "flow collections, aliases, anchors, tags, and reserved indicators are not supported" };
  }
  if (/:(?:\s|$)/.test(value)) return { value: null, issue: "plain scalar contains ': '; quote the value or use a block scalar" };
  if (/\s#/.test(value)) return { value: null, issue: "inline comments are not supported; use a separate comment line" };
  if (["null", "~", "true", "false", "yes", "no", "on", "off"].includes(value.toLowerCase()) || /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return { value: null, issue: "front matter scalar must be a string, not an implicit YAML value" };
  }
  return { value, issue: null };
}

export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { fields: {}, body: text, closingLine: null, issues: [] };
  }
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { fields: {}, body: text, closingLine: null, issues: [] };
  const closingIndex = closing + 1;
  const fields = {};
  const issues = [];
  let index = 1;
  while (index < closingIndex) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      issues.push({ line: index + 1, message: "unsupported or malformed YAML; expected a top-level key: value field" });
      index += 1;
      continue;
    }
    const [, key, matchedValue = ""] = match;
    if (key in fields) issues.push({ line: index + 1, message: `duplicate front matter key: ${key}` });
    if ([">", ">-", "|", "|-"].includes(matchedValue.trim())) {
      const block = [];
      index += 1;
      while (index < closingIndex && (lines[index].startsWith(" ") || !lines[index].trim())) {
        block.push(lines[index].trim());
        index += 1;
      }
      if (!(key in fields)) fields[key] = block.filter(Boolean).join(" ").trim();
      continue;
    }
    const parsed = parseSupportedScalar(matchedValue);
    if (parsed.issue) issues.push({ line: index + 1, message: parsed.issue });
    else if (!(key in fields) && parsed.value !== null) fields[key] = parsed.value;
    index += 1;
  }
  return {
    fields,
    body: lines.slice(closingIndex + 1).join("\n").trim(),
    closingLine: closingIndex + 1,
    issues,
  };
}

function lineFor(text, needle) {
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(needle));
  return index < 0 ? null : index + 1;
}

function resolveTarget(target) {
  const resolved = resolve(target);
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    if (basename(resolved) !== "SKILL.md") throw new Error(`target file must be SKILL.md, got ${resolved}`);
    return { root: dirname(resolved), skillPath: resolved };
  }
  return { root: resolved, skillPath: join(resolved, "SKILL.md") };
}

function checkMarkdownLinks(root, sourcePath, text, findings) {
  const sourceRelative = relative(root, sourcePath).split(sep).join("/");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || ["#", "http://", "https://", "mailto:"].some((prefix) => raw.startsWith(prefix))) continue;
    let local;
    try {
      local = decodeURIComponent(raw.split("#", 1)[0]);
    } catch {
      local = raw.split("#", 1)[0];
    }
    const candidate = resolve(dirname(sourcePath), local);
    const line = text.slice(0, match.index).split("\n").length;
    if (!isWithin(candidate, root)) {
      addFinding(findings, "link.outside-package", "warning", sourceRelative, `local link leaves the skill package: ${raw}`, line);
    } else if (!existsSync(candidate)) {
      addFinding(findings, "link.missing-target", "error", sourceRelative, `local link target does not exist: ${raw}`, line);
    }
  }
}

function resourceIsReferenced(relativePath, skillText) {
  if (skillText.includes(relativePath)) return true;
  const parts = relativePath.split("/");
  for (let length = parts.length - 1; length > 0; length -= 1) {
    if (skillText.includes(`${parts.slice(0, length).join("/")}/`)) return true;
  }
  return false;
}

function checkResourceGraph(root, skillText, findings) {
  for (const directory of RESOURCE_DIRS) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    for (const path of visibleFiles(base)) {
      const relativePath = relative(root, path).split(sep).join("/");
      if (!resourceIsReferenced(relativePath, skillText)) {
        addFinding(findings, "resource.unreferenced", "warning", relativePath, "resource is not reachable from SKILL.md by an exact path or parent-directory pointer");
      }
    }
  }
  const resources = [...skillText.matchAll(/`((?:references|scripts|assets|evals|dashboard)\/[^`]+)`/g)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  for (const raw of resources) {
    const clean = raw.split("#", 1)[0];
    if (["*", "<", ">"].some((token) => clean.includes(token))) continue;
    const candidate = join(root, clean.replace(/[\/.,;:]+$/g, ""));
    if (!existsSync(candidate)) {
      addFinding(findings, "resource.missing-target", "error", "SKILL.md", `referenced package resource does not exist: ${raw}`, lineFor(skillText, `\`${raw}\``));
    }
  }
}

function checkEvalManifest(root, findings, expectedSkillName) {
  const evalsDir = join(root, "evals");
  if (!existsSync(evalsDir)) return;
  const parsed = new Map();
  for (const path of visibleFiles(evalsDir).filter((path) => extname(path).toLowerCase() === ".json")) {
    const relativePath = relative(root, path).split(sep).join("/");
    try {
      parsed.set(path, JSON.parse(readUtf8File(path, relativePath)));
    } catch (error) {
      addFinding(findings, "eval.invalid-json", "error", relativePath, `JSON cannot be parsed: ${error.message}`);
    }
  }
  const manifestPath = join(evalsDir, "evals.json");
  if (!parsed.has(manifestPath)) return;
  const manifest = parsed.get(manifestPath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    addFinding(findings, "eval.manifest-shape", "error", "evals/evals.json", "manifest must be a JSON object");
    return;
  }
  if (manifest.contract !== MANIFEST_CONTRACT) {
    addFinding(findings, "eval.invalid-manifest", "error", "evals/evals.json", `contract must be ${MANIFEST_CONTRACT}; invalid manifests are not executable`);
    return;
  }
  if (typeof manifest.skill_name !== "string" || !manifest.skill_name.trim()) {
    addFinding(findings, "eval.manifest-skill-name", "error", "evals/evals.json", "skill_name must be a non-empty string");
  } else if (expectedSkillName && manifest.skill_name !== expectedSkillName) {
    addFinding(findings, "eval.manifest-skill-name", "error", "evals/evals.json", `skill_name ${JSON.stringify(manifest.skill_name)} does not match front matter name ${JSON.stringify(expectedSkillName)}`);
  }
  try {
    validateManifest(manifest, root);
  } catch (error) {
    if (error instanceof ManifestError) addFinding(findings, "eval.invalid-manifest", "error", "evals/evals.json", error.message);
    else throw error;
  }
}

function checkSensitiveAndDangerousText(text, findings) {
  const patterns = new Map([
    ["safety.destructive-command", /\brm\s+-rf\b/i],
    ["safety.remote-shell", /\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b/i],
    ["safety.git-push", /\bgit\s+push\b/i],
    ["safety.sudo", /\bsudo\b/i],
  ]);
  for (const [ruleId, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) addFinding(findings, ruleId, "info", "SKILL.md", "potentially dangerous command text is present; semantic review must determine whether it is an instruction, example, or guardrail", text.slice(0, match.index).split("\n").length);
  }
}

export function analyzeSkill(target) {
  const findings = [];
  let root;
  let skillPath;
  try {
    ({ root, skillPath } = resolveTarget(target));
  } catch (error) {
    return {
      contract: STATIC_ANALYSIS_CONTRACT,
      subject: { path: String(target), digest: null },
      passed: false,
      summary: { errors: 1, warnings: 0, info: 0 },
      findings: [{ rule_id: "input.invalid-target", severity: "error", path: String(target), line: null, message: error.message }],
    };
  }
  let files = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    addFinding(findings, "input.missing-target", "error", root, "skill package directory does not exist");
  } else {
    files = visibleFiles(root);
  }
  let skillText = "";
  let frontmatter = {};
  let body = "";
  if (!existsSync(skillPath)) {
    addFinding(findings, "package.missing-skill-md", "error", "SKILL.md", "skill package must contain SKILL.md");
  } else {
    try {
      skillText = readUtf8File(skillPath, "SKILL.md");
      const parsed = parseFrontmatter(skillText);
      frontmatter = parsed.fields;
      body = parsed.body;
      if (parsed.closingLine === null) addFinding(findings, "frontmatter.missing", "error", "SKILL.md", "SKILL.md must start with closed YAML front matter", 1);
      for (const issue of parsed.issues) addFinding(findings, "frontmatter.invalid-yaml", "error", "SKILL.md", issue.message, issue.line);
      const name = frontmatter.name ?? "";
      const description = frontmatter.description ?? "";
      if (!name) addFinding(findings, "frontmatter.missing-name", "error", "SKILL.md", "front matter field name is required", 2);
      else if (!KEBAB_NAME.test(name)) addFinding(findings, "frontmatter.invalid-name", "error", "SKILL.md", `name must be kebab-case, got ${JSON.stringify(name)}`, lineFor(skillText, "name:"));
      if (!description) addFinding(findings, "frontmatter.missing-description", "error", "SKILL.md", "front matter field description is required", lineFor(skillText, "description:"));
      if (!body) addFinding(findings, "body.empty", "error", "SKILL.md", "instruction body must not be empty", parsed.closingLine);
      if (skillText.split(/\r?\n/).length > 500) addFinding(findings, "body.too-long", "warning", "SKILL.md", "SKILL.md exceeds 500 lines; use branch-based progressive disclosure");
      checkResourceGraph(root, skillText, findings);
      checkSensitiveAndDangerousText(skillText, findings);
    } catch (error) {
      addFinding(findings, "package.unreadable-skill-md", "error", "SKILL.md", `SKILL.md cannot be read as UTF-8: ${error.message}`);
    }
  }
  if (existsSync(root)) {
    for (const path of files.filter((path) => extname(path).toLowerCase() === ".md")) {
      try {
        const text = path === skillPath && skillText
          ? skillText
          : readUtf8File(path, relative(root, path).split(sep).join("/"));
        checkMarkdownLinks(root, path, text, findings);
      } catch (error) {
        addFinding(findings, "package.unreadable-markdown", "error", relative(root, path).split(sep).join("/"), `Markdown file cannot be read as UTF-8: ${error.message}`);
      }
    }
    checkEvalManifest(root, findings, frontmatter.name || null);
    for (const path of files) {
      const name = basename(path);
      if (name === ".env" || name.startsWith(".env.")) {
        addFinding(findings, "safety.sensitive-file", "warning", relative(root, path).split(sep).join("/"), "potential environment-secret file is present in the skill package");
      }
    }
  }
  const counts = Object.fromEntries(["error", "warning", "info"].map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]));
  return {
    contract: STATIC_ANALYSIS_CONTRACT,
    subject: {
      path: root,
      skill_name: frontmatter.name || null,
      digest: existsSync(root) ? packageDigest(root, files) : null,
      files_scanned: files.length,
    },
    passed: counts.error === 0,
    summary: { errors: counts.error, warnings: counts.warning, info: counts.info },
    findings,
  };
}

export function renderText(report) {
  const lines = [
    `Skill package: ${report.subject.path}`,
    `Digest: ${report.subject.digest || "unavailable"}`,
    `Passed: ${String(report.passed).toLowerCase()}`,
  ];
  for (const finding of report.findings) {
    const location = `${finding.path}${finding.line ? `:${finding.line}` : ""}`;
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.rule_id} ${location} — ${finding.message}`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const options = { format: "json", failOn: "error", target: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--format") options.format = argv[++index];
    else if (token === "--fail-on") options.failOn = argv[++index];
    else if (token.startsWith("-")) throw new Error(`unknown option: ${token}`);
    else if (options.target === null) options.target = token;
    else throw new Error(`unexpected argument: ${token}`);
  }
  if (!options.target) throw new Error("target is required");
  if (!["json", "text"].includes(options.format)) throw new Error("--format must be json or text");
  if (!["error", "warning", "never"].includes(options.failOn)) throw new Error("--fail-on must be error, warning, or never");
  return options;
}

function usage() {
  return "Usage: lint_skill_package.mjs TARGET [--format json|text] [--fail-on error|warning|never]";
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const report = analyzeSkill(args.target);
  console.log(args.format === "json" ? JSON.stringify(report, null, 2) : renderText(report));
  if (args.failOn === "never") return 0;
  const threshold = SEVERITY_ORDER[args.failOn];
  return report.findings.some((finding) => SEVERITY_ORDER[finding.severity] >= threshold) ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
