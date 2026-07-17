export type DashboardSourceMode =
  | "configured"
  | "local_control_plane"
  | "invalid";

export interface DashboardSource {
  mode: DashboardSourceMode;
  pageBaseUrl: string;
  resourceBaseUrl: string;
  dataUrl: string | null;
  sessionUrl: string | null;
  sessionToken: string | null;
  localNetwork: boolean;
  error: string | null;
}

export interface DashboardSession {
  contract: "skill-reviewer.dashboard-session";
  run_id: string;
  session_transport: "fragment-to-header";
  session_header: "X-Skill-Reviewer-Session";
  evidence_read_only: true;
  eval_mutation: false;
  action_requests_enabled: boolean;
  data_endpoint: "/dashboard-data.json";
  action_request_endpoint: "/dashboard-action-requests";
  action_audit_endpoint: "/dashboard-action-requests.json";
  agent_handoff: {
    contract: "skill-reviewer.dashboard-agent-handoff";
    mode: "durable_local_ledger";
    agent_session_state: "unbound";
    can_wake_agent_session: false;
    persists_after_agent_session_end: true;
    task_root: string;
  };
}

export const dashboardSessionHeader = "X-Skill-Reviewer-Session";
const historySessionKey = "__skillReviewerDashboardSession";

type LocalNetworkRequestInit = RequestInit & {
  targetAddressSpace?: "loopback";
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function invalidSource(pageBaseUrl: string, message: string): DashboardSource {
  return {
    mode: "invalid",
    pageBaseUrl,
    resourceBaseUrl: pageBaseUrl,
    dataUrl: null,
    sessionUrl: null,
    sessionToken: null,
    localNetwork: false,
    error: message,
  };
}

function validSessionToken(raw: string | null): raw is string {
  return Boolean(raw && /^[A-Za-z0-9_-]{32,256}$/.test(raw));
}

export function resolveDashboardSource(
  pageHref: string,
  basePath: string,
  configuredDataUrl?: string,
): DashboardSource {
  const page = new URL(pageHref);
  const pageBaseUrl = new URL(basePath || "/", page).href;
  if (page.hash.length > 4096) {
    return invalidSource(pageBaseUrl, "本机控制面链接过长；请重新启动临时会话。");
  }
  const fragment = new URLSearchParams(
    page.hash.startsWith("#") ? page.hash.slice(1) : page.hash,
  );
  const sessionToken = fragment.get("session");
  if (fragment.has("bridge")) {
    return invalidSource(
      pageBaseUrl,
      "控制面不接受远端数据服务地址；请使用 Skill Reviewer 启动的本机页面。",
    );
  }
  if (sessionToken !== null) {
    if (
      page.protocol !== "http:" ||
      !isLoopbackHostname(page.hostname) ||
      page.username ||
      page.password ||
      fragment.getAll("session").length !== 1 ||
      !validSessionToken(sessionToken)
    ) {
      return invalidSource(
        pageBaseUrl,
        "本机控制面会话无效；请通过 Skill Reviewer 启动命令重新创建临时会话。",
      );
    }
    const controlPlane = new URL("/", page.origin);
    return {
      mode: "local_control_plane",
      pageBaseUrl,
      resourceBaseUrl: controlPlane.href,
      dataUrl: new URL("dashboard-data.json", controlPlane).href,
      sessionUrl: new URL("dashboard-session.json", controlPlane).href,
      sessionToken,
      localNetwork: true,
      error: null,
    };
  }

  if (configuredDataUrl) {
    const dataUrl = new URL(configuredDataUrl, pageBaseUrl);
    if (
      page.protocol !== "http:" ||
      !isLoopbackHostname(page.hostname) ||
      dataUrl.protocol !== "http:" ||
      dataUrl.origin !== page.origin ||
      dataUrl.username ||
      dataUrl.password
    ) {
      return invalidSource(
        pageBaseUrl,
        "开发数据源必须与本机控制面保持同源。",
      );
    }
    return {
      mode: "configured",
      pageBaseUrl,
      resourceBaseUrl: new URL("./", dataUrl).href,
      dataUrl: dataUrl.href,
      sessionUrl: null,
      sessionToken: null,
      localNetwork: isLoopbackHostname(dataUrl.hostname),
      error: null,
    };
  }

  return invalidSource(
    pageBaseUrl,
    "当前页面没有本机控制面会话；请从 Skill Reviewer 的启动结果打开页面。",
  );
}

export function currentDashboardSource(): DashboardSource {
  const source = resolveDashboardSource(
    window.location.href,
    import.meta.env.BASE_URL,
    import.meta.env.VITE_DASHBOARD_DATA_URL,
  );
  if (source.mode === "local_control_plane" && source.sessionToken) {
    try {
      const page = new URL(window.location.href);
      const fragment = new URLSearchParams(
        page.hash.startsWith("#") ? page.hash.slice(1) : page.hash,
      );
      fragment.delete("session");
      page.hash = fragment.toString();
      const previous =
        window.history.state && typeof window.history.state === "object"
          ? window.history.state
          : {};
      window.history.replaceState(
        {
          ...previous,
          [historySessionKey]: {
            origin: page.origin,
            token: source.sessionToken,
          },
        },
        "",
        `${page.pathname}${page.search}${page.hash}`,
      );
    } catch {
      // The validated source remains usable in memory even if history APIs are
      // unavailable. The server still rejects requests without the token.
    }
    return source;
  }

  if (source.mode === "invalid") {
    try {
      const page = new URL(window.location.href);
      const fragment = new URLSearchParams(
        page.hash.startsWith("#") ? page.hash.slice(1) : page.hash,
      );
      const remembered = window.history.state?.[historySessionKey] as
        | { origin?: unknown; token?: unknown }
        | undefined;
      if (
        !fragment.has("session") &&
        !fragment.has("bridge") &&
        remembered?.origin === page.origin &&
        typeof remembered.token === "string" &&
        validSessionToken(remembered.token)
      ) {
        fragment.set("session", remembered.token);
        page.hash = fragment.toString();
        return resolveDashboardSource(
          page.href,
          import.meta.env.BASE_URL,
          import.meta.env.VITE_DASHBOARD_DATA_URL,
        );
      }
    } catch {
      // Fall through to the original invalid-source explanation.
    }
  }
  return source;
}

export function resolveDashboardResource(
  resource: string,
  source: DashboardSource = currentDashboardSource(),
): string {
  if (source.mode === "invalid") {
    throw new Error(source.error ?? "dashboard source is invalid");
  }
  const relative = resource.startsWith("/") ? resource.slice(1) : resource;
  const resolved = new URL(relative, source.resourceBaseUrl);
  const expectedOrigin = new URL(source.resourceBaseUrl).origin;
  if (resolved.origin !== expectedOrigin) {
    throw new Error("dashboard resource leaves the selected evidence source");
  }
  return resolved.href;
}

export function fetchDashboardResource(
  resource: string,
  init: RequestInit = {},
  source: DashboardSource = currentDashboardSource(),
): Promise<Response> {
  const request: LocalNetworkRequestInit = {
    ...init,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  };
  const headers = new Headers(init.headers);
  if (source.sessionToken) {
    const supplied = headers.get(dashboardSessionHeader);
    if (supplied && supplied !== source.sessionToken) {
      throw new Error("dashboard request tried to replace the active session token");
    }
    headers.set(dashboardSessionHeader, source.sessionToken);
    request.headers = headers;
  }
  if (source.localNetwork) request.targetAddressSpace = "loopback";
  return fetch(resolveDashboardResource(resource, source), request);
}

export async function loadDashboardSession(
  source: DashboardSource = currentDashboardSource(),
  signal?: AbortSignal,
): Promise<DashboardSession | null> {
  if (source.mode !== "local_control_plane") return null;
  if (!source.sessionUrl) throw new Error("dashboard session endpoint is unavailable");
  const response = await fetchDashboardResource(
    source.sessionUrl,
    { cache: "no-store", signal },
    source,
  );
  if (!response.ok) throw new Error(`dashboard session returned ${response.status}`);
  const payload = (await response.json()) as Partial<DashboardSession>;
  if (
    payload.contract !== "skill-reviewer.dashboard-session" ||
    typeof payload.run_id !== "string" ||
    !payload.run_id ||
    payload.session_transport !== "fragment-to-header" ||
    payload.session_header !== dashboardSessionHeader ||
    payload.evidence_read_only !== true ||
    payload.eval_mutation !== false ||
    typeof payload.action_requests_enabled !== "boolean" ||
    payload.data_endpoint !== "/dashboard-data.json" ||
    payload.action_request_endpoint !== "/dashboard-action-requests" ||
    payload.action_audit_endpoint !== "/dashboard-action-requests.json" ||
    payload.agent_handoff?.contract !==
      "skill-reviewer.dashboard-agent-handoff" ||
    payload.agent_handoff.mode !== "durable_local_ledger" ||
    payload.agent_handoff.agent_session_state !== "unbound" ||
    payload.agent_handoff.can_wake_agent_session !== false ||
    payload.agent_handoff.persists_after_agent_session_end !== true ||
    typeof payload.agent_handoff.task_root !== "string" ||
    !payload.agent_handoff.task_root
  ) {
    throw new Error(
      "dashboard session is not bound to the expected local control-plane contract",
    );
  }
  return payload as DashboardSession;
}
