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

## CI And Secret Policy

- Keep Codex-backed evals limited to `workflow_dispatch` and trusted `main` pushes.
- Do not add `pull_request` or `pull_request_target` triggers that run with `OPENAI_API_KEY`.
- Never commit API keys, `.env` files, Codex auth files, or generated Codex state.
- Use GitHub Actions secrets for `OPENAI_API_KEY`; pass it only to `openai/codex-action@v1`.
- Do not upload Codex auth state as an artifact.
