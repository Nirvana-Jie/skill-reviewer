import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { canonicalJson, sha256 } from "./agent-digest.mjs";

export { canonicalJson, sha256 } from "./agent-digest.mjs";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN)(?:_|$)/i;
const SAFE_AGENT_ENV_NAMES = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const FORBIDDEN_DETAIL_KEYS = new Set([
  "analysis",
  "chain_of_thought",
  "encrypted_content",
  "encrypted_reasoning",
  "private_reasoning",
  "reasoning",
  "signature",
  "thinking",
  "thought",
  "thoughts",
]);
const MAX_TRACE_STRING = 24_000;
const MAX_TRACE_LIST = 100;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const REDACTED_CREDENTIAL = "[REDACTED_CREDENTIAL]";
const activeChildren = new Set();

export class AgentInterruptedError extends Error {}

function validateNames(names, label) {
  const result = [];
  for (const raw of names ?? []) {
    const name = String(raw).trim();
    if (!ENV_NAME.test(name)) throw new Error(`${label} contains an invalid environment name`);
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function unicodeEscaped(value) {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x7f) {
      result += character;
    } else if (code <= 0xffff) {
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      const adjusted = code - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      result += `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  }
  return result;
}

function credentialVariants(credentials) {
  const variants = new Set();
  for (const secret of credentials) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(unicodeEscaped(secret));
  }
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

export function redactText(value, credentials) {
  let result = String(value);
  for (const secret of credentialVariants(credentials)) {
    result = result.split(secret).join(REDACTED_CREDENTIAL);
  }
  return result;
}

export function containsCredential(value, credentials) {
  const variants = credentialVariants(credentials);
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string" && variants.some((secret) => current.includes(secret))) {
      return true;
    }
    if (Array.isArray(current)) pending.push(...current);
    else if (current && typeof current === "object") {
      pending.push(...Object.keys(current), ...Object.values(current));
    }
  }
  return false;
}

export function sanitizeObservable(value, credentials = [], depth = 0) {
  if (depth > 8) return "<nested payload omitted>";
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_TRACE_LIST)
      .map((item) => sanitizeObservable(item, credentials, depth + 1));
    if (value.length > MAX_TRACE_LIST) result.push(`<${value.length - MAX_TRACE_LIST} items omitted>`);
    return result;
  }
  if (value && typeof value === "object") {
    if (value.type === "thinking" || value.type === "reasoning") {
      return { id: value.id ?? null, type: value.type, redacted: true };
    }
    const result = {};
    for (const [rawKey, item] of Object.entries(value)) {
      const normalized = rawKey.trim().toLowerCase().replaceAll("-", "_");
      if (FORBIDDEN_DETAIL_KEYS.has(normalized)) continue;
      result[redactText(rawKey, credentials)] = sanitizeObservable(
        item,
        credentials,
        depth + 1,
      );
    }
    return result;
  }
  if (typeof value === "string") {
    const bounded =
      value.length > MAX_TRACE_STRING
        ? `${value.slice(0, MAX_TRACE_STRING)}\n<${value.length - MAX_TRACE_STRING} characters omitted>`
        : value;
    return redactText(bounded, credentials);
  }
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  return redactText(String(value), credentials);
}

export function buildAgentEnvironment({
  passNames = [],
  credentialNames = [],
  inheritedNames = [],
  source = process.env,
}) {
  const ordinary = validateNames(passNames, "--pass-env");
  const credentials = validateNames(credentialNames, "--credential-env");
  const inherited = validateNames(inheritedNames, "adapter inherited environment");
  const unsafeInherited = inherited.filter((name) => SECRET_ENV_NAME.test(name));
  if (unsafeInherited.length > 0) {
    throw new Error(
      `agent adapter cannot implicitly inherit secret-like environment names: ${unsafeInherited.join(", ")}`,
    );
  }
  const overlap = ordinary.filter((name) => credentials.includes(name));
  if (overlap.length > 0) {
    throw new Error(
      `environment names cannot be both ordinary and credential values: ${overlap.join(", ")}`,
    );
  }
  const misplacedSecrets = ordinary.filter((name) => SECRET_ENV_NAME.test(name));
  if (misplacedSecrets.length > 0) {
    throw new Error(
      `secret-like environment names require --credential-env: ${misplacedSecrets.join(", ")}`,
    );
  }
  const requested = [...ordinary, ...credentials];
  const missing = requested.filter((name) => !(name in source));
  if (missing.length > 0) {
    throw new Error(`requested agent environment values are unavailable: ${missing.join(", ")}`);
  }
  const values = {};
  for (const name of [...SAFE_AGENT_ENV_NAMES].sort()) {
    if (name in source) values[name] = String(source[name]);
  }
  for (const name of inherited) {
    if (name in source) values[name] = String(source[name]);
  }
  for (const name of requested) values[name] = String(source[name]);
  values.NO_COLOR = "1";
  const credentialValues = [...new Set(credentials.map((name) => String(source[name])))]
    .sort((left, right) => right.length - left.length);
  const invalidCredentials = credentials.filter((name) => {
    const value = String(source[name]);
    return (
      value.trim() === "" ||
      Buffer.byteLength(value, "utf8") < 8 ||
      value === REDACTED_CREDENTIAL
    );
  });
  if (invalidCredentials.length > 0) {
    throw new Error(
      "declared agent credentials must be non-blank, at least 8 UTF-8 bytes, and distinct from redaction markers: " +
        invalidCredentials.join(", "),
    );
  }
  return {
    values,
    credentialValues,
    passedNameCount: ordinary.length,
    credentialNameCount: credentials.length,
    declaredNamesDigest: sha256([...requested].sort().join("\n")),
  };
}

export function resolveExecutable(command, environment) {
  let path;
  if (isAbsolute(command) || command.includes(sep)) {
    path = resolve(command);
  } else {
    const directories = String(environment.PATH ?? "").split(delimiter).filter(Boolean);
    path = directories.map((directory) => join(directory, command)).find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  }
  if (!path) throw new Error(`agent executable not found: ${command}`);
  const resolvedPath = realpathSync(path);
  const metadata = statSync(resolvedPath);
  if (!metadata.isFile()) throw new Error(`agent executable is not a regular file: ${resolvedPath}`);
  return {
    path: resolvedPath,
    digest: sha256(readFileSync(resolvedPath)),
  };
}

export function runProbe({ executable, args, cwd, environment, timeoutMs = 90_000 }) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function killGroup(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    if (error.code === "EPERM") {
      try {
        child.kill(signal);
      } catch (fallbackError) {
        if (fallbackError.code !== "ESRCH") throw fallbackError;
      }
      return;
    }
    throw error;
  }
}

export function interruptActiveAgentProcesses() {
  for (const child of activeChildren) killGroup(child, "SIGTERM");
  setTimeout(() => {
    for (const child of activeChildren) killGroup(child, "SIGKILL");
  }, 500).unref();
}

export function runCapturedProcess({
  executable,
  args,
  cwd,
  environment,
  timeoutSeconds,
  onStarted,
  signal,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let interrupted = false;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      activeChildren.delete(child);
      callback(value);
    };
    const abort = () => {
      interrupted = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 500).unref();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 500).unref();
    }, timeoutSeconds * 1000);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CAPTURE_BYTES) {
        timedOut = true;
        killGroup(child, "SIGTERM");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CAPTURE_BYTES) {
        timedOut = true;
        killGroup(child, "SIGTERM");
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => finish(rejectPromise, error));
    child.once("spawn", () => {
      try {
        onStarted?.(child.pid);
      } catch (error) {
        killGroup(child, "SIGTERM");
        setTimeout(() => killGroup(child, "SIGKILL"), 500).unref();
        finish(rejectPromise, error);
      }
    });
    child.once("close", (code, closeSignal) => {
      if (interrupted) {
        finish(rejectPromise, new AgentInterruptedError("Agent execution interrupted"));
        return;
      }
      finish(resolvePromise, {
        exitCode: code,
        signal: closeSignal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

export function safeArtifact(root, relative) {
  if (typeof relative !== "string" || relative === "" || isAbsolute(relative)) {
    throw new Error("artifact path must be relative");
  }
  const path = resolve(root, relative);
  const prefix = `${resolve(root)}${sep}`;
  if (path !== resolve(root) && !path.startsWith(prefix)) {
    throw new Error(`artifact path escapes the execution root: ${relative}`);
  }
  return path;
}

function replaceCredentials(raw, credentials) {
  let result = raw;
  for (const variant of credentialVariants(credentials)) {
    const source = Buffer.from(variant, "utf8");
    if (source.length === 0) continue;
    result = Buffer.from(
      result.toString("utf8").split(variant).join(REDACTED_CREDENTIAL),
      "utf8",
    );
  }
  return result;
}

export function redactRetainedFiles({ root, relativePaths, credentials }) {
  if (credentials.length === 0) return [];
  const changed = [];
  for (const relative of [...new Set(relativePaths)]) {
    const path = safeArtifact(root, relative);
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`credential scan requires a private regular artifact: ${relative}`);
    }
    const raw = readFileSync(path);
    const redacted = replaceCredentials(raw, credentials);
    if (redacted.equals(raw)) continue;
    changed.push(relative);
    const temporary = join(dirname(path), `.${metadata.ino}.${process.pid}.redacted`);
    const descriptor = openSync(temporary, "wx", metadata.mode & 0o777);
    try {
      writeFileSync(descriptor, redacted);
      closeSync(descriptor);
      chmodSync(temporary, metadata.mode & 0o777);
      renameSync(temporary, path);
    } finally {
      try {
        closeSync(descriptor);
      } catch (error) {
        if (error.code !== "EBADF") throw error;
      }
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return changed;
}

export function countCredentialLines(buffer, credentials) {
  if (credentials.length === 0) return 0;
  return buffer
    .toString("utf8")
    .split(/(?<=\n)/)
    .filter((line) => redactText(line, credentials) !== line).length;
}
