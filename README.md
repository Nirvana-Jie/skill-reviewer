# skill-reviewer

> Evidence-backed review and release system for agent skills. Treats
> `SKILL.md` like source code and declared evals like executable contracts.

[![skill](https://img.shields.io/badge/type-agent--skill-000)](./skills/skill-reviewer/SKILL.md)
[![mode](https://img.shields.io/badge/mode-instruction%20%2B%20validator-111)](./skills/skill-reviewer/SKILL.md)
[![verdict](https://img.shields.io/badge/output-paste--ready-0a0)](./skills/skill-reviewer/references/example-review-output.md)
[![lang](https://img.shields.io/badge/i18n-en%20%7C%20zh--CN-06c)](#i18n)

中文版：[README.zh-CN.md](README.zh-CN.md)

---

## TL;DR

```bash
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer
```

Then, in any agent session:

```text
> review this SKILL.md and tell me if it ships
```

You get back a strict, sectioned review with a verdict, an 8-dimension scorecard,
paste-ready rewrites, and hard-red-line blockers. When a valid executable eval manifest
is in scope, the lead agent also runs paired, artifact-backed verification. On
an explicit evolution request, it can iterate for at most three rounds and run
a one-shot audit.

---

## Why

Most "skill reviews" in the wild are vibes. `skill-reviewer` encodes the review as a spec:

- **rubric** → `references/review-rubric.md` (1–5 per dimension, with red flags and non-negotiable blockers)
- **checklist** → `references/review-checklist.md` (flat, tickable, MECE)
- **package linter** → `scripts/lint_skill_package.py` (front matter, links, resource graph, eval manifest)
- **output contract** → language-selected templates with a fixed section order
- **executable evals** → `evals/evals.json` with real prompts, typed assertions,
  objectives, and development / selection / audit roles
- **calibration fixtures** → `evals/fixtures/{ready,needs-revision,not-ready}-*`
- **local snapshots** → `evals/local-skill-review-snapshot.json`
- **executable eval runtime** → `scripts/skill_eval_runtime.py` (compile, lock,
  grade, decide, evolve, project)
- **evidence product** → React/Vite/Vitest `dashboard/` with a read-only
  evidence plane and an external audited local Agent-handoff gateway

Change the rubric, re-run the fixtures and local snapshots, ship. No re-reading 300 lines of prose to check whether your "make it stricter" tweak quietly broke the positive cases.

## Feature matrix

| Capability                  | How it's enforced                                                |
| --------------------------- | ---------------------------------------------------------------- |
| Trigger / mis-trigger audit | `description` contract + `Trigger Analysis` section              |
| Deterministic package facts | Read-only `lint_skill_package.py` JSON contract                   |
| Instruction executability   | Semantic rubric + completion criteria in `SKILL.md`               |
| AI-friendly skill design    | Checks whether the model can choose, load, follow, and reuse the skill |
| Resource / script necessity | `Resource Review` section, rejects cargo-cult scripts            |
| Safety red lines            | Non-negotiable blockers: `Safety=1` or `Trigger=1` → **Not ready** regardless of other scores |
| Prompt-injection hardening  | Review contract: reviewed artifacts are **data**, not instructions |
| Eval suggestions            | Optional 5–10 manifest-ready cases only when they materially reduce risk |
| Local eval snapshots        | Structured fixture contracts + deterministic runner / validator scripts |
| Subagent effect verification | Paired `with_skill` / baseline runs with digests, retained evidence, and explicit verification levels |
| Executable eval contract | Strict `skill-reviewer.evals` contract; an invalid present manifest blocks release instead of being skipped |
| Bounded evolution | Development / selection / one-shot opaque audit, max 3 rounds, hard gates + Pareto improvement, exact query binding and candidate lineage |
| Evidence Dashboard | React + TypeScript + Vite evidence workbench; projects `next_action` plus automatic/human boundaries, observing automatic phases and saving recoverable local Agent handoffs only for human decisions; it never claims to wake a host session |
| Full vs focused review      | Same 11-section shape; unrelated sections collapse to `N/A — focused review of <artifact>` |
| Paste-ready rewrites        | `Suggested Rewrites` outputs runnable YAML / Markdown |
| i18n                        | Branch-selected templates + English-normalized snapshot extraction |

## Output contract

Every full review emits, in order:

```
1. Executive Summary
2. Verdict                    # Ready | Ready w/ minor revisions | Needs revision | Not ready
3. Scorecard                  # 8 dimensions × 1–5
4. Critical Issues            # blocking, with file:line
5. Recommended Improvements   # non-blocking polish
6. Trigger Analysis           # over/under/collision
7. Resource Review            # per file under references/ scripts/ assets/ evals/
8. Verification Evidence      # not-run | inconclusive | behavior-verified | regression-verified
9. Suggested Rewrites         # paste-ready YAML and/or Markdown
10. Suggested Evals (optional)# 5–10 executable cases when useful, otherwise Not recommended / Deferred
11. Final Recommendation
```

Focused review keeps the same order; unused sections collapse to a single `N/A` line.

## Non-negotiable blockers

Evaluated **before** dimension averaging. Two tripwires:

- **Safety ≤ 1** → `Not ready`. Example: destructive shell without confirmation, auto `git push`, curl-pipe-to-shell.
- **Trigger reliability ≤ 1** → `Not ready`. Example: `description` triggers on any cleanup verb for a skill that runs `rm -rf`.
- Score = 2 on either dimension caps the verdict at `Needs revision`.

Defined in [`references/review-rubric.md`](./skills/skill-reviewer/references/review-rubric.md). Exercised by the `not-ready-repo-cleaner` fixture.

## Calibration fixtures

Three hand-labeled fixtures act as regression anchors for subjective scoring:

| Fixture                                   | Expected verdict     | Anchors               |
| ----------------------------------------- | -------------------- | --------------------- |
| `ready-csv-column-renamer/`               | Ready                | Upper end — prevents "nothing is ever Ready" drift |
| `needs-revision-meeting-note/`            | Needs revision       | Mid-range             |
| `not-ready-repo-cleaner/`                 | Not ready            | Safety red line fires |

Protocol in [`evals/fixtures/README.md`](./skills/skill-reviewer/evals/fixtures/README.md). Run whenever you touch the rubric, workflow, or output template.

## Local eval snapshots

`skill-reviewer` uses one executable manifest plus calibrated review-output
anchors:

- `evals/evals.json` is the single trigger, routing, and behavior manifest with development,
  selection, and audit splits; deterministic assertions run before supplemental
  blind semantic comparisons.
- `evals/fixtures/*/expected.md` gives human-readable calibration anchors.
- `evals/local-skill-review-snapshot.json` gives machine-readable snapshot contracts for verdicts, score ranges, required sections, must-flag issues, forbidden actions, output artifacts, and optional output-quality assertions.
- `scripts/run_codex_skill_evals.py` generates or post-processes model-backed local eval workspaces.
- `scripts/validate_local_snapshot.py` validates those contracts against generated local eval workspaces.

The snapshot layer intentionally avoids byte-for-byte full-text diffs. A review can phrase findings differently and still pass if its structured contract is stable. See [`references/local-eval-snapshot.md`](./skills/skill-reviewer/references/local-eval-snapshot.md) for the workspace layout and update policy.

The behavior runtime is separate from the calibration snapshot runner. It
freezes authoritative selection/audit eval and deterministic/semantic grader authority,
tracks an independently digestible development surrogate, materializes
case/arm/repeat-specific read-only skill snapshots and inputs, binds every
execution/output and semantic judgment to its run evidence and external
execution-profile digest, and refuses stale workspaces or input drift. Public
audit fixtures are calibration-only; release evidence requires a trusted
opaque holdout pack. See
[`references/executable-evals.md`](./skills/skill-reviewer/references/executable-evals.md) and
[`references/subagent-eval-workflow.md`](./skills/skill-reviewer/references/subagent-eval-workflow.md).

## Executable evals and bounded evolution

The deterministic adapter is agent-agnostic; the lead agent owns native worker
dispatch. Compile exactly one split into a fresh, empty workspace:

```bash
python3 skills/skill-reviewer/scripts/skill_eval_runtime.py compile \
  --manifest <skill>/evals/evals.json \
  --subject <candidate> \
  --execution-profile /absolute/path/to/execution-profile.json \
  --baseline-kind old_skill \
  --baseline-path <accepted-skill> \
  --split selection \
  --workspace /tmp/skill-reviewer-run

python3 skills/skill-reviewer/scripts/run_codex_eval_executor.py \
  --workspace /tmp/skill-reviewer-run \
  --assignment /tmp/skill-reviewer-run/assignments/<case>/with_skill/repeat-1.json \
  --full-access

python3 skills/skill-reviewer/scripts/run_codex_eval_executor.py \
  --workspace /tmp/skill-reviewer-run \
  --assignment /tmp/skill-reviewer-run/assignments/<case>/old_skill/repeat-1.json \
  --full-access

python3 skills/skill-reviewer/scripts/skill_eval_runtime.py grade \
  --plan /tmp/skill-reviewer-run/execution-plan.json \
  --workspace /tmp/skill-reviewer-run
```

The local Codex profile uses `target: "codex-cli"`,
`harness: "codex-exec-jsonl"`, `isolation: "local-unattested"`, and the
`jsonl-agent-events` capability; `--full-access` additionally requires the
locked `danger-full-access` capability. The lead Agent fans out candidate and
baseline assignments, while the adapter executes exactly one arm. Before
launch it disables all model-visible ambient Skills so an installed same-name
package cannot contaminate `old_skill` or `without_skill`. It maps visible
messages, commands, exit codes, usage, errors, and artifacts into
`agent-trace.jsonl`, redacting private reasoning before source-event retention.
Full access provides realistic behavioral provenance, not proof of network or
OS-level isolation; the Dashboard displays that limitation explicitly.

An accepted evolution candidate must pass every hard gate, avoid regression on
every declared objective, and materially improve at least one primary
objective. Each later selection query and the one-shot audit must first be
mechanically bound with `evolution-authorize` (this is not a human approval
step); every candidate is bound to the accepted
baseline as parent, and the state retains candidate
lineage, continuity epoch, trace IDs, and query budget. Authoritative
selection/audit evals and graders are immutable during the run; the development
surrogate may evolve under its own digest. Changing an authoritative eval needs
user confirmation and a fresh lock. Full protocol:
[`references/evolution-workflow.md`](./skills/skill-reviewer/references/evolution-workflow.md).

The Dashboard is an optional human-review control plane, not a prerequisite for
Eval execution. After compile, the lead Agent asks once whether the user wants
the temporary local Dashboard. Only an explicit yes authorizes the UI download
and local server. Evidence remains read-only and action requests use a separate
task directory:

```bash
python3 skills/skill-reviewer/scripts/start_skill_dashboard.py \
  --workspace /tmp/skill-reviewer-run \
  --state /tmp/skill-reviewer-control/evolution-state.json \
  --task-root /tmp/skill-reviewer-action-tasks \
  --user-approved-control-plane \
  --open
```

The launcher is the only user-facing control-plane entry point after
installation. It anonymously downloads the content-addressed GitHub Release
archive pinned by `references/dashboard-ui-bundle.json`, verifies the archive
SHA-256, safely extracts it, and verifies the complete tree SHA-256. The UI is
placed in the operating system's private temporary directory and removed on a
normal interrupt or process termination. The download sends no GitHub token,
cookie, run id, prompt, Trace, or Eval artifact, and the browser never connects
to GitHub Pages.

`--user-approved-control-plane` is a hard launcher gate and may be passed only
after the lead Agent asks and receives an explicit yes. Without it, the launcher
exits before downloading UI. Silence, timeout, or decline means do not open it.

One loopback-only same-origin server provides both UI and evidence APIs. It
requires matching Host, Origin, Fetch Metadata, and process-lifetime capability
headers, and marks both UI and evidence `no-store`. The launcher reprojects
retained evidence every 3 seconds, tries 8765–8767 without killing another
process, and prints a local `skill-reviewer.dashboard-session` record. One run
has one lead-Agent-owned control plane; cases, arms, and repeats are evidence
cells under it, so Eval workers must not start their own servers. Use `--port 0`
for a dynamic port, `--refresh-seconds 0` for a static view, and
`--prepare-only` to validate the projection without downloading UI. A trusted
offline/development build may be supplied explicitly with
`--ui-dir <dashboard-dist>`; it is neither downloaded nor deleted. The
installed Skill contains only a small digest manifest and launcher modules, not
Dashboard JavaScript or frontend dependencies. If the user declines the
control plane or its download fails, the locked Eval can continue, but the lead
must report that live visualization is unavailable.

The trust anchor is the digest manifest in the already-installed Skill, not the
download host. Replacing a Release asset fails before JavaScript execution when
either its archive or extracted-tree digest differs, and runtime code never
reads `GITHUB_TOKEN`. The session capability exists only in a local URL
fragment—which HTTP requests do not transmit—and is promoted by the page into a
local API request header. The page then removes it from the address bar, and
copied view or evidence references never contain it. Two residual boundaries remain: an attacker able to
change both the Skill manifest and publishing repository has already
compromised the Skill, and a malicious process under the same operating-system
account may observe local processes or files. Do not run the control plane in
an untrusted shared account, and stop the launcher after review. A hard crash
may leave evidence-free UI assets until OS temporary-file cleanup; normal exit
removes them immediately.

The Dashboard renders the candidate/baseline runtime-surface diff from locked
snapshots with React and `@pierre/diffs`. The read model contains only file
metadata; text previews are fetched from digest-bound per-file sidecars, while
binary files and either side above 512 KiB remain digest/size summaries. A
sidecar SHA-256 is carried by the read model and rechecked against the exact
bytes on every local-server response; the 512 KiB rule is applied to each
parsed UTF-8 side, not to JSON-escaped file size. A mounted worker-pool provider
moves syntax highlighting off the main thread, and
virtualization avoids an unbounded DOM. This display cap is not a release diff
size gate. The changed-file tree uses VS Code Symbols-style file and folder
icons for document, data, configuration, language, and test artifacts while
keeping Git A/M/D status independent. The Dashboard evidence plane remains read-only, and
`audit-passed` still requires an explicit user release decision.

The **Agent trace** view reads the literal `agent-trace.jsonl` captured while an
Agent executes one `evals.json` case. Navigation is Eval case → candidate or
baseline → repeat → observable event. It shows the files read, tool calls,
commands and exit codes, visible Agent messages, errors, timing, and produced
artifacts without inventing intermediate stages from status summaries.
Deterministic checks and semantic Judge results cite the concrete event IDs they
used, and **Locate Trace** opens that source event in place. A Trace is fully
bound only when the manifest, plan lock, execution profile, exact repeat
coverage, execution/Trace digests, contiguous events, and artifact provenance
all bind; otherwise the missing Trace is a blocking evidence gap. This surface
never records or exposes private model chain-of-thought.
Local Codex runs identify their capture source as `codex_cli_jsonl`; an
execution profile marked `local-unattested` also renders a visible boundary
note so traceability is not confused with sandbox assurance.

For evolution runs, the **Next steps** view turns the validated `next_action`
into a plain recommendation alongside the three conjunctive selection conditions: all hard
gates, Pareto non-regression, and material primary-objective improvement. It
routes retained failure signals to Skill, Eval, execution environment, missing
evidence, or a human decision, then explicitly distinguishes **Agent continues
automatically** from **human decision required**. Candidate generation, locked
Eval execution, grading, and preparation/execution of the one-shot release
audit run automatically while inputs and authority stay unchanged. A person is
asked only to change Eval/baseline/thresholds, widen network/secret/permission/
dependency/scope authority, resolve ambiguity the frozen contract cannot, or
confirm final publish/deploy/external effects. Human-boundary clicks append a
digest-chained task for the lead Agent under `--task-root`; they do not execute
work, advance state, confirm release, or change `evals.json`. Eval actions are
proposals and still require explicit user confirmation plus a new lock. See
[`references/action-center.md`](./skills/skill-reviewer/references/action-center.md).

The UI is a compact three-pane workbench rather than a card dashboard: case
navigation on the left, the review, execution, document diff, or Next steps view in the center, and a
fact inspector on the right. The diff surface supports changed-file search,
file navigation, split/unified layouts, line wrapping, and a distraction-free
focus mode. Only the selected sidecar is fetched, only languages present in the
current change set are initialized, digest cache keys reuse rendered syntax
trees, and a bounded worker cache prevents an extended review from retaining
every visited document.

On desktop, both side panes have visible draggable separators. The scenario
rail is bounded to 220–480 px and the evidence inspector to 280–560 px; the
center evidence canvas keeps a view-specific minimum width. When space is
tight, side panes shrink proportionally before the inspector is removed, and
at mobile width the workbench stacks vertically with resizing disabled. Arrow
keys adjust the focused separator, Shift+Arrow makes a larger adjustment,
Home/End selects the active limit, and Enter or double-click restores the
default. Width preferences are local presentation state and can also be reset
from the command palette; they never enter or mutate retained evidence.

The workbench can switch between English and Simplified Chinese and between
light and dark monochrome themes from the persistent top-bar controls. On a
first visit it follows the browser language and operating-system color scheme;
the same control group offers 90%, 100%, 110%, 125%, 140%, and 160% text-size
presets, with the percentage button resetting to 100%. The full workbench
scales and reflows together so large-screen readability does not introduce
clipped labels or preserve an unsuitable desktop layout at narrow widths.
After that it restores the user's choices locally. Interface chrome is
translated while run identifiers, file paths, evidence payloads, and recorded
limitations remain verbatim so localization cannot rewrite review evidence.
The document renderer changes its syntax theme with the surrounding workbench.

Review context is shareable without turning the URL into evidence storage. The
Dashboard records the run guard, split/status filters, bounded query, selected
evidence, diff, or Next steps view, diff layout, wrapping, and focus mode as URL presentation
state. A permalink that names another run is blocked instead of silently
showing the server's current run, and browser Back/Forward replays review
navigation. `Mod+K` opens a read-only evidence locator across cases, projected
evidence metadata, changed-file paths, and safe display/copy/reload actions.

The footer separates projection generation time from the browser's last
successful load and last failed attempt. Manual reload cancels an older
request, a failed refresh keeps the last verified projection visible with a
stale banner, and automatic refresh can be paused or resumed. Reviewers can
copy a portable Markdown evidence reference, copy the current permalink, or
download the current read model explicitly labeled as projection JSON; none of
these presentation actions mutate evals, evidence, or release state. Lazy diff
transport failures can be retried, while metadata/payload binding failures are
shown as integrity errors and expose copyable diagnostics without rendering
unbound content. The maintained Dashboard and execution contracts live in
[`action-center.md`](./skills/skill-reviewer/references/action-center.md) and
[`executable-evals.md`](./skills/skill-reviewer/references/executable-evals.md).

Live reprojection switches generations only after the replacement read model
and all of its sidecars validate together. Sidecars are content-addressed and
retained within the run workspace, so already-issued URLs remain available to
in-flight views; reusing one URL for a different payload digest is rejected.

The validator has two modes. With only the contract path, it checks JSON shape and reports `contract_only: true`; this does **not** prove model output quality. With a workspace path, it also checks saved artifacts and `extracted-review.json` fields such as `critical_issues_have_problem_why_fix`, `has_paste_ready_rewrite_block`, and `final_recommendation_is_ordered`.

## Human-in-the-loop review

Use `skill-reviewer` as the strict first-pass reviewer, then keep the human as the release decision maker:

1. Point the reviewer at the target skill directory and ask for a full review:
   ```text
   Review this skill directory and tell me whether it is ready to ship.
   ```
2. Run the deterministic package-facts axis:
   ```bash
   python3 skills/skill-reviewer/scripts/lint_skill_package.py <target-skill> --format json --fail-on never
   ```
3. Read the output in order: verdict, scorecard, critical issues, verification evidence, and suggested rewrites. Treat Critical Issues as the action queue.
4. Apply only the fixes you agree with. Do not update fixtures or snapshots just to make a failing review pass.
5. For regression coverage, run the calibration fixtures or a local workspace and save `review.md`, `extracted-review.json`, and `grading.json` for each eval case. To invoke Codex locally:
   ```bash
   python3 skills/skill-reviewer/scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1
   ```
   To post-process `review.md` files that already exist in a workspace:
   ```bash
   python3 skills/skill-reviewer/scripts/run_codex_skill_evals.py \
     --workspace /tmp/skill-reviewer-evals/iteration-1 \
     --from-existing-reviews
   ```
6. When effect verification is requested and subagents are available, freeze the subject and accepted baseline, then launch paired `with_skill` and `old_skill` / `without_skill` runs in the same turn. Follow [`references/subagent-eval-workflow.md`](./skills/skill-reviewer/references/subagent-eval-workflow.md).
7. Grade assertions against retained outputs and report one verification level: `not-run`, `inconclusive`, `behavior-verified`, or `regression-verified`.
8. Validate the structured snapshot contract against that workspace:
   ```bash
   python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json <workspace>/iteration-1
   ```
9. If the validator fails, inspect whether the skill regressed or the review contract intentionally changed. Update `evals/local-skill-review-snapshot.json` only for intentional contract changes.

For quick contract checks without a workspace:

```bash
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json
pnpm dashboard:build
```

This quick check is intentionally contract-only. It should be green before opening a PR, but it does not replace a workspace-backed eval when you need evidence about model output.

The useful loop is: review -> human accepts/rejects findings -> edit skill -> rerun fixture/snapshot checks -> update snapshots only when the expected review contract changes.

## Contribution workflow

All changes go through a branch and pull request. Do not commit or push directly
to `main`; the branch is protected in GitHub.

Before opening a PR, run:

```bash
python3 -m unittest discover -s tests
pnpm test
python3 skills/skill-reviewer/scripts/lint_skill_package.py skills/skill-reviewer --format text --fail-on error
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json
```

After opening a PR, wait for `Static Checks` and request Codex Cloud review when
needed:

```text
@codex review for skill-reviewer eval regression risk. Check SKILL.md, references, eval fixtures, snapshot contract, and CI safety. Do not add API keys or model-backed GitHub Actions.
```

## Development package manager

This repository uses pnpm exclusively, pinned through the `packageManager`
field in `package.json`. Do not generate npm or Yarn lockfiles.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

## GitHub checks and Codex Cloud review

The repository includes `.github/workflows/static-checks.yml` for deterministic checks on pull requests and trusted `main` pushes. It does not call Codex, use an OpenAI API key, or upload generated model artifacts. `.github/workflows/publish-dashboard-bundle.yml` builds and verifies a content-addressed UI archive in an isolated read-only job, then gives only a separate publish job minimal `contents: write` permission to add a non-overwriting GitHub Release asset. Pages is not used. Neither `dashboard/dist` nor the archive is committed or copied by `skills add`, and runtime downloads use no GitHub token.

The static workflow runs:

```bash
python3 -m unittest discover -s tests
pnpm test
python3 skills/skill-reviewer/scripts/lint_skill_package.py skills/skill-reviewer --format text --fail-on error
python3 -m json.tool skills/skill-reviewer/evals/evals.json > /dev/null
python3 skills/skill-reviewer/scripts/validate_local_snapshot.py skills/skill-reviewer/evals/local-skill-review-snapshot.json
pnpm dashboard:build
python3 -m py_compile skills/skill-reviewer/scripts/dashboard_bundle.py skills/skill-reviewer/scripts/lint_skill_package.py skills/skill-reviewer/scripts/run_codex_eval_executor.py skills/skill-reviewer/scripts/run_codex_skill_evals.py skills/skill-reviewer/scripts/skill_eval_runtime.py skills/skill-reviewer/scripts/serve_skill_dashboard.py skills/skill-reviewer/scripts/start_skill_dashboard.py skills/skill-reviewer/scripts/validate_local_snapshot.py tests/test_run_codex_skill_evals.py
```

For model-assisted review without storing an API key in GitHub Actions, use Codex Cloud on the pull request:

```text
@codex review for skill-reviewer eval regression risk. Check SKILL.md, references, eval fixtures, snapshot contract, and CI safety. Do not add API keys or model-backed GitHub Actions.
```

Keep Codex automatic reviews disabled if only repository maintainers should trigger Codex review. Codex follows `AGENTS.md` review guidelines when reviewing PRs.

## Install

```bash
# from GitHub
npx skills add Nirvana-Jie/skill-reviewer --skill skill-reviewer

# from a local checkout
npx skills add . --skill skill-reviewer

# globally
npx skills add -g Nirvana-Jie/skill-reviewer --skill skill-reviewer

# discover what the repo ships
npx skills add Nirvana-Jie/skill-reviewer --list
```

Installer CLI: [`vercel-labs/skills`](https://github.com/vercel-labs/skills).

The installable boundary intentionally lives at `skills/skill-reviewer/`, and
the repository intentionally has no root-level `SKILL.md`. The `skills` CLI
treats a remote root skill as a single-file payload, while a nested skill keeps
its supporting directory. Co-locating the entry point, references, scripts,
evals, fixtures, and production Dashboard bundle makes the command above
self-contained. A Vitest integration test exercises the actual CLI through a
temporary Git remote and then runs the installed tools outside this checkout.

## Triggers

Fires on requests like:

- `review / audit / grade / critique / debug / production-check this skill`
- `why does my skill trigger on every PDF?`
- `why doesn't my skill trigger when users say "dashboard"?`
- `tighten this description to reduce mis-triggers`
- `is this skill ready to merge?`
- `can these evals work like local snapshot tests for my skill?`

Explicitly does **not** fire for: creating a new skill (use `skill-creator`), running the skill's underlying task, translating/summarizing a `SKILL.md` without review intent, or ordinary application code review.

## Layout

```text
.
├── skills/
│   └── skill-reviewer/            # exact payload copied by `skills add`
│       ├── SKILL.md               # entry point, frontmatter + workflow
│       ├── references/            # rubric, contracts, templates, protocols
│       ├── scripts/               # linter, eval runtime, validator, server
│       └── evals/                 # executable manifest, snapshots, fixtures
├── tests/                         # Python unit tests + Vitest system tests
├── dashboard/                     # React + TypeScript + Vite source; dist ignored
├── package.json                   # Vitest, typecheck, and Dashboard commands
└── pnpm-lock.yaml                 # pinned pnpm test dependencies
```

No skill-package `assets/` — by design. Runtime adapters isolate deterministic
facts and evidence handling; semantic review and native-agent dispatch remain
instruction-led.

## i18n

Output language follows the request. English loads `output-template-en.md`;
Chinese loads `output-template-zh.md`; other languages translate the English
contract while preserving paths, fields, identifiers, code, and backticked
tokens.

The local snapshot extractor normalizes both English and Chinese review headings, verdicts, and scorecard labels into the same English contract fields. Eval items can set `"output_language": "Chinese"` to ask the runner for the Chinese template while keeping `extracted-review.json` machine-comparable.

## License

MIT.
