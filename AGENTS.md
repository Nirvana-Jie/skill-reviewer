# Repository Agent Instructions

This repository contains the `skill-reviewer` Codex skill and its eval fixtures.

## Package Manager

- Use pnpm exclusively. The pinned version is declared by `packageManager` in
  `package.json`.
- Keep `pnpm-lock.yaml`; do not create `package-lock.json` or `yarn.lock`.
- Use `pnpm install --frozen-lockfile` for reproducible installs.

## Validation Commands

Run these before proposing changes:

```bash
pnpm test
python3 skills/skill-reviewer/scripts/lint_skill_package.py skills/skill-reviewer --format text --fail-on error
python3 -m json.tool skills/skill-reviewer/evals/evals.json >/dev/null
```

For syntax-only checks in restricted macOS sandboxes, direct pycache to a writable
directory:

```bash
env PYTHONPYCACHEPREFIX=/private/tmp/skill-reviewer-pycache python3 -m py_compile skills/skill-reviewer/scripts/*.py
```

## Contribution Workflow

- Do not commit directly to `main`.
- Create a feature branch for every change, push that branch, and open a pull
  request targeting `main`.
- Keep `main` protected. Do not remove pull-request requirements, status checks,
  force-push protection, or deletion protection.
- Use the GitHub PR UI for merges after `Static Checks` passes.
- Trigger Codex Cloud review from the PR only when needed with `@codex review`.

## Review Guidelines

- For `skill-reviewer` PRs, focus on trigger reliability, safety constraints,
  immutable run-contract stability, fixture drift, and whether the executable
  manifest remains accepted by the Runtime compile and grade interfaces.
- Treat changes to `skills/skill-reviewer/SKILL.md`,
  `skills/skill-reviewer/references/review-rubric.md`,
  `skills/skill-reviewer/references/output-contract.md`,
  `skills/skill-reviewer/references/verification-workflow.md`,
  `skills/skill-reviewer/references/evolution-workflow.md`,
  `skills/skill-reviewer/evals/evals.json`, or
  `skills/skill-reviewer/evals/fixtures/**` as eval-risk
  changes.
- Run or account for the validation commands above before recommending merge.
- Do not suggest adding `OPENAI_API_KEY`, `openai/codex-action`,
  `pull_request_target`, or model-backed GitHub Actions unless the repository
  owner explicitly asks for API-key-backed CI.
- Never commit API keys, `.env` files, Codex auth files, generated Codex state,
  or generated eval workspaces.
