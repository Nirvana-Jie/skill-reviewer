#!/usr/bin/env python3
"""Read-only structural linter for agent skill packages.

The linter deliberately checks deterministic package facts only. It does not
score semantic quality and never executes scripts found in the reviewed skill.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote

from skill_eval_runtime import MANIFEST_CONTRACT, ManifestError, validate_manifest


STATIC_ANALYSIS_CONTRACT = "skill-reviewer.static-analysis"
RESOURCE_DIRS = ("references", "scripts", "assets", "evals")
IGNORED_PARTS = {
    ".git",
    ".playwright-cli",
    "__pycache__",
    "node_modules",
    ".DS_Store",
    "coverage",
    ".codex-eval-workspace",
    "skill-reviewer-workspace",
}
IGNORED_TOP_LEVEL_DIRS = {"dist", "build"}
SEVERITY_ORDER = {"info": 0, "warning": 1, "error": 2}
LOCAL_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
BACKTICK_PATH_RE = re.compile(
    r"`((?:references|scripts|assets|evals|dashboard)/[^`]+)`"
)
TOP_LEVEL_FIELD_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$")
KEBAB_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


@dataclass(frozen=True)
class Finding:
    rule_id: str
    severity: str
    path: str
    line: int | None
    message: str


@dataclass(frozen=True)
class FrontmatterIssue:
    line: int
    message: str


def add_finding(
    findings: list[Finding],
    rule_id: str,
    severity: str,
    path: str,
    message: str,
    line: int | None = None,
) -> None:
    findings.append(Finding(rule_id, severity, path, line, message))


def visible_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        ignored_top_level = bool(
            relative.parts and relative.parts[0] in IGNORED_TOP_LEVEL_DIRS
        )
        if ignored_top_level or any(part in IGNORED_PARTS for part in relative.parts):
            continue
        files.append(path)
    return sorted(files, key=lambda item: item.relative_to(root).as_posix())


def package_digest(root: Path, files: Iterable[Path]) -> str:
    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def parse_supported_scalar(value: str) -> tuple[str | None, str | None]:
    """Parse the fail-closed string subset accepted by Codex skill front matter."""
    value = value.strip()
    if not value:
        return "", None
    if value[0] == '"':
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None, "invalid or unterminated double-quoted scalar"
        if not isinstance(parsed, str):
            return None, "double-quoted front matter values must be strings"
        return parsed, None
    if value[0] == "'":
        if len(value) < 2 or value[-1] != "'":
            return None, "unterminated quoted scalar"
        inner = value[1:-1]
        if "'" in inner.replace("''", ""):
            return None, "single quotes inside a quoted scalar must be doubled"
        return inner.replace("''", "'"), None
    if value[-1] in {'"', "'"}:
        return None, "unexpected closing quote in plain scalar"
    if value[0] in "-?:,[]{}#&*!|>%@`":
        return None, "flow collections, aliases, anchors, tags, and reserved indicators are not supported"
    if re.search(r":(?:\s|$)", value):
        return None, "plain scalar contains ': '; quote the value or use a block scalar"
    if re.search(r"\s#", value):
        return None, "inline comments are not supported; use a separate comment line"
    if value.casefold() in {"null", "~", "true", "false", "yes", "no", "on", "off"} or re.fullmatch(
        r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)", value
    ):
        return None, "front matter scalar must be a string, not an implicit YAML value"
    return value, None


def parse_frontmatter(
    text: str,
) -> tuple[dict[str, str], str, int | None, list[FrontmatterIssue]]:
    """Parse top-level string fields and explicit folded/literal block strings only."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text, None, []

    closing = next(
        (idx for idx, line in enumerate(lines[1:], start=1) if line.strip() == "---"),
        None,
    )
    if closing is None:
        return {}, text, None, []

    fields: dict[str, str] = {}
    issues: list[FrontmatterIssue] = []
    idx = 1
    while idx < closing:
        line = lines[idx]
        if not line.strip() or line.lstrip().startswith("#"):
            idx += 1
            continue
        match = TOP_LEVEL_FIELD_RE.fullmatch(line)
        if not match:
            issues.append(
                FrontmatterIssue(
                    idx + 1,
                    "unsupported or malformed YAML; expected a top-level key: value field",
                )
            )
            idx += 1
            continue
        key, raw_value = match.group(1), (match.group(2) or "")
        if key in fields:
            issues.append(FrontmatterIssue(idx + 1, f"duplicate front matter key: {key}"))
        if raw_value.strip() in {">", ">-", "|", "|-"}:
            block: list[str] = []
            idx += 1
            while idx < closing and (lines[idx].startswith(" ") or not lines[idx].strip()):
                block.append(lines[idx].strip())
                idx += 1
            if key not in fields:
                fields[key] = " ".join(item for item in block if item).strip()
            continue
        parsed_value, scalar_issue = parse_supported_scalar(raw_value)
        if scalar_issue:
            issues.append(FrontmatterIssue(idx + 1, scalar_issue))
        elif key not in fields and parsed_value is not None:
            fields[key] = parsed_value
        idx += 1

    body = "\n".join(lines[closing + 1 :]).strip()
    return fields, body, closing + 1, issues


