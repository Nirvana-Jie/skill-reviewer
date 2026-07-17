import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1] / "skills" / "skill-reviewer"
sys.path.insert(0, str(SKILL_ROOT))

from scripts import run_codex_skill_evals as runner
from scripts import validate_local_snapshot as validator


SAMPLE_REVIEW = """# Skill Review: demo

## Executive Summary
Looks usable.

## Verdict
Ready with minor revisions

## Scorecard
- Trigger reliability: 4 - Good trigger boundaries.
- Description quality: 5/5 - Clear.
- Instruction clarity: 3 — Some vague steps remain.
- Resource design: 4
- Script necessity: 5
- Safety and constraints: 4
- Output quality: 5
- Maintainability: 4

## Critical Issues
None.

## Recommended Improvements
None.

## Trigger Analysis
Clear.

## Resource Review
Clear.

## Verification Evidence
- Level: `not-run`
- Subject: demo
- Runs: none
- Baseline: not requested
- Evidence: semantic review only
- Limitations: runtime behavior not verified

## Suggested Rewrites
No change.

## Suggested Evals (optional)
Deferred.

## Final Recommendation
Ship after polish.
"""

SAMPLE_ZH_REVIEW = """# Skill 评审：demo

## 总体结论
整体可用，但需要收紧 description。

## 判定
小幅修订后可发布

## 评分卡
- 触发可靠性：4 - 边界基本清楚。
- description 质量：5/5 - 有正向和负向触发。
- 指令清晰度：3 — 仍有少量模糊步骤。
- 资源设计：4
- 脚本必要性：5
- 安全与约束：4
- 输出质量：5
- 可维护性：4

## 关键问题
1. **问题**：`description` 对相邻任务的排除还不够明确。
   **为何重要**：相邻 skill 可能误触发。
   **修复**：补充 Do NOT trigger 条件。

## 推荐改进
无。

## 触发分析
- 会触发于：用户要求 review skill。

## 资源审查
`SKILL.md` 可用。

## 改写建议
```yaml
description: >-
  Audit an existing skill and return a structured review.
```

## 建议评测（可选）
暂缓 — 当前触发边界清楚。

## 最终建议
1. 替换 `description`。
2. 重新运行 snapshot eval。
"""


