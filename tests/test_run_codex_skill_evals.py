import json
import tempfile
import unittest
from pathlib import Path

from scripts import run_codex_skill_evals as runner


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

## Suggested Rewrites
No change.

## Suggested Evals (optional)
Deferred.

## Final Recommendation
Ship after polish.
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
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir) / "iteration-1"
            outputs = workspace / "eval-ready-csv-column-renamer" / "with_skill" / "outputs"
            outputs.mkdir(parents=True)
            (outputs / "review.md").write_text(SAMPLE_REVIEW, encoding="utf-8")

            gradings = runner.materialize_existing_reviews(
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


if __name__ == "__main__":
    unittest.main()