def line_for(text: str, needle: str) -> int | None:
    for number, line in enumerate(text.splitlines(), start=1):
        if needle in line:
            return number
    return None


def resolve_target(target: Path) -> tuple[Path, Path]:
    resolved = target.expanduser().resolve()
    if resolved.is_file():
        if resolved.name != "SKILL.md":
            raise ValueError(f"target file must be SKILL.md, got {resolved}")
        return resolved.parent, resolved
    return resolved, resolved / "SKILL.md"


def check_markdown_links(
    root: Path,
    source_path: Path,
    text: str,
    findings: list[Finding],
) -> None:
    relative_source = source_path.relative_to(root).as_posix()
    for match in LOCAL_LINK_RE.finditer(text):
        raw = match.group(1).strip().strip("<>")
        if not raw or raw.startswith(("#", "http://", "https://", "mailto:")):
            continue
        local = unquote(raw.split("#", 1)[0])
        candidate = (source_path.parent / local).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            add_finding(
                findings,
                "link.outside-package",
                "warning",
                relative_source,
                f"local link leaves the skill package: {raw}",
                text[: match.start()].count("\n") + 1,
            )
            continue
        if not candidate.exists():
            add_finding(
                findings,
                "link.missing-target",
                "error",
                relative_source,
                f"local link target does not exist: {raw}",
                text[: match.start()].count("\n") + 1,
            )


def resource_is_referenced(relative: Path, skill_text: str) -> bool:
    relative_text = relative.as_posix()
    if relative_text in skill_text:
        return True
    parents = list(relative.parents)
    for parent in parents:
        if parent == Path("."):
            continue
        marker = parent.as_posix().rstrip("/") + "/"
        if marker in skill_text:
            return True
    return False


def check_resource_graph(root: Path, skill_text: str, findings: list[Finding]) -> None:
    for directory in RESOURCE_DIRS:
        base = root / directory
        if not base.exists():
            continue
        for path in visible_files(base):
            relative = path.relative_to(root)
            if not resource_is_referenced(relative, skill_text):
                add_finding(
                    findings,
                    "resource.unreferenced",
                    "warning",
                    relative.as_posix(),
                    "resource is not reachable from SKILL.md by an exact path or parent-directory pointer",
                )

    for raw in sorted(set(BACKTICK_PATH_RE.findall(skill_text))):
        clean = raw.split("#", 1)[0]
        if any(token in clean for token in ("*", "<", ">")):
            continue
        candidate = root / clean.rstrip("/.,;:")
        if not candidate.exists():
            add_finding(
                findings,
                "resource.missing-target",
                "error",
                "SKILL.md",
                f"referenced package resource does not exist: {raw}",
                line_for(skill_text, f"`{raw}`"),
            )


