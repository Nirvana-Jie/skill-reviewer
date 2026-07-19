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

Machine manifests, provider contracts, Dashboard transport, and long examples
are not model references.

### Runtime interface

`skill_eval_runtime.py` is the CLI façade. Callers provide a manifest, subject,
baseline when required, execution profile, and fresh workspace. The Runtime
owns:

- manifest and authority normalization;
- immutable plans, locks, snapshots, and assignments;
- artifact and Trace validation;
- Oracle calibration and paired sampling;
- grading, acceptance, evolution state, and Dashboard projection.

Manifest normalization and immutable file identity live in
`skill_eval_authority.py`; stable contract identities live in
`skill_eval_contracts.py`; provider-neutral
locked execution, minimal child environments, credential redaction, and process
cleanup live in `skill_eval_execution.py`. Pure policies continue moving behind
the façade through `skill_eval_measurement.py` and `skill_eval_evidence.py`.
Provider adapters translate only their wire event formats. Tests target
observable CLI results rather than private helper shape.

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
| Eval schema and decisions | Runtime code and tests |
| Eval Manifest normalization | `skill_eval_authority.py` |
| Machine contract identities | `skill_eval_contracts.py` |
| Provider process safety | `skill_eval_execution.py` |
| Measurement policy | `skill_eval_measurement.py` |
| Artifact ownership | `skill_eval_evidence.py` |
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
- A UI migration must fail closed; it cannot invent positive evidence.

## Acceptance

A governance change is complete only after:

1. Vitest, typecheck, and Dashboard build pass.
2. Every Python script compiles.
3. The Skill linter and executable Eval Manifest JSON validation pass.
4. The install contract produces a self-contained Skill.
5. A prepared Dashboard projection validates.
6. Behavior claims, when requested, come from a retained real execution rather
   than static tests or screenshots.