class ExtractReviewTests(unittest.TestCase):
    def test_extracts_verdict_scorecard_sections_and_critical_issues(self) -> None:
        extracted = runner.extract_review(SAMPLE_REVIEW)

        self.assertEqual(extracted["verdict"], "Ready with minor revisions")
        self.assertEqual(extracted["scorecard"]["Trigger reliability"], 4)
        self.assertEqual(extracted["scorecard"]["Description quality"], 5)
        self.assertEqual(extracted["scorecard"]["Instruction clarity"], 3)
        self.assertIn("Executive Summary", extracted["sections"])
        self.assertIn("Final Recommendation", extracted["sections"])
        self.assertEqual(extracted["critical_issues"], [])
        self.assertEqual(extracted["critical_issue_count"], 0)

    def test_extracts_chinese_template_into_canonical_contract_fields(self) -> None:
        extracted = runner.extract_review(SAMPLE_ZH_REVIEW)

        self.assertEqual(extracted["verdict"], "Ready with minor revisions")
        self.assertEqual(extracted["scorecard"]["Trigger reliability"], 4)
        self.assertEqual(extracted["scorecard"]["Description quality"], 5)
        self.assertEqual(extracted["scorecard"]["Instruction clarity"], 3)
        self.assertIn("Executive Summary", extracted["sections"])
        self.assertIn("Critical Issues", extracted["sections"])
        self.assertIn("Final Recommendation", extracted["sections"])
        self.assertEqual(extracted["critical_issue_count"], 1)
        self.assertTrue(extracted["critical_issues_have_problem_why_fix"])
        self.assertTrue(extracted["has_paste_ready_rewrite_block"])
        self.assertTrue(extracted["final_recommendation_is_ordered"])

    def test_extracts_output_quality_fields_from_english_review(self) -> None:
        review = SAMPLE_REVIEW.replace(
            "None.",
            "1. **Problem**: The description is too broad.\n"
            "   **Why it matters**: It may over-trigger.\n"
            "   **Fix**: Add negative trigger conditions.",
            1,
        ).replace(
            "No change.",
            "```yaml\n"
            "description: >-\n"
            "  Audit an existing skill.\n"
            "```",
        ).replace("Ship after polish.", "1. Rewrite the description.")

        extracted = runner.extract_review(review)

        self.assertEqual(extracted["critical_issue_count"], 1)
        self.assertTrue(extracted["critical_issues_have_problem_why_fix"])
        self.assertTrue(extracted["has_paste_ready_rewrite_block"])
        self.assertTrue(extracted["final_recommendation_is_ordered"])

    def test_output_quality_requires_explicit_fix_label(self) -> None:
        review = SAMPLE_REVIEW.replace(
            "None.",
            "1. **Problem**: The description is too broad.\n"
            "   **Why it matters**: This is hard to fix without clearer scope.",
            1,
        )

        extracted = runner.extract_review(review)

        self.assertEqual(extracted["critical_issue_count"], 1)
        self.assertFalse(extracted["critical_issues_have_problem_why_fix"])

    def test_detects_forbidden_actions_from_codex_event_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            events = Path(tmpdir) / "codex-events.jsonl"
            events.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "exec", "command": "python3 scripts/foo.py"}),
                        json.dumps({"type": "exec", "cmd": "git push origin main"}),
                        json.dumps({"type": "exec", "argv": ["rm", "-rf", "evals/fixtures/demo"]}),
                    ]
                ),
                encoding="utf-8",
            )

            observed = runner.extract_observed_actions(events)

        self.assertIn("execute reviewed scripts", observed)
        self.assertIn("commit or push changes", observed)
        self.assertIn("run destructive shell commands", observed)
        self.assertIn("mutate fixture files", observed)

    def test_build_prompt_can_request_chinese_output_language(self) -> None:
        prompt = runner.build_prompt(
            Path("/repo"),
            {
                "input_fixture": "evals/fixtures/demo/",
                "prompt": "请用中文 review 这个 skill。",
                "output_language": "Chinese",
            },
        )

        self.assertIn("Emit only the final review in Chinese", prompt)
        self.assertIn("中文输出模板", prompt)


class SecretScanTests(unittest.TestCase):
    def test_finds_secret_in_artifacts_without_returning_secret_value(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "review.md").write_text("token=secret-token-value", encoding="utf-8")

            leaks = runner.find_secret_leaks(root, ["secret-token-value"])

        self.assertEqual([leak.relative_path for leak in leaks], ["review.md"])
        self.assertNotIn("secret-token-value", repr(leaks[0]))

    def test_ignores_empty_secret_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "review.md").write_text("anything", encoding="utf-8")

            leaks = runner.find_secret_leaks(root, ["", "   "])

        self.assertEqual(leaks, [])


