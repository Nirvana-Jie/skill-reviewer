#!/usr/bin/env node

/** Project one Skill Reviewer run and start its temporary local Dashboard session. */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  DashboardBundleError,
  materializeDashboardUi,
} from "./dashboard_bundle.mjs";
import {
  DASHBOARD_LAUNCH_SESSION_CONTRACT,
  ManifestError,
} from "./lib/skill-eval-contracts.mjs";
import { projectDashboard } from "./lib/skill-eval-dashboard.mjs";
import { isMainModule } from "./lib/module-entrypoint.mjs";
import {
  DashboardServerError,
  createDashboardServer,
  randomSessionToken,
  validateLoopbackBindHost,
  validateSources,
} from "./serve_skill_dashboard.mjs";

class DashboardLauncherUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "DashboardLauncherUsageError";
  }
}

function displayJson(value) {
  if (Array.isArray(value)) return `[${value.map(displayJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${displayJson(item)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function numberOption(raw, option) {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new DashboardLauncherUsageError(`${option} must be a number`);
  return value;
}

export function parseArgs(argv) {
  const values = {
    host: "127.0.0.1",
    port: 8765,
    portAttempts: 3,
    refreshSeconds: 3,
    open: false,
    serveExisting: false,
    prepareOnly: false,
    userApprovedDashboard: false,
    state: null,
    uiDir: null,
  };
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const flags = new Map([
    ["--open", "open"],
    ["--serve-existing", "serveExisting"],
    ["--prepare-only", "prepareOnly"],
    ["--user-approved-dashboard", "userApprovedDashboard"],
  ]);
  const options = new Set([
    "--workspace", "--state", "--ui-dir", "--host", "--port",
    "--port-attempts", "--refresh-seconds",
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (flags.has(token)) {
      if (seen.has(token)) throw new DashboardLauncherUsageError(`${token} may be provided only once`);
      seen.add(token);
      values[flags.get(token)] = true;
      continue;
    }
    if (!options.has(token)) throw new DashboardLauncherUsageError(`unknown option: ${token}`);
    if (seen.has(token)) throw new DashboardLauncherUsageError(`${token} may be provided only once`);
    seen.add(token);
    const value = argv[++index];
    if (value === undefined) throw new DashboardLauncherUsageError(`${token} requires a value`);
    if (token === "--workspace") values.workspace = resolve(value);
    else if (token === "--state") values.state = resolve(value);
    else if (token === "--ui-dir") values.uiDir = resolve(value);
    else if (token === "--host") values.host = value;
    else if (token === "--port") values.port = numberOption(value, token);
    else if (token === "--port-attempts") values.portAttempts = numberOption(value, token);
    else values.refreshSeconds = numberOption(value, token);
  }
  if (!values.workspace) throw new DashboardLauncherUsageError("--workspace is required");
  if (!Number.isInteger(values.port) || values.port < 0 || values.port > 65535) {
    throw new DashboardLauncherUsageError("--port must be between 0 and 65535");
  }
  if (!Number.isInteger(values.portAttempts) || values.portAttempts < 1 || values.portAttempts > 20) {
    throw new DashboardLauncherUsageError("--port-attempts must be between 1 and 20");
  }
  if (values.refreshSeconds < 0 || values.refreshSeconds > 3600) {
    throw new DashboardLauncherUsageError("--refresh-seconds must be between 0 and 3600");
  }
  if (values.port > 0 && values.port + values.portAttempts - 1 > 65535) {
    throw new DashboardLauncherUsageError("the requested port range exceeds 65535");
  }
  if (!values.prepareOnly && !values.userApprovedDashboard) {
    throw new DashboardLauncherUsageError(
      "starting the optional Dashboard requires an explicit user request; pass --user-approved-dashboard only after that request",
    );
  }
  return values;
}

function usage() {
  return [
    "Usage: start_skill_dashboard.mjs --workspace PATH [options]",
    "Options:",
    "  --state PATH --ui-dir PATH --host HOST --port PORT",
    "  --port-attempts N --refresh-seconds N --open --serve-existing",
    "  --prepare-only --user-approved-dashboard",
  ].join("\n");
}

export function portCandidates(preferred, attempts) {
  if (preferred === 0) return [0];
  return Array.from({ length: attempts }, (_, index) => preferred + index);
}

function listen(server, host, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

export async function bindDashboardServer({
  host,
  preferredPort,
  attempts,
  workspace,
  sessionToken,
  staticUiRoot,
}) {
  let lastError = null;
  for (const port of portCandidates(preferredPort, attempts)) {
    const server = createDashboardServer({ workspace, sessionToken, staticUiRoot });
    try {
      await listen(server, host, port);
      return server;
    } catch (error) {
      lastError = error;
      if (!["EADDRINUSE", "EACCES"].includes(error?.code)) throw error;
    }
  }
  throw new DashboardServerError(
    "no dashboard port is available in the requested range; choose another --port or use --port 0",
    { cause: lastError },
  );
}

export function dashboardOrigin(host, port) {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

export function dashboardUrl(origin, sessionToken) {
  return `${origin}/skill-reviewer/#${new URLSearchParams({ session: sessionToken })}`;
}

export async function prepareDashboard(args) {
  const workspace = realpathSync(resolve(args.workspace));
  if (!args.serveExisting) {
    await projectDashboard({
      workspace,
      output: join(workspace, "dashboard-data.json"),
      statePath: args.state ?? undefined,
    });
  }
  const report = validateSources(workspace);
  return {
    ...report,
    dashboard_hosted: false,
    dashboard_session_started: false,
    projected: !args.serveExisting,
    projection_source: args.serveExisting ? "existing_projection" : "fresh_run_projection",
    evidence_uploaded: false,
  };
}