def check_eval_manifest(
    root: Path,
    findings: list[Finding],
    expected_skill_name: str | None,
) -> None:
    evals_dir = root / "evals"
    if not evals_dir.exists():
        return

    parsed_json: dict[Path, Any] = {}
    for path in sorted(evals_dir.rglob("*.json")):
        relative = path.relative_to(root).as_posix()
        try:
            parsed_json[path] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            add_finding(
                findings,
                "eval.invalid-json",
                "error",
                relative,
                f"JSON cannot be parsed: {exc}",
            )

    manifest_path = evals_dir / "evals.json"
    manifest = parsed_json.get(manifest_path)
    if manifest is None:
        return
    if not isinstance(manifest, dict):
        add_finding(
            findings,
            "eval.manifest-shape",
            "error",
            "evals/evals.json",
            "manifest must be a JSON object",
        )
        return
    if manifest.get("contract") != MANIFEST_CONTRACT:
        add_finding(
            findings,
            "eval.invalid-manifest",
            "error",
            "evals/evals.json",
            f"contract must be {MANIFEST_CONTRACT}; invalid manifests are not executable",
        )
        return
    manifest_skill_name = manifest.get("skill_name")
    if not isinstance(manifest_skill_name, str) or not manifest_skill_name.strip():
        add_finding(
            findings,
            "eval.manifest-skill-name",
            "error",
            "evals/evals.json",
            "skill_name must be a non-empty string",
        )
    elif expected_skill_name and manifest_skill_name != expected_skill_name:
        add_finding(
            findings,
            "eval.manifest-skill-name",
            "error",
            "evals/evals.json",
            f"skill_name {manifest_skill_name!r} does not match front matter name {expected_skill_name!r}",
        )
    try:
        validate_manifest(manifest, root)
    except ManifestError as error:
        add_finding(
            findings,
            "eval.invalid-manifest",
            "error",
            "evals/evals.json",
            str(error),
        )


def check_sensitive_and_dangerous_text(text: str, findings: list[Finding]) -> None:
    patterns = {
        "safety.destructive-command": r"\brm\s+-rf\b",
        "safety.remote-shell": r"\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b",
        "safety.git-push": r"\bgit\s+push\b",
        "safety.sudo": r"\bsudo\b",
    }
    for rule_id, pattern in patterns.items():
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            add_finding(
                findings,
                rule_id,
                "info",
                "SKILL.md",
                "potentially dangerous command text is present; semantic review must determine whether it is an instruction, example, or guardrail",
                text[: match.start()].count("\n") + 1,
            )