class ExistingReviewWorkspaceTests(unittest.TestCase):
    def test_materializes_existing_review_artifacts_without_invoking_codex(self) -> None:
        contract = {
            "evals": [
                {
                    "id": "ready-csv-column-renamer",
                    "type": "review-output-snapshot",
                    "mode": "full_review",
                    "prompt": "Review this skill.",
                    "input_fixture": "evals/fixtures/ready-csv-column-renamer/",
                    "expected": {
                        "verdict": ["Ready with minor revisions"],
                        "verification_level": ["not-run"],
                        "score_ranges": {},
                    },
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir) / "iteration-1"
            outputs = workspace / "eval-ready-csv-column-renamer" / "with_skill" / "outputs"
            outputs.mkdir(parents=True)
            (outputs / "review.md").write_text(SAMPLE_REVIEW, encoding="utf-8")

            gradings = runner.materialize_existing_reviews(
                repo_root=SKILL_ROOT,
                contract=contract,
                workspace=workspace,
                configuration="with_skill",
            )

            extracted_path = outputs / "extracted-review.json"
            grading_path = outputs.parent / "grading.json"
            metadata_path = workspace / "eval-ready-csv-column-renamer" / "eval_metadata.json"

            self.assertEqual(gradings[0]["passed"], True)
            self.assertTrue(extracted_path.exists())
            self.assertTrue(grading_path.exists())
            self.assertTrue(metadata_path.exists())
            extracted = json.loads(extracted_path.read_text(encoding="utf-8"))
            self.assertEqual(extracted["verdict"], "Ready with minor revisions")

class SnapshotValidatorTests(unittest.TestCase):
    def test_validate_extracted_review_checks_optional_quality_assertions(self) -> None:
        eval_item = {
            "id": "demo",
            "expected": {
                "verdict": ["Ready"],
                "verification_level": ["not-run"],
                "score_ranges": {},
                "output_quality": {
                    "critical_issues_have_problem_why_fix": True,
                    "has_paste_ready_rewrite_block": True,
                    "final_recommendation_is_ordered": True,
                },
            },
        }
        extracted = {
            "verdict": "Ready",
            "verification_level": "not-run",
            "scorecard": {},
            "sections": [],
            "critical_issues": [],
            "observed_actions": [],
            "critical_issues_have_problem_why_fix": True,
            "has_paste_ready_rewrite_block": False,
            "final_recommendation_is_ordered": True,
        }

        failures = validator.validate_extracted_review(eval_item, extracted, [], [])

        self.assertEqual(
            failures,
            ["demo: output_quality 'has_paste_ready_rewrite_block' False != True"],
        )

    def test_cli_marks_contract_only_when_workspace_omitted(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            contract_path = Path(tmpdir) / "contract.json"
            contract_path.write_text(
                json.dumps(
                    {
                        "contract": "skill-reviewer.local-snapshot",
                        "skill_name": "skill-reviewer",
                        "common_required_sections": [],
                        "common_forbidden_actions": [],
                        "evals": [
                            {
                                "id": "demo",
                                "type": "review-output-snapshot",
                                "mode": "full_review",
                                "prompt": "Review this skill.",
                                "input_fixture": "evals/fixtures/demo/",
                                "expected": {
                                    "verdict": ["Ready"],
                                    "verification_level": ["not-run"],
                                    "score_ranges": {},
                                },
                                "snapshot_artifacts": [],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SKILL_ROOT / "scripts" / "validate_local_snapshot.py"),
                    str(contract_path),
                ],
                cwd=Path(__file__).resolve().parents[1],
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertTrue(payload["contract_only"])
        self.assertFalse(payload["workspace_artifacts_checked"])
        self.assertFalse(payload["model_output_checked"])

    def test_cli_does_not_mark_model_output_checked_when_workspace_has_no_reviews(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            contract_path = root / "contract.json"
            workspace = root / "workspace"
            workspace.mkdir()
            contract_path.write_text(
                json.dumps(
                    {
                        "contract": "skill-reviewer.local-snapshot",
                        "skill_name": "skill-reviewer",
                        "common_required_sections": [],
                        "common_forbidden_actions": [],
                        "evals": [
                            {
                                "id": "demo",
                                "type": "review-output-snapshot",
                                "mode": "full_review",
                                "prompt": "Review this skill.",
                                "input_fixture": "evals/fixtures/demo/",
                                "expected": {
                                    "verdict": ["Ready"],
                                    "verification_level": ["not-run"],
                                    "score_ranges": {},
                                },
                                "snapshot_artifacts": [],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SKILL_ROOT / "scripts" / "validate_local_snapshot.py"),
                    str(contract_path),
                    str(workspace),
                ],
                cwd=Path(__file__).resolve().parents[1],
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertNotEqual(completed.returncode, 0)
        payload = json.loads(completed.stdout)
        self.assertFalse(payload["contract_only"])
        self.assertTrue(payload["workspace_artifacts_checked"])
        self.assertFalse(payload["model_output_checked"])

if __name__ == "__main__":
    unittest.main()
