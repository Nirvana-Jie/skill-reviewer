# Semantic Grader Contract

This contract is normative for every `semantic_pair` assertion. Its digest is
part of the immutable evaluation authority recorded in `execution-plan.json`.

## Role and precedence

- Semantic grading is supplemental. It never replaces a deterministic hard
  gate or repairs a failed deterministic assertion.
- A deterministic grader runs first. A semantic grader compares only the
  declared `inputs` under the assertion's task-specific `rubric`.
- The semantic grader must not reward verbosity, formatting polish, or stylistic
  similarity unless the rubric explicitly makes that behavior part of the
  contract.

## Blind comparison

- The grader receives two anonymized bundles labelled `A` and `B`, the frozen
  rubric, and this contract. It must not receive arm mappings, candidate age,
  optimizer rationale, prior decisions, or package source.
- Run exactly two judgments. The second judgment swaps the A/B presentation
  order used by the first.
- Each judgment returns only `A`, `B`, or `tie`. Use `tie` when the declared
  rubric does not support a meaningful distinction.
- Resolve the anonymous winners through the hidden mappings only after both
  judgments finish. Matching resolved winners produce a preference; matching
  ties produce a tie; any other outcome is disagreement and therefore
  inconclusive. Do not add a third deciding vote.

## Artifact ownership and binding

- A blind semantic-grader worker may retain raw anonymous judgments, but it must
  not write the official mapped judgment artifact.
- The lead agent owns the official `skill-reviewer.semantic-judgment`
  artifact. It adds the two hidden A/B mappings and the exact `binding` computed
  from the execution plan.
- The binding covers run id, case id, assertion id, evaluation-authority digest,
  this contract's digest, rubric digest, declared input paths, every paired
  repeat, every input artifact digest, and the exact `artifact_written` Agent
  Trace event IDs that produced those inputs. This lets a reviewer jump from a
  Judge input to the observable execution that created it.
- A missing, stale, malformed, unbound, non-blind, or non-swapped judgment is
  inconclusive. It must never be silently reused or treated as a pass.
