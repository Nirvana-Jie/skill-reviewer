# Skill Reviewer Architecture

This document is for maintainers. It is deliberately outside the installable
Skill's `references/` directory so implementation detail does not enter the
Agent's decision context.

## Goal

The system answers three independent questions:

1. Is the Skill package well designed?
2. Does retained execution evidence support a behavior claim?
3. Can a reviewer understand the decision and next step quickly?

Those questions map to three interfaces. Do not merge them back into one prose
contract.

## Interfaces

### Skill interface

`skills/skill-reviewer/SKILL.md` orchestrates Review, Verify, and Evolve. Its
four references contain only information an Agent needs while taking that
branch:

- review rubric;
- output contract;
- verification workflow;
- bounded evolution workflow.

Machine manifests, source-Agent contracts, Dashboard transport, and long examples
are not model references.

### Runtime interface

The Runtime has two intentionally separate entry points:

- `skill_eval_runtime.mjs` is the authority façade for compile, lock, grade,
  decide, evolve, and project operations;
- `run_agent_eval.mjs` is the only local process-execution CLI. It exposes the
  source-neutral `runAgentCell` and `runAgentPlan` interfaces.

Callers provide a manifest, subject, baseline when required, execution profile,
and fresh workspace. Native ESM domain modules own the frozen decision
contracts:

- `lib/skill-eval-authority.mjs`: normalization, compilation, snapshots, and complete
  Manifest-derived lock reconstruction;
- `lib/skill-eval-grading.mjs`: dispatch/Trace validation, finalization, typed
  assertions, paired measurement, and grading;
- `lib/skill-eval-decision.mjs`: acceptance gates and bounded evolution state;
- `lib/skill-eval-dashboard.mjs`: read-only Dashboard projection.

Stable contract identities live in `lib/skill-eval-contracts.mjs`. The execution
slice has four boundaries:

1. `assets/agent-adapter-registry.json` is a closed, first-party registry. It
   separately records source-Agent identity, wire stability, evidence authority,
   implementation maturity, and the profile fields that compilation locks.
2. `agent-artifacts.mjs`, `agent-digest.mjs`, and
   `agent-runtime-binding.mjs` own durable writes, canonical identity, and the
   immutable per-run executable/operational binding.
3. `agent-process.mjs` owns minimal child environments, credential redaction,
   timeout/signal handling, executable provenance, and process-group cleanup;
   `agent-source-capture.mjs` owns strict JSONL decoding and observable-event
   retention; `agent-execution.mjs` coordinates cells and paired fan-out.
4. `scripts/lib/agent-adapters/` contains source-specific argv and event mapping.
   Product names belong only in this boundary, the registry, fixtures, and
   research—not in the public runner, execution core, or Dashboard schema.

Adapters are resolved by exact ID from the bundled registry. Arbitrary dynamic
imports, protocol guessing, and fallback to a lookalike Agent are forbidden.
Each executable adapter carries an exact, canary-qualified CLI version token;
version mismatch fails before dispatch. The first cell atomically establishes
`agent-runtime-binding.json` (executable path/digest/version, environment-name
digest, timeout, and cost limit), and every later cell in that run must match it.
Hooks remain source-specific supplemental channels and are never merged with a
CLI stream unless the source exposes an exact correlation key. Researched Hook
formats remain explicitly `not-implemented` until they have parsers and fixtures.

The complete Runtime uses one Node.js/ESM toolchain. Public CLIs stay thin;
domain modules expose direct in-process seams so the generic Agent runner does
not launch a second language runtime. Golden contract and end-to-end tests
protect immutable plan, lock, grading, snapshot, and Dashboard behavior.

The MJS authority is an explicit digest boundary, not a byte-compatible reader
for workspaces frozen by the removed runtime. New plans record
`canonical_json_contract` and `portable_regex_contract`; an older plan must be
recompiled into a fresh workspace instead of being silently reinterpreted.

Domain modules may depend only on another module's public interface. Private
helpers remain local to their owner; the local `skill_eval_*` import graph must
remain acyclic. A Vitest architecture guard enforces both constraints.

