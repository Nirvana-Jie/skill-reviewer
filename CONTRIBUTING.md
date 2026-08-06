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
   @codex review for skill-reviewer eval regression risk. Check SKILL.md, references, the executable Eval Manifest, fixtures, and CI safety. Do not add API keys or model-backed GitHub Actions.
   ```

7. Merge through the GitHub pull request UI.

Do not push commits directly to `main`, force-push `main`, or bypass pull
request review. The `main` branch is protected in GitHub.

## Local Validation

Run these before opening a pull request:

```bash
pnpm test
pnpm typecheck
pnpm dashboard:build
node skills/skill-reviewer/scripts/lint_skill_package.mjs \
  skills/skill-reviewer --format text --fail-on error
node -e 'JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(require("node:fs").readFileSync(process.argv[1])))' \
  skills/skill-reviewer/evals/evals.json
```

## Dashboard Release Changes

The Skill Runtime and Dashboard are one versioned compatibility unit. When a
Dashboard change alters the built bundle:

1. bump the SemVer in `package.json`;
2. rebuild the Dashboard;
3. regenerate the committed digest-pinned manifest with that same version;
4. include the version, manifest, UI, and workflow changes in one pull request.

```bash
release_tag="v$(node -p 'require("./package.json").version')"
pnpm dashboard:build
node skills/skill-reviewer/scripts/dashboard_bundle.mjs package \
  --ui-dir dashboard/dist \
  --output-dir output/dashboard-release \
  --release-tag "$release_tag" \
  --manifest-output skills/skill-reviewer/assets/dashboard-ui-bundle.json
```

Do not manually upload another asset to an existing version. After merge, the
publisher creates a draft Release at the merged commit, accepts exactly one
Dashboard archive, downloads it for byte comparison, and then publishes it.
The old `dashboard-ui-assets` Release is compatibility-only.
