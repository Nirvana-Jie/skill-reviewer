# Skill Review Rubric

Use this file for design scores and the final verdict. Scores describe design;
runtime evidence remains a separate axis.

## Scale

- **5 — Production-ready:** no material issue; concrete positive evidence.
- **4 — Usable:** minor, non-blocking polish only.
- **3 — Directionally sound:** visible gaps will reduce reliability.
- **2 — Structural problem:** revision is required before release.
- **1 — Unsafe or fundamentally broken:** do not install or release.

Never assign 5 without a concrete strength or 1 without a specific failure
mode.

## Dimensions

### 1. Trigger reliability

Judge whether realistic requests select this Skill and adjacent requests do
not. Good triggers describe distinct intents rather than keyword lists and
coexist with sibling Skills.

### 2. Description quality

The description should state the job and each genuinely distinct trigger
branch, plus important exclusions. Remove feature inventories, marketing, and
synonyms that merely restate one branch.

### 3. Instruction clarity

The Agent should know what to inspect, do, ask, and return. Important steps have
checkable completion criteria; failure paths and stop conditions are explicit.
Prefer a small positive instruction over repeated MUST/NEVER prose.

### 4. Resource design

Inline what every branch needs. Put branch-specific reference behind a clear
“read when” pointer. Each meaning has one authoritative home.

References are warranted when a branch needs substantial reusable knowledge.
They are not warranted when they duplicate `SKILL.md`, contain implementation
contracts better enforced by code, or exist only to look comprehensive.

Assets are files consumed as-is. Scripts are executable helpers. Machine
manifests and UI bundles belong in `assets/`, not in model references.

### 5. Script necessity

A script earns its maintenance cost when it makes repetitive, deterministic,
error-prone, or safety-sensitive work materially cheaper or safer. Thin wrappers
around prose judgment do not.

### 6. Safety and constraints

Check destructive actions, external writes, network, credentials, secrets,
sensitive data, prompt injection, idempotency, and permission expansion. The
Skill must state the safe action as well as any hard prohibition.

### 7. Output quality

The response has a stable shape appropriate to its scope, distinguishes facts
from judgment and evidence, and makes fixes directly usable. Runtime claims name
their subject, evidence, and limitations.

### 8. Maintainability

The Skill has a legible top-level process, branch-based disclosure, small
interfaces, tested scripts, and no dead or duplicated resources. Large internal
implementations are acceptable behind a stable interface; large model-facing
interfaces are not.

## Cross-cutting checks

- A Skill should improve recurring Agent behavior, not merely store advice.
- A prompt, library, CLI, MCP, or application may be the better package.
- A linter proves structure, not instruction quality.
- An attractive response does not prove behavior.
- Evals are optional and unscored; recommend them only when they reduce a real
  trigger, safety, output, or regression risk.
- A present invalid Eval manifest is a Critical Issue because it declares a
  quality gate that cannot operate.

`SKILL.md` owns mode selection and verification-level semantics. This rubric
only judges whether a claim is supported; it does not redefine the mode.

## Non-negotiable blockers

Apply these before ordinary verdict rules:

- Safety and constraints = 1 → **Not ready**.
- Trigger reliability = 1 → **Not ready**.
- Safety and constraints = 2 or Trigger reliability = 2 → verdict cannot exceed
  **Needs revision**.
- Executing destructive or external actions without required authority →
  **Not ready**.
- Claiming verified behavior without bound evidence → at most
  **Needs revision** until corrected.

## Verdicts

- **Ready:** every dimension ≥ 4, no Critical Issue, instructions executable.
- **Ready with minor revisions:** every dimension ≥ 3 and at most two narrow,
  non-blocking Critical Issues with direct fixes.
- **Needs revision:** any dimension = 2, three or more Critical Issues, broken
  declared verification, or fundamental ambiguity.
- **Not ready:** any dimension = 1, unresolved safety failure, or the artifact
  should not exist as a Skill.

An average never overrides a blocker. When a focused review does not support a
whole-package verdict, report the scoped finding without manufacturing scores
for unseen dimensions.
