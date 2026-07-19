// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchDashboardResource,
  currentDashboardSource,
  loadDashboardSession,
  resolveDashboardResource,
  resolveDashboardSource,
} from "./dashboard-source";

describe("local Dashboard data source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("requires a launcher-created local session instead of a hosted demo", () => {
    const source = resolveDashboardSource(
      "https://nirvana-jie.github.io/skill-reviewer/?run=demo",
      "/skill-reviewer/",
    );

    expect(source.mode).toBe("invalid");
    expect(source.dataUrl).toBeNull();
    expect(source.error).toMatch(/本机 Dashboard/);
  });

  it("rejects a configured data source that is not same-origin loopback", () => {
    const source = resolveDashboardSource(
      "http://127.0.0.1:5173/skill-reviewer/",
      "/skill-reviewer/",
      "https://example.com/dashboard-data.json",
    );

    expect(source.mode).toBe("invalid");
    expect(source.error).toMatch(/同源/);
  });

  it.each(["127.0.0.1", "127.18.9.4", "localhost", "[::1]"])(
    "accepts only a same-origin loopback Dashboard session: %s",
    (host) => {
    const page = new URL(`http://${host}:8765/skill-reviewer/`);
    page.hash = new URLSearchParams({
      session: "session_token_abcdefghijklmnopqrstuvwxyz123456",
    }).toString();
    const source = resolveDashboardSource(page.href, "/skill-reviewer/");

    expect(source.mode).toBe("local_dashboard");
    expect(source.dataUrl).toBe(`${page.origin}/dashboard-data.json`);
    expect(source.sessionUrl).toBe(
      `${page.origin}/dashboard-session.json`,
    );
    expect(source.sessionToken).toBe(
      "session_token_abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(source.localNetwork).toBe(true);
    expect(source.error).toBeNull();
    expect(
      resolveDashboardResource("/dashboard-evidence/abc.json", source),
    ).toBe(`${page.origin}/dashboard-evidence/abc.json`);
  });

  it.each([
    "https://127.0.0.1:8765/skill-reviewer/",
    "http://192.168.1.10:8765/skill-reviewer/",
    "http://example.com:8765/skill-reviewer/",
    "http://user:secret@127.0.0.1:8765/skill-reviewer/",
  ])("rejects an unsafe Dashboard origin: %s", (pageHref) => {
    const page = new URL(pageHref);
    page.hash = new URLSearchParams({
      session: "session_token_abcdefghijklmnopqrstuvwxyz123456",
    }).toString();
    const source = resolveDashboardSource(page.href, "/skill-reviewer/");

    expect(source.mode).toBe("invalid");
    expect(source.dataUrl).toBeNull();
    expect(source.localNetwork).toBe(false);
    expect(source.error).toMatch(/本机|Dashboard/i);
  });

  it("marks local Dashboard requests as local-network fetches and omits credentials", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", mockFetch);
    const page = new URL("http://127.0.0.1:8765/skill-reviewer/");
    page.hash = new URLSearchParams({
      session: "session_token_abcdefghijklmnopqrstuvwxyz123456",
    }).toString();
    const source = resolveDashboardSource(page.href, "/skill-reviewer/");

    await fetchDashboardResource("/dashboard-data.json", { cache: "no-store" }, source);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/dashboard-data.json",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        targetAddressSpace: "loopback",
      }),
    );
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Skill-Reviewer-Session")).toBe(
      "session_token_abcdefghijklmnopqrstuvwxyz123456",
    );
  });

  it("removes the session capability from the address bar after bootstrap", () => {
    window.history.replaceState(
      {},
      "",
      "/skill-reviewer/#session=session_token_abcdefghijklmnopqrstuvwxyz123456&view=diff",
    );

    const first = currentDashboardSource();
    expect(first.mode).toBe("local_dashboard");
    expect(first.sessionToken).toBe(
      "session_token_abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(window.location.hash).not.toContain("session=");
    expect(window.location.hash).toContain("view=diff");

    const restored = currentDashboardSource();
    expect(restored.mode).toBe("local_dashboard");
    expect(restored.sessionToken).toBe(first.sessionToken);
    expect(window.location.hash).not.toContain("session=");
  });

  it("ignores legacy query capabilities and requires a complete fragment session", () => {
    const legacy = resolveDashboardSource(
      "https://nirvana-jie.github.io/skill-reviewer/?source=http://127.0.0.1:8765&run=secret",
      "/skill-reviewer/",
    );
    expect(legacy.mode).toBe("invalid");

    const missingToken = resolveDashboardSource(
      "http://127.0.0.1:8765/skill-reviewer/#bridge=http%3A%2F%2F127.0.0.1%3A8765",
      "/skill-reviewer/",
    );
    expect(missingToken.mode).toBe("invalid");
  });

  it("validates the session handshake before trusting its run and endpoints", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contract: "skill-reviewer.dashboard-session",
          run_id: "run-local",
          session_transport: "fragment-to-header",
          session_header: "X-Skill-Reviewer-Session",
          evidence_read_only: true,
          eval_mutation: false,
          data_endpoint: "/dashboard-data.json",
        }),
      ),
    );
    vi.stubGlobal("fetch", mockFetch);
    const page = new URL("http://127.0.0.1:8765/skill-reviewer/");
    page.hash = new URLSearchParams({
      session: "session_token_abcdefghijklmnopqrstuvwxyz123456",
    }).toString();
    const source = resolveDashboardSource(page.href, "/skill-reviewer/");

    await expect(loadDashboardSession(source)).resolves.toEqual(
      expect.objectContaining({ run_id: "run-local", evidence_read_only: true }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/dashboard-session.json",
      expect.objectContaining({ targetAddressSpace: "loopback" }),
    );
  });
});