def analyze_skill(target: Path) -> dict[str, Any]:
    findings: list[Finding] = []
    try:
        root, skill_path = resolve_target(target)
    except ValueError as exc:
        return {
            "contract": STATIC_ANALYSIS_CONTRACT,
            "subject": {"path": str(target), "digest": None},
            "passed": False,
            "summary": {"errors": 1, "warnings": 0, "info": 0},
            "findings": [
                asdict(Finding("input.invalid-target", "error", str(target), None, str(exc)))
            ],
        }

    if not root.exists() or not root.is_dir():
        add_finding(
            findings,
            "input.missing-target",
            "error",
            str(root),
            "skill package directory does not exist",
        )
        files: list[Path] = []
    else:
        files = visible_files(root)

    skill_text = ""
    frontmatter: dict[str, str] = {}
    body = ""
    if not skill_path.exists():
        add_finding(
            findings,
            "package.missing-skill-md",
            "error",
            "SKILL.md",
            "skill package must contain SKILL.md",
        )
    else:
        try:
            skill_text = skill_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            add_finding(
                findings,
                "package.unreadable-skill-md",
                "error",
                "SKILL.md",
                f"SKILL.md cannot be read as UTF-8: {exc}",
            )
        else:
            frontmatter, body, closing_line, frontmatter_issues = parse_frontmatter(skill_text)
            if closing_line is None:
                add_finding(
                    findings,
                    "frontmatter.missing",
                    "error",
                    "SKILL.md",
                    "SKILL.md must start with closed YAML front matter",
                    1,
                )
            for issue in frontmatter_issues:
                add_finding(
                    findings,
                    "frontmatter.invalid-yaml",
                    "error",
                    "SKILL.md",
                    issue.message,
                    issue.line,
                )
            name = frontmatter.get("name", "")
            description = frontmatter.get("description", "")
            if not name:
                add_finding(
                    findings,
                    "frontmatter.missing-name",
                    "error",
                    "SKILL.md",
                    "front matter field name is required",
                    2,
                )
            elif not KEBAB_NAME_RE.fullmatch(name):
                add_finding(
                    findings,
                    "frontmatter.invalid-name",
                    "error",
                    "SKILL.md",
                    f"name must be kebab-case, got {name!r}",
                    line_for(skill_text, "name:"),
                )
            if not description:
                add_finding(
                    findings,
                    "frontmatter.missing-description",
                    "error",
                    "SKILL.md",
                    "front matter field description is required",
                    line_for(skill_text, "description:"),
                )
            if not body:
                add_finding(
                    findings,
                    "body.empty",
                    "error",
                    "SKILL.md",
                    "instruction body must not be empty",
                    closing_line,
                )
            if len(skill_text.splitlines()) > 500:
                add_finding(
                    findings,
                    "body.too-long",
                    "warning",
                    "SKILL.md",
                    "SKILL.md exceeds 500 lines; use branch-based progressive disclosure",
                )
            check_resource_graph(root, skill_text, findings)
            check_sensitive_and_dangerous_text(skill_text, findings)

    if root.exists():
        for path in files:
            if path.suffix.casefold() != ".md":
                continue
            try:
                markdown_text = (
                    skill_text
                    if path == skill_path and skill_text
                    else path.read_text(encoding="utf-8")
                )
            except (OSError, UnicodeDecodeError) as exc:
                add_finding(
                    findings,
                    "package.unreadable-markdown",
                    "error",
                    path.relative_to(root).as_posix(),
                    f"Markdown file cannot be read as UTF-8: {exc}",
                )
                continue
            check_markdown_links(root, path, markdown_text, findings)
        check_eval_manifest(root, findings, frontmatter.get("name") or None)
        for path in files:
            if path.name == ".env" or path.name.startswith(".env."):
                add_finding(
                    findings,
                    "safety.sensitive-file",
                    "warning",
                    path.relative_to(root).as_posix(),
                    "potential environment-secret file is present in the skill package",
                )

    counts = {
        severity: sum(1 for finding in findings if finding.severity == severity)
        for severity in ("error", "warning", "info")
    }
    digest = package_digest(root, files) if root.exists() else None
    return {
        "contract": STATIC_ANALYSIS_CONTRACT,
        "subject": {
            "path": str(root),
            "skill_name": frontmatter.get("name") or None,
            "digest": digest,
            "files_scanned": len(files),
        },
        "passed": counts["error"] == 0,
        "summary": {
            "errors": counts["error"],
            "warnings": counts["warning"],
            "info": counts["info"],
        },
        "findings": [asdict(finding) for finding in findings],
    }


def render_text(report: dict[str, Any]) -> str:
    subject = report["subject"]
    lines = [
        f"Skill package: {subject.get('path')}",
        f"Digest: {subject.get('digest') or 'unavailable'}",
        f"Passed: {str(report['passed']).lower()}",
    ]
    for finding in report["findings"]:
        location = finding["path"]
        if finding.get("line"):
            location += f":{finding['line']}"
        lines.append(
            f"[{finding['severity'].upper()}] {finding['rule_id']} {location} — {finding['message']}"
        )
    return "\n".join(lines)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="Skill directory or SKILL.md path")
    parser.add_argument("--format", choices=("json", "text"), default="json")
    parser.add_argument(
        "--fail-on",
        choices=("error", "warning", "never"),
        default="error",
        help="Lowest severity that makes the command exit 1.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = analyze_skill(args.target)
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_text(report))

    if args.fail_on == "never":
        return 0
    threshold = SEVERITY_ORDER[args.fail_on]
    return int(
        any(SEVERITY_ORDER[finding["severity"]] >= threshold for finding in report["findings"])
    )


if __name__ == "__main__":
    raise SystemExit(main())
