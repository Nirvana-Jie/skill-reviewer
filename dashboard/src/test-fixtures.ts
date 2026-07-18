import type { AgentDispatchReceipt } from "./types";

type ValidAgentDispatchReceipt = Extract<
  AgentDispatchReceipt,
  { valid: true }
>;

export function agentDispatchReceiptFixture(
  overrides: Partial<ValidAgentDispatchReceipt> = {},
): ValidAgentDispatchReceipt {
  return {
    artifact: "dispatch-receipt.json",
    digest: "b".repeat(64),
    valid: true,
    provider: "native-agent",
    harness: "lead-agent-dispatch",
    observation: "host_dispatch",
    dispatch_id: "dispatch-quality",
    worker_id: "worker-quality",
    batch_id: "batch-quality",
    dispatched_at: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}