function projectionDigest(workspace) {
  return createHash("sha256")
    .update(readFileSync(join(workspace, "dashboard-data.json")))
    .digest("hex");
}

export function watchProjection({ workspace, statePath, intervalSeconds, initialDigest }) {
  let stopped = false;
  let timer = null;
  let previousDigest = initialDigest;
  let previousError = null;
  let active = Promise.resolve();

  async function update() {
    if (stopped) return;
    try {
      const data = await projectDashboard({
        workspace,
        output: join(workspace, "dashboard-data.json"),
        statePath: statePath ?? undefined,
      });
      const currentDigest = projectionDigest(workspace);
      if (currentDigest !== previousDigest || previousError !== null) {
        const run = data && typeof data === "object" && !Array.isArray(data) ? data.run : null;
        process.stderr.write(`${displayJson({
          event: "dashboard_projection_updated",
          run_id: run && typeof run === "object" ? run.id ?? null : null,
          status: run && typeof run === "object" ? run.status ?? null : null,
          verification_level: run && typeof run === "object" ? run.verification_level ?? null : null,
        })}\n`);
      }
      previousDigest = currentDigest;
      previousError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== previousError) {
        process.stderr.write(`${displayJson({
          event: "dashboard_projection_failed",
          error: message,
          retrying: true,
        })}\n`);
      }
      previousError = message;
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          active = update();
        }, intervalSeconds * 1000);
        timer.unref?.();
      }
    }
  }

  timer = setTimeout(() => {
    active = update();
  }, intervalSeconds * 1000);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}

function uiReport(ui) {
  return {
    ui_mode: ui.mode,
    ui_downloaded: ui.temporary,
    ui_temporary: ui.temporary,
    ui_removed_on_exit: ui.temporary,
    ui_integrity_verified: ui.integrity_verified,
    ui_archive_sha256: ui.archive_sha256,
    ui_tree_sha256: ui.tree_sha256,
    ui_download_authenticated: false,
    github_token_used: false,
  };
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function waitForStop(server) {
  return new Promise((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.once("close", stop);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`start_skill_dashboard.mjs: error: ${error.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let materialized = null;
  let server = null;
  let watcher = null;
  let temporaryUiRemoved = false;
  try {
    validateLoopbackBindHost(args.host);
    const report = await prepareDashboard(args);
    if (args.prepareOnly) {
      process.stdout.write(`${JSON.stringify({
        ...report,
        ui_downloaded: false,
        ui_removed_on_exit: false,
      }, null, 2)}\n`);
      return 0;
    }

    materialized = await materializeDashboardUi({ uiDir: args.uiDir });
    const ui = materialized.ui;
    const sessionToken = randomSessionToken();
    server = await bindDashboardServer({
      host: args.host,
      preferredPort: args.port,
      attempts: args.portAttempts,
      workspace: args.workspace,
      sessionToken,
      staticUiRoot: ui.root,
    });
    const address = server.address();
    const origin = dashboardOrigin(String(address.address), Number(address.port));
    const url = dashboardUrl(origin, sessionToken);
    const watching = !args.serveExisting && args.refreshSeconds > 0;
    const launchReport = {
      ...report,
      ...uiReport(ui),
      user_approved_dashboard: true,
      dashboard_session_started: true,
      base_url: origin,
      data_url: `${origin}/dashboard-data.json`,
      session_url: `${origin}/dashboard-session.json`,
      url,
      port: address.port,
      projection_mode: watching ? "watching" : "static",
      refresh_seconds: watching ? args.refreshSeconds : 0,
      dashboard_session: {
        contract: DASHBOARD_LAUNCH_SESSION_CONTRACT,
        run_id: report.run_id ?? null,
        page_url: url,
        local_origin: origin,
        owner: "lead_agent",
        lifecycle: "temporary-local-dashboard",
        evidence_transport: "same-origin-loopback-only",
        evidence_uploaded: false,
        capability_transport: "url-fragment-to-request-header",
        ui_integrity_verified: ui.integrity_verified,
        ui_downloaded: ui.temporary,
        ui_removed_on_exit: ui.temporary,
      },
    };
    process.stdout.write(`${JSON.stringify(launchReport)}\n`);
    if (args.open && !openBrowser(url)) {
      process.stderr.write("dashboard browser could not be opened automatically; use the printed local URL\n");
    }
    if (watching) {
      watcher = watchProjection({
        workspace: realpathSync(resolve(args.workspace)),
        statePath: args.state,
        intervalSeconds: args.refreshSeconds,
        initialDigest: projectionDigest(realpathSync(resolve(args.workspace))),
      });
    }
    await waitForStop(server);
    return 0;
  } catch (error) {
    if (
      error instanceof DashboardBundleError || error instanceof DashboardServerError ||
      error instanceof ManifestError || error instanceof Error
    ) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    return 2;
  } finally {
    await watcher?.stop();
    await closeServer(server);
    if (materialized) {
      temporaryUiRemoved = materialized.ui.temporary;
      materialized.dispose();
    }
    if (temporaryUiRemoved) {
      process.stderr.write(`${displayJson({
        event: "dashboard_temporary_ui_removed",
        evidence_uploaded: false,
      })}\n`);
    }
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
