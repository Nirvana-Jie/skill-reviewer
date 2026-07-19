import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";

export function decodeUtf8(bytes, label = "input") {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

export function readUtf8File(path, label = String(path)) {
  return decodeUtf8(readFileSync(path), label);
}
