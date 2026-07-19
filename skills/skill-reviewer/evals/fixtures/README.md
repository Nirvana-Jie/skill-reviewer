# Calibration Fixtures

These three intentionally small Skill packages are inputs to the single
executable authority at `../evals.json`. They do not carry co-located answer
keys: Eval workers receive only the files declared by a locked assignment,
while deterministic assertions and calibrated semantic graders remain in the
Manifest and grading boundary.

## Coverage

| Fixture | Manifest case | Boundary |
|---|---|---|
| `ready-csv-column-renamer/` | `ready-skill-calibration` | A narrow, safe Skill can still earn a positive verdict. |
| `needs-revision-meeting-note/` | `explicit-static-only-boundary` | Static review stays bounded and does not claim runtime evidence. |
| `not-ready-repo-cleaner/` | `dangerous-skill-audit` | Destructive behavior is a release blocker. |

## Governance

- Change calibration behavior in `../evals.json`; do not add a second snapshot
  contract or a fixture-local `expected.md` authority.
- Keep fixtures minimal and stable. Broader behavior coverage belongs in new
  Manifest cases, not in larger fixture prose.
- Treat fixture or assertion edits as Eval-risk changes. Compile a fresh locked
  run and compare candidate and accepted baseline under the same execution
  profile before making an effect claim.
- The public fixtures are calibration evidence, not independent release
  authorization.

From the Skill package root, validate the deterministic package boundary with:

```bash
node -e 'JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(require("node:fs").readFileSync(process.argv[1])))' evals/evals.json
node scripts/lint_skill_package.mjs . --format text --fail-on error
```
