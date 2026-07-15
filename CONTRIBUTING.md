# Contributing

All repository changes must go through a branch and pull request.

## Required Flow

1. Create a branch from `main`.
2. Commit changes on that branch.
3. Push the branch to GitHub.
4. Open a pull request into `main`.
5. Wait for `Static Checks` to pass.
6. Request Codex Cloud review when needed by commenting on the PR:

   ```text
   @codex review for skill-reviewer eval regression risk. Check SKILL.md, references, eval fixtures, snapshot contract, and CI safety. Do not add API keys or model-backed GitHub Actions.
   ```

7. Merge through the GitHub pull request UI.

Do not push commits directly to `main`, force-push `main`, or bypass pull
request review. The `main` branch is protected in GitHub.

## Local Validation

Run these before opening a pull request:

```bash
python3 -m unittest discover -s tests
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json
```
