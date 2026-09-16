## Summary

<!-- What changed and why. Link the issue or the docs/validation.md ledger entry when relevant. -->

## Eval-risk checklist

Tick every line, or explain why it does not apply. Eval-risk paths are listed in
`AGENTS.md` (Review Guidelines).

- [ ] This PR touches no eval-risk path, **or** every item below is answered.
- [ ] `pnpm test` passed locally, including `tests/evals-manifest-vectors.test.mjs`
      and `tests/evals-manifest-compile.test.mjs` (all three splits compile).
- [ ] New or changed `must_pass` text predicates carry at least two boundary
      pass examples and two boundary fail examples, and the vectors test has a
      realistic response for each affected case.
- [ ] Fixture edits keep every fixture-quoted assertion token present.
- [ ] Decision, grading, measurement, registry, adapter, or worker-prompt changes
      are covered by a Vitest case and described in `docs/architecture.md`.
- [ ] Real self-eval run: `not run` / `development` / `selection` / `audit`
      (see `docs/self-eval-runbook.md`). If run, the ledger entry in
      `docs/validation.md` records run ids, CLI version, model, cell counts,
      pass rates, and the decision.
- [ ] No API keys, model-backed GitHub Actions, generated eval workspaces, or
      local `docs/` research files are included.
