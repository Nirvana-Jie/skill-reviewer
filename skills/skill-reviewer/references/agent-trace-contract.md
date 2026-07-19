# Provider-Neutral Agent Trace Contract

Read this file before adding an Agent executor, changing Trace retention, or
changing the Dashboard Trace view. This contract is provider-neutral: the
Dashboard never parses Codex, Claude, or another vendor's event format.

## First-principles boundary

The reviewer needs to answer four independent questions for every locked
`case × arm × repeat` cell:

1. **What was intended?** The immutable execution profile names the target,
   harness, dispatch observation, trace adapter, and optional source stream.
2. **Was a real worker observed?** `dispatch-receipt.json` binds a host
   dispatch, spawned process, or external harness run to the locked cell.
3. **What observable behavior occurred?** `agent-trace.jsonl` contains the
   provider-neutral ordered event stream.
4. **Can the normalization be audited?** When the profile declares a source
   stream, `execution.json.source_trace` binds the redacted provider events,
   adapter, format, counts, and digests.

These facts are orthogonal. A completed process is not a passing Eval, a
declared profile is not proof of dispatch, and a normalized Trace without a
required source stream is incomplete evidence.

They also precede measurement and candidate judgment. The Dashboard and
decision runtime apply evidence integrity first, then oracle/sampling validity,
then candidate quality. Read `measurement-validity.md` for that contract.

## Four-layer architecture

```text
Agent/provider events
        │ provider adapter (redact + normalize)
        ▼
agent-trace.jsonl + optional agent-source-events.jsonl
        │ runtime validation + grading + projection
        ▼
provider-neutral Dashboard read model
```

- **Provider layer:** any native Agent, local CLI, SDK, remote service, or
  external harness that can expose observable events.
- **Adapter layer:** maps provider events to the canonical event kinds and
  removes private reasoning before writing either retained stream.
- **Evidence layer:** validates identity, sequence, lifecycle, artifacts,
  digests, dispatch provenance, and the optional source descriptor.
- **Presentation layer:** classifies the observed dispatch mode and renders the
  canonical events. It must not branch on a provider allowlist.

Adding another Agent therefore requires an adapter and an execution profile,
not a Dashboard component. An adapter that cannot produce a provider stream
may set `trace.source` to `null`; it must still record real observable events
and may not reconstruct hidden or missing activity.

## Locked execution profile

The canonical profile has this exact provider-neutral shape:

```json
{
  "target": "example-agent",
  "harness": "example-stream-adapter",
  "dispatch_observation": "process_spawn",
  "trace": {
    "capture_source": "provider_stream",
    "source": {
      "artifact": "agent-source-events.jsonl",
      "format": "example-stream-v1"
    }
  },
  "capabilities": ["filesystem-read", "source-event-stream"],
  "isolation": "local-unattested",
  "sampling": {"mode": "provider-default", "paired": true}
}
```

`dispatch_observation` is one of:

- `host_dispatch` — a native host/subagent dispatch;
- `process_spawn` — a locally observed Agent process;
- `external_harness` — an execution observed by a bound external harness.

`trace.capture_source` is a lowercase adapter slug, not a provider enum.
`trace.source` is either `null` or an object with the exact retained artifact
and source format. When non-null, every valid execution must bind a matching
`source_trace`; the Dashboard reports a missing or stale stream as an evidence
gap.

## Canonical event stream

`agent-trace.jsonl` contains one JSON object per observable event. Every event
binds `run_id`, `case_id`, `arm`, `repeat`, a contiguous `sequence`, monotonic
`elapsed_ms`, lifecycle `status`, human-readable `summary`, recursively safe
`details`, and `artifact_refs`.

Supported kinds are:

- `execution_started`
- `file_read`
- `tool_call`
- `command`
- `agent_message`
- `artifact_written`
- `error`
- `execution_finished`

Adapters may map a richer provider vocabulary into these kinds. They must not
store chain-of-thought, private reasoning, encrypted reasoning, signatures, or
provider secrets. Observable tool arguments and results may be retained only
within the locked case's data and permission boundary.

Trace and execution envelopes are framework-owned artifacts. Assignments list
them in `artifact_ownership.framework`, never in the worker's
`expected_artifacts`. The evaluated Agent owns only task outputs. The harness
records dispatch, the adapter closes the canonical Trace, and the finalizer
then writes `execution.json`; assertions against those framework artifacts run
after finalization. This avoids circular contracts where a worker would have to
produce the evidence that proves its own execution before that execution can
be closed.

## Source-stream descriptor

When `trace.source` is declared, `execution.json.source_trace` binds:

```json
{
  "artifact": "agent-source-events.jsonl",
  "digest": "<sha256-of-redacted-file>",
  "adapter": "example-agent",
  "format": "example-stream-v1",
  "source_stream_digest": "<sha256-of-observed-input-bytes>",
  "source_event_count": 12,
  "retained_event_count": 11,
  "redaction": "private-reasoning-fields-removed"
}
```

`digest` verifies the retained redacted file. `source_stream_digest` binds the
bytes observed by the adapter and can differ because private events or fields
were removed. Neither digest proves provider authorship; without a
provider-signed API, dispatch and source retention remain trusted harness
evidence.

## Bundled adapter paths

The contract does not whitelist these providers; they are reference
implementations:

| Surface | Dispatch observation | Source stream | Bundled entry point |
| --- | --- | --- | --- |
| Native host/subagent | `host_dispatch` | optional | `record-dispatch`, `trace-event`, `finalize-execution` |
| Codex CLI | `process_spawn` | `codex-exec-jsonl-v1` | `run_codex_eval_executor.py` |
| Claude Code | `process_spawn` | `claude-stream-json-v1` | `run_claude_eval_executor.py` |
| External Agent harness | `external_harness` | optional | the same runtime commands or a contract-compatible adapter |

If a Skill starts a nested Agent, retain child events only when the harness
can bind them to the parent cell and the profile declares
`nested-agent-events`. Otherwise show nested coverage as unavailable.

## Real-execution verification

Adapter unit tests may use deterministic fake provider streams to verify
mapping, redaction, failure handling, and digest binding. They are necessary
but do not prove that an installed Agent can execute the end-to-end path.

Run the opt-in Vitest canary to launch installed Agent CLIs through the real
compile → dispatch → source retention → grade → projection chain. The canary
then mounts `EvalExecutionTraceView`, finds the provider event containing the
real output marker, expands it, and verifies that the marker is visible in the
rendered Dashboard:

```bash
SKILL_REVIEWER_REAL_AGENT_E2E=codex \
  pnpm exec vitest run dashboard/src/real-agent-trace.e2e.test.ts

SKILL_REVIEWER_REAL_AGENT_E2E=codex,claude \
  SKILL_REVIEWER_REAL_AGENT_ARTIFACT_DIR=/absolute/retained-root \
  pnpm exec vitest run dashboard/src/real-agent-trace.e2e.test.ts
```

The test is skipped by default because a real provider run may require local
authentication, network access, and model spend. A provider authentication or
service failure is retained as real failed evidence; it must not be rewritten
as a passing adapter result. CI continues to run the deterministic contract
and adapter suites without secrets.

## Dashboard invariants

- Classify the executor from the validated dispatch observation, not from
  target-name matching.
- Render source provenance for every profile that requires it, regardless of
  provider.
- Keep lifecycle, Eval result, and evidence quality as separate dimensions.
- Show measurement validity before any candidate-quality verdict; invalid or
  unverified measurement means the Skill was not judged.
- Show missing, partial, stale, or redaction-invalid Trace data explicitly.
- Never use projection data as grading authority or infer events the adapter
  did not retain.
