import { lstatSync } from "node:fs";

import {
  containsCredential,
  countCredentialLines,
  redactText,
  safeArtifact,
  sanitizeObservable,
  sha256,
} from "./agent-process.mjs";

function assertFinite(value) {
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  if (Array.isArray(value)) return value.every(assertFinite);
  if (value && typeof value === "object") return Object.values(value).every(assertFinite);
  return true;
}

export function compactJson(value) {
  if (!assertFinite(value)) throw new Error("JSON value contains a non-finite number");
  return JSON.stringify(value);
}

export function captureJsonl({ buffer, credentials, implementation, context, state }) {
  const sourceStreamDigest = sha256(buffer);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    const sourceError = {
      type: "invalid_utf8",
      source_event_index: 1,
      source_sha256: sourceStreamDigest,
      source_bytes: buffer.length,
    };
    return {
      events: [{
        kind: "error",
        summary: "Agent source stream is not valid UTF-8",
        status: "failed",
        details: sourceError,
        artifact_refs: [],
      }],
      retained: [sourceError],
      sourceEventCount: buffer.length > 0 ? 1 : 0,
      retainedEventCount: 1,
      parseErrorCount: 1,
      credentialObservationCount: countCredentialLines(buffer, credentials),
      sourceStreamDigest,
    };
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const retained = [];
  const events = [];
  let parseErrorCount = 0;
  let credentialObservationCount = 0;
  let sourceIndex = 0;
  for (const line of lines) {
    sourceIndex += 1;
    if (line.trim() === "") continue;
    let parsed;
    let errorKind = "invalid";
    let lineHasCredential = redactText(line, credentials) !== line;
    try {
      parsed = JSON.parse(line);
      if (!assertFinite(parsed)) throw new Error("non-finite JSON number");
    } catch (error) {
      parsed = null;
      errorKind = error.message === "non-finite JSON number" ? "invalid" : "unparseable";
    }
    if (!lineHasCredential && parsed !== null && containsCredential(parsed, credentials)) {
      lineHasCredential = true;
    }
    if (lineHasCredential) credentialObservationCount += 1;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      parseErrorCount += 1;
      const sourceError = {
        type: errorKind,
        source_event_index: sourceIndex,
        source_sha256: sha256(line),
        source_bytes: Buffer.byteLength(line, "utf8"),
      };
      retained.push(sourceError);
      events.push({
        kind: "error",
        summary: "Agent source stream contained an invalid JSONL record",
        status: "failed",
        details: sourceError,
        artifact_refs: [],
      });
      continue;
    }
    const observable = sanitizeObservable(parsed, credentials);
    retained.push(observable);
    events.push(...implementation.accept(observable, sourceIndex, context, state));
  }
  return {
    events,
    retained,
    sourceEventCount: sourceIndex,
    retainedEventCount: retained.length,
    parseErrorCount,
    credentialObservationCount,
    sourceStreamDigest,
  };
}

export function numericUsage(usage) {
  const result = {};
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) result[`usage_${key}`] = value;
  }
  return result;
}

export function existingRegularFiles(root, relatives) {
  return relatives.filter((relative) => {
    try {
      const metadata = lstatSync(safeArtifact(root, relative));
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
}
