import { describe, expect, it } from "vitest";

import { nextActionMessageKey } from "./ActionCenter";

describe("nextActionMessageKey", () => {
  it("keeps invalid measurements on the eval-repair path", () => {
    expect(nextActionMessageKey("propose_eval_change")).toBe(
      "action_propose_eval_change",
    );
  });
});
