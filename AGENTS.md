# Repository Agent Instructions

This repository contains the `skill-reviewer` Codex skill and its eval fixtures.

## Validation Commands

Run these before proposing changes:

```bash
python3 -m unittest discover -s tests
python3 scripts/validate_local_snapshot.py evals/local-skill-review-snapshot.json
```

For syntax-only checks in restricted macOS sandboxes, direct pycache to a writable
directory:

```bash
env PYTHONPYCACHEPREFIX=/private/tmp/skill-reviewer-pycache python3 -m py_compile scripts/run_codex_skill_evals.py scripts/validate_local_snapshot.py tests/test_run_codex_skill_evals.py
```

## Review Guidelines

- For `skill-reviewer` PRs, focus on trigger reliability, safety constraints,
  snapshot contract stability, fixture drift, and whether output sections remain
  compatible with `scripts/validate_local_snapshot.py`.
- Treat changes to `SKILL.md`, `references/review-rubric.md`,
  `references/review-checklist.md`, `evals/local-skill-review-snapshot.json`, or
  `evals/fixtures/**` as eval-risk changes.
- Run or account for the validation commands above before recommending merge.
- Do not suggest adding `OPENAI_API_KEY`, `openai/codex-action`,
  `pull_request_target`, or model-backed GitHub Actions unless the repository
  owner explicitly asks for API-key-backed CI.
- Never commit API keys, `.env` files, Codex auth files, generated Codex state,
  or generated eval workspaces.
