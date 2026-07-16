import { describe, expect, it } from "vitest";

import { resolveEvidenceNodeIcon } from "./EvidenceNodeIcon";

describe("resolveEvidenceNodeIcon", () => {
  it("uses an explicit X-shaped icon for every failed evidence node kind", () => {
    expect(resolveEvidenceNodeIcon("run", "bad").key).toBe("circle-x");
    expect(resolveEvidenceNodeIcon("gate", "bad").key).toBe("shield-x");
    expect(resolveEvidenceNodeIcon("iteration", "bad").key).toBe("circle-x");
    expect(resolveEvidenceNodeIcon("case", "bad").key).toBe("circle-x");
    expect(resolveEvidenceNodeIcon("assertion", "bad").key).toBe("file-x");
    expect(resolveEvidenceNodeIcon("artifact", "bad").key).toBe("archive-x");
  });

  it("distinguishes pending checks from passed checks without relying on color", () => {
    expect(resolveEvidenceNodeIcon("gate", "warn").key).toBe(
      "shield-question",
    );
    expect(resolveEvidenceNodeIcon("assertion", "warn").key).toBe(
      "file-question",
    );
    expect(resolveEvidenceNodeIcon("gate", "good").key).toBe("shield-check");
    expect(resolveEvidenceNodeIcon("assertion", "good").key).toBe(
      "file-check",
    );
  });
});
