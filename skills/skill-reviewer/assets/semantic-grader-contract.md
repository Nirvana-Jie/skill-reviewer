# Semantic Grader Contract

This machine authority applies to every `semantic_pair` assertion. Its digest is
bound into the execution plan; workers receive it through sanitized assignments,
not through model-facing Skill references.

- Deterministic grading runs first and remains authoritative for hard gates.
- Compare only declared inputs under the frozen task rubric.
- Present anonymous A/B bundles twice with order swapped.
- Each judgment returns only `A`, `B`, or `tie`.
- Matching resolved winners produce a preference; matching ties produce a tie;
  every other result is disagreement.
- The worker never receives arm mappings, candidate history, optimizer rationale,
  package source, or prior decisions.
- The lead owns the official mapped judgment and binds it to run, case,
  assertion, authority digest, contract digest, rubric digest, declared paths,
  paired repeats, artifact digests, and producing Trace event IDs.
- Missing, stale, malformed, unbound, non-blind, or non-swapped evidence cannot
  support a semantic preference.
