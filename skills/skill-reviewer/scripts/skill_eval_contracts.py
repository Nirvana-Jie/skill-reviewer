#!/usr/bin/env python3
"""Stable contract identities shared by Skill Eval runtime adapters.

This module deliberately contains no filesystem or provider behavior.  It is
the dependency root for machine-contract names and the single public contract
error type, so adapters do not need to import the 8k-line Runtime façade merely
to agree on identity and failure semantics.
"""

MANIFEST_CONTRACT = "skill-reviewer.evals"
PLAN_CONTRACT = "skill-reviewer.execution-plan"
RUN_LOCK_CONTRACT = "skill-reviewer.run-lock"
VERIFICATION_CONTRACT = "skill-reviewer.verification"
ACCEPTANCE_CONTRACT = "skill-reviewer.acceptance-decision"
ASSIGNMENT_CONTRACT = "skill-reviewer.executor-assignment"
EXECUTION_CONTRACT = "skill-reviewer.executor-execution"
DISPATCH_RECEIPT_CONTRACT = "skill-reviewer.dispatch-receipt"
TRACE_EVENT_CONTRACT = "skill-reviewer.agent-trace-event"
SEMANTIC_JUDGMENT_CONTRACT = "skill-reviewer.semantic-judgment"
DASHBOARD_CONTRACT = "skill-reviewer.dashboard-data"
DASHBOARD_DIFF_CONTRACT = "skill-reviewer.dashboard-diff"
DASHBOARD_SESSION_CONTRACT = "skill-reviewer.dashboard-session"
DASHBOARD_LAUNCH_SESSION_CONTRACT = "skill-reviewer.dashboard-launch-session"
DASHBOARD_AGENT_HANDOFF_CONTRACT = "skill-reviewer.dashboard-agent-handoff"
EVOLUTION_STATE_CONTRACT = "skill-reviewer.evolution-state"
EVOLUTION_TRANSITION_CONTRACT = "skill-reviewer.evolution-transition"

DETERMINISTIC_ASSERTION_TYPES = frozenset(
    {
        "file_exists",
        "text_contains",
        "text_not_contains",
        "text_matches",
        "text_not_matches",
        "json_path",
        "event_absent",
        "digest_equals",
        "numeric_range",
    }
)
SEMANTIC_ASSERTION_TYPES = frozenset({"semantic_pair"})


class ManifestError(ValueError):
    """Raised when a machine artifact violates a public Skill Eval contract."""
