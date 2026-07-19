import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { sha256 } from "./agent-digest.mjs";

export function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function writePrivate(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function atomicWriteJson(path, value, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(path, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