### Dashboard interface

The Dashboard consumes only validated `dashboard-data.json` and digest-bound
sidecars. It is a decision surface, not another acceptance engine.

Its primary view presents one ordered validity chain:

1. evidence integrity;
2. measurement validity;
3. candidate quality.

Diff, Trace, and the audit spine explain that decision. Any local handoff record
is outside evidence authority and must be revalidated by a receiving Agent.

## Authority map

| Meaning | Authority |
|---|---|
| Mode selection and verification-level semantics | `SKILL.md` |
| Review scores and verdict rules | `references/review-rubric.md` |
| Response shape | `references/output-contract.md` |
| Eval Manifest, compilation, and lock reconstruction | `lib/skill-eval-authority.mjs` |
| Evidence validation and grading | `lib/skill-eval-grading.mjs` |
| Acceptance and bounded evolution | `lib/skill-eval-decision.mjs` |
| Dashboard read-model projection | `lib/skill-eval-dashboard.mjs` |
| Machine contract identities | `lib/skill-eval-contracts.mjs` |
| Canonical JSON and content digests | `lib/agent-digest.mjs` |
| Agent registry and locked adapter profile | `assets/agent-adapter-registry.json` |
| Generic local execution and paired fan-out | `run_agent_eval.mjs`, `lib/agent-execution.mjs` |
| Child process safety and provenance | `lib/agent-process.mjs` |
| Strict source-stream capture | `lib/agent-source-capture.mjs` |
| Atomic artifacts and immutable runtime binding | `lib/agent-artifacts.mjs`, `lib/agent-runtime-binding.mjs` |
| Per-run executable and operational identity | generated `agent-runtime-binding.json` |
| Source event mapping | `lib/agent-adapters/<source>.mjs` |
| Measurement policy | `lib/skill-eval-measurement.mjs` |
| Artifact ownership | `lib/skill-eval-evidence.mjs` |
| Semantic grader machine contract | `assets/semantic-grader-contract.md` |
| Dashboard bundle identity | `assets/dashboard-ui-bundle.json` |
| Dashboard presentation validation | `dashboard-schema.ts` and tests |

If the same meaning appears in two prose files, one copy must be removed or
replaced by a pointer to its authority.

## Change rules

- Add a model reference only when one branch needs reusable information that
  cannot be hidden behind a stable Runtime interface.
- Keep the recursively enumerated model-reference set on an exact allowlist.
  `SKILL.md` stays at or below 240 lines / 16 KiB; each reference stays at or
  below 180 lines / 12 KiB; all references together stay at or below 32 KiB.
  These are guardrails, not substitutes for the no-op test.
- Do not add reference-to-reference chains deeper than the single Verify →
  Evolve sequence.
- Put machine-consumed files in `assets/`.
- Put maintainer explanations in `docs/`.
- Put examples used for calibration in `evals/fixtures/`.
- Preserve the evidence → measurement → candidate order across Runtime and UI.
- Keep cross-domain imports public and the `skill_eval_*` dependency graph
  acyclic.
- Keep the top-level execution CLI and core free of named Agent products. Add a
  registry entry before an adapter; do not add another top-level runner.
- Distinguish `researched`, `implemented`, fixture-verified, and canary-verified
  support. Documentation must not collapse these states into “supported”.
- Re-run the real canary and update the exact version policy before retaining
  `canary-verified` after an Agent CLI upgrade.
- Change an authority domain only behind golden contract tests; keep one writer
  per artifact and update the façade and direct-import seam in the same change.
- A UI migration must fail closed; it cannot invent positive evidence.

## Acceptance

A governance change is complete only after:

1. Vitest, typecheck, and Dashboard build pass.
2. Every MJS runtime file passes `node --check`.
3. The Skill linter and executable Eval Manifest JSON validation pass.
4. The install contract produces a self-contained Skill.
5. A prepared Dashboard projection validates.
6. Behavior claims, when requested, come from a retained real execution rather
   than static tests or screenshots.
