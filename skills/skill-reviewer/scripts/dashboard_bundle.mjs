#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { isMainModule } from "./lib/module-entrypoint.mjs";
import { decodeUtf8, readUtf8File } from "./lib/strict-utf8.mjs";

export class DashboardBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "DashboardBundleError";
  }
}

export const BUNDLE_CONTRACT = "skill-reviewer.dashboard-ui-bundle";
const CANONICAL_RELEASE_ROOT = "https://github.com/Nirvana-Jie/skill-reviewer/releases/download";
const LEGACY_RELEASE_TAG = "dashboard-ui-assets";
const RELEASE_TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const DEFAULT_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "dashboard-ui-bundle.json",
);
const HARD_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const HARD_MAX_UNPACKED_BYTES = 96 * 1024 * 1024;
const HARD_MAX_FILES = 256;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PATH_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_REDIRECT_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const ALLOWED_ASSET_SUFFIXES = new Set([".css", ".js", ".json", ".png", ".svg", ".wasm", ".woff2"]);
const MANIFEST_FIELDS = [
  "contract",
  "asset_url",
  "archive_sha256",
  "tree_sha256",
  "entrypoint",
  "max_archive_bytes",
  "max_unpacked_bytes",
  "max_files",
].sort();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

function boundedInt(value, label, hardLimit) {
  if (!Number.isInteger(value) || value < 1 || value > hardLimit) {
    throw new DashboardBundleError(`Dashboard bundle ${label} must be between 1 and ${hardLimit}`);
  }
  return value;
}

function validateReleaseTag(raw, { allowLegacy = false } = {}) {
  if (typeof raw !== "string" || (!RELEASE_TAG_PATTERN.test(raw) && !(allowLegacy && raw === LEGACY_RELEASE_TAG))) {
    throw new DashboardBundleError("Dashboard bundle release tag must be a stable semantic version such as v0.1.0");
  }
  return raw;
}

function validateAssetUrl(raw, treeDigest) {
  if (typeof raw !== "string") throw new DashboardBundleError("Dashboard bundle asset_url must be a string");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DashboardBundleError("Dashboard bundle asset_url must be the canonical content-addressed GitHub Release asset");
  }
  const match = parsed.pathname.match(
    new RegExp(`^/Nirvana-Jie/skill-reviewer/releases/download/([^/]+)/dashboard-ui-${treeDigest}\\.zip$`),
  );
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    !["", "443"].includes(parsed.port) ||
    parsed.username ||
    parsed.password ||
    !match ||
    parsed.search ||
    parsed.hash
  ) {
    throw new DashboardBundleError("Dashboard bundle asset_url must be the canonical content-addressed GitHub Release asset");
  }
  validateReleaseTag(match[1], { allowLegacy: true });
  return raw;
}

export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  let raw;
  try {
    raw = JSON.parse(readUtf8File(path, "Dashboard UI manifest"));
  } catch {
    throw new DashboardBundleError(`Dashboard UI manifest is unavailable or invalid: ${path}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(MANIFEST_FIELDS)) {
    throw new DashboardBundleError("Dashboard UI manifest fields are invalid");
  }
  if (raw.contract !== BUNDLE_CONTRACT) throw new DashboardBundleError("Dashboard UI manifest contract is invalid");
  if (typeof raw.archive_sha256 !== "string" || !SHA256_PATTERN.test(raw.archive_sha256)) {
    throw new DashboardBundleError("Dashboard bundle archive digest is invalid");
  }
  if (typeof raw.tree_sha256 !== "string" || !SHA256_PATTERN.test(raw.tree_sha256)) {
    throw new DashboardBundleError("Dashboard bundle tree digest is invalid");
  }
  if (raw.entrypoint !== "index.html") throw new DashboardBundleError("Dashboard bundle entrypoint must be index.html");
  return {
    asset_url: validateAssetUrl(raw.asset_url, raw.tree_sha256),
    archive_sha256: raw.archive_sha256,
    tree_sha256: raw.tree_sha256,
    entrypoint: raw.entrypoint,
    max_archive_bytes: boundedInt(raw.max_archive_bytes, "max_archive_bytes", HARD_MAX_ARCHIVE_BYTES),
    max_unpacked_bytes: boundedInt(raw.max_unpacked_bytes, "max_unpacked_bytes", HARD_MAX_UNPACKED_BYTES),
    max_files: boundedInt(raw.max_files, "max_files", HARD_MAX_FILES),
  };
}

function safeRelativePath(raw) {
  if (!raw || raw.length > 512 || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
    throw new DashboardBundleError("Dashboard bundle contains an unsafe path");
  }
  const parts = raw.split("/");
  if (parts.some((part) => ["", ".", ".."].includes(part) || !SAFE_PATH_PART_PATTERN.test(part))) {
    throw new DashboardBundleError(`Dashboard bundle path is not portable: ${JSON.stringify(raw)}`);
  }
  return { value: raw, parts };
}

function assetPathIsAllowed(path) {
  if (["index.html", "favicon.svg"].includes(path.value)) return true;
  return path.parts.length >= 2 && path.parts.length <= 4 && path.parts[0] === "assets" && ALLOWED_ASSET_SUFFIXES.has(extname(path.value).toLowerCase());
}

function assetDirectoryIsAllowed(path) {
  return path.parts.length >= 1 && path.parts.length <= 3 && path.parts[0] === "assets";
}

function lexicographicPathCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function walkUiFiles(root, { maxFiles, maxUnpackedBytes }) {
  const resolved = resolve(root);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new DashboardBundleError("Dashboard UI root is not a safe directory");
  }
  const files = [];
  const seenCasefold = new Set();
  let totalSize = 0;
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const entryMetadata = lstatSync(path);
      const relativePath = relative(resolved, path).split(sep).join("/");
      const portable = safeRelativePath(relativePath);
      if (entryMetadata.isSymbolicLink()) throw new DashboardBundleError("Dashboard UI tree contains a symlink");
      if (entryMetadata.isDirectory()) {
        if (!assetDirectoryIsAllowed(portable)) throw new DashboardBundleError(`Dashboard UI tree contains an unexpected directory: ${relativePath}`);
        visit(path);
      } else if (entryMetadata.isFile()) {
        if (!assetPathIsAllowed(portable)) throw new DashboardBundleError(`Dashboard UI tree contains an unexpected file: ${relativePath}`);
        const folded = relativePath.toLocaleLowerCase("en-US");
        if (seenCasefold.has(folded)) throw new DashboardBundleError("Dashboard UI tree contains duplicate case-insensitive paths");
        seenCasefold.add(folded);
        totalSize += entryMetadata.size;
        if (files.length + 1 > maxFiles || totalSize > maxUnpackedBytes) {
          throw new DashboardBundleError("Dashboard UI tree exceeds its size limits");
        }
        files.push({ relative: relativePath, path, size: entryMetadata.size });
      } else {
        throw new DashboardBundleError("Dashboard UI tree contains a non-regular file");
      }
    }
  }
  visit(resolved);
  files.sort((left, right) => lexicographicPathCompare(left.relative, right.relative));
  if (!files.some((file) => file.relative === "index.html")) throw new DashboardBundleError("Dashboard UI tree has no index.html");
  return files;
}

export function treeDigest(root, { maxFiles = HARD_MAX_FILES, maxUnpackedBytes = HARD_MAX_UNPACKED_BYTES } = {}) {
  const digest = createHash("sha256");
  for (const file of walkUiFiles(root, { maxFiles, maxUnpackedBytes })) {
    digest.update(file.relative);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(sha256File(file.path));
    digest.update("\n");
  }
  return digest.digest("hex");
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, content, crc) {
  const header = Buffer.alloc(30);
  const encodedName = Buffer.from(name, "utf8");
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(/[\x80-\uffff]/.test(name) ? 0x800 : 0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(content.length, 22);
  header.writeUInt16LE(encodedName.length, 26);
  return Buffer.concat([header, encodedName]);
}

function centralHeader(name, content, crc, offset) {
  const header = Buffer.alloc(46);
  const encodedName = Buffer.from(name, "utf8");
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(/[\x80-\uffff]/.test(name) ? 0x800 : 0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(content.length, 20);
  header.writeUInt32LE(content.length, 24);
  header.writeUInt16LE(encodedName.length, 28);
  header.writeUInt32LE(((0o100000 | 0o644) << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, encodedName]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  return footer;
}

function buildStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const content = readFileSync(file.path);
    const crc = crc32(content);
    const local = localHeader(file.relative, content, crc);
    localParts.push(local, content);
    centralParts.push(centralHeader(file.relative, content, crc, offset));
    offset += local.length + content.length;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([...localParts, central, endOfCentralDirectory(files.length, central.length, offset)]);
}

function validateRedirectTarget(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DashboardBundleError("Dashboard bundle download redirected outside trusted HTTPS hosts");
  }
  if (parsed.protocol !== "https:" || !ALLOWED_REDIRECT_HOSTS.has(parsed.hostname) || !["", "443"].includes(parsed.port) || parsed.username || parsed.password || parsed.hash) {
    throw new DashboardBundleError("Dashboard bundle download redirected outside trusted HTTPS hosts");
  }
  return parsed;
}

export async function downloadArchive(manifest, destination, { fetchImpl = fetch } = {}) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  let url = manifest.asset_url;
  let response;
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      validateRedirectTarget(url);
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: {
          Accept: "application/octet-stream",
          "Cache-Control": "no-store",
          "User-Agent": "skill-reviewer-dashboard-bundle",
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new DashboardBundleError("Dashboard bundle redirect has no location");
        url = new URL(location, url).toString();
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body) throw new Error(`HTTP ${response?.status ?? "unavailable"}`);
    validateRedirectTarget(response.url || url);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > manifest.max_archive_bytes)) {
      throw new DashboardBundleError("Dashboard bundle archive exceeds its download limit");
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > manifest.max_archive_bytes) throw new DashboardBundleError("Dashboard bundle archive exceeds its download limit");
      chunks.push(buffer);
    }
    const payload = Buffer.concat(chunks);
    if (payload.length < 1 || sha256(payload) !== manifest.archive_sha256) {
      throw new DashboardBundleError("Dashboard bundle archive digest does not match");
    }
    writeFileSync(destination, payload, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof DashboardBundleError) throw error;
    throw new DashboardBundleError("Dashboard UI could not be downloaded anonymously; check network access or use --ui-dir with a trusted local build");
  }
}

function parseZipEntries(archive) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = archive.lastIndexOf(signature);
  if (eocd < 0 || eocd + 22 > archive.length) throw new DashboardBundleError("Dashboard bundle archive is invalid");
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || eocd + 22 + commentLength !== archive.length || centralOffset + centralSize !== eocd) {
    throw new DashboardBundleError("Dashboard bundle archive is invalid");
  }
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== 0x02014b50) throw new DashboardBundleError("Dashboard bundle archive is invalid");
    const madeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const compression = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocd || (madeBy >>> 8) !== 3 || flags & 0x1 || flags & 0x8 || ![0, 8].includes(compression)) {
      throw new DashboardBundleError("Dashboard bundle archive is invalid");
    }
    let name;
    try {
      name = decodeUtf8(
        archive.subarray(cursor + 46, cursor + 46 + nameLength),
        "Dashboard bundle entry name",
      );
    } catch {
      throw new DashboardBundleError("Dashboard bundle archive is invalid");
    }
    entries.push({ name, flags, compression, crc, compressedSize, size, mode: externalAttributes >>> 16, localOffset });
    cursor = end;
  }
  if (cursor !== eocd) throw new DashboardBundleError("Dashboard bundle archive is invalid");
  return entries;
}

function entryContent(archive, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== 0x04034b50) throw new DashboardBundleError("Dashboard bundle archive is invalid");
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  let name;
  try {
    name = decodeUtf8(
      archive.subarray(offset + 30, offset + 30 + nameLength),
      "Dashboard bundle entry name",
    );
  } catch {
    throw new DashboardBundleError("Dashboard bundle archive is invalid");
  }
  if (name !== entry.name) throw new DashboardBundleError("Dashboard bundle archive is invalid");
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) throw new DashboardBundleError("Dashboard bundle archive is invalid");
  const compressed = archive.subarray(start, end);
  let content;
  try {
    content = entry.compression === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: entry.size + 1 });
  } catch {
    throw new DashboardBundleError("Dashboard bundle archive is invalid");
  }
  if (content.length !== entry.size || crc32(content) !== entry.crc) throw new DashboardBundleError("Dashboard bundle entry size does not match its metadata");
  return content;
}

export function extractArchive(archivePath, destination, manifest) {
  if (existsSync(destination)) {
    const metadata = lstatSync(destination);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || readdirSync(destination).length > 0) {
      throw new DashboardBundleError("Dashboard bundle extraction directory must be empty");
    }
  } else {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  const archive = readFileSync(archivePath);
  const entries = parseZipEntries(archive);
  const seen = new Set();
  const seenCasefold = new Set();
  let fileCount = 0;
  let unpackedSize = 0;
  for (const entry of entries) {
    const rawName = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    const path = safeRelativePath(rawName);
    const folded = path.value.toLocaleLowerCase("en-US");
    if (seen.has(path.value) || seenCasefold.has(folded)) throw new DashboardBundleError("Dashboard bundle contains a duplicate path");
    seen.add(path.value);
    seenCasefold.add(folded);
    const kind = entry.mode & 0o170000;
    const target = join(destination, ...path.parts);
    if (kind === 0o040000) {
      if (!assetDirectoryIsAllowed(path)) throw new DashboardBundleError(`Dashboard bundle contains an unexpected directory: ${path.value}`);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      chmodSync(target, 0o700);
      continue;
    }
    if (kind !== 0o100000) throw new DashboardBundleError("Dashboard bundle contains a non-regular entry");
    if (!assetPathIsAllowed(path)) throw new DashboardBundleError(`Dashboard bundle contains an unexpected file: ${path.value}`);
    fileCount += 1;
    unpackedSize += entry.size;
    if (fileCount > manifest.max_files || unpackedSize > manifest.max_unpacked_bytes) throw new DashboardBundleError("Dashboard bundle exceeds its extraction limits");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const content = entryContent(archive, entry);
    const handle = openSync(target, "wx", 0o600);
    try {
      writeSync(handle, content);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    chmodSync(target, 0o600);
  }
  const digest = treeDigest(destination, { maxFiles: manifest.max_files, maxUnpackedBytes: manifest.max_unpacked_bytes });
  if (digest !== manifest.tree_sha256) throw new DashboardBundleError("Dashboard bundle tree digest does not match");
  if (!existsSync(join(destination, manifest.entrypoint)) || !statSync(join(destination, manifest.entrypoint)).isFile()) {
    throw new DashboardBundleError("Dashboard bundle entrypoint is missing");
  }
  return digest;
}

export function manifestObject(manifest) {
  return {
    contract: BUNDLE_CONTRACT,
    asset_url: manifest.asset_url,
    archive_sha256: manifest.archive_sha256,
    tree_sha256: manifest.tree_sha256,
    entrypoint: manifest.entrypoint,
    max_archive_bytes: manifest.max_archive_bytes,
    max_unpacked_bytes: manifest.max_unpacked_bytes,
    max_files: manifest.max_files,
  };
}

export function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(manifestObject(manifest), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function packageUi(uiDir, outputDir, { maxArchiveBytes, maxUnpackedBytes, maxFiles, releaseTag }) {
  const canonicalReleaseTag = validateReleaseTag(releaseTag);
  const files = walkUiFiles(resolve(uiDir), { maxFiles, maxUnpackedBytes });
  const digest = treeDigest(uiDir, { maxFiles, maxUnpackedBytes });
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const archive = join(resolve(outputDir), `dashboard-ui-${digest}.zip`);
  const temporary = join(resolve(outputDir), `.${`dashboard-ui-${digest}.zip`}.part`);
  try {
    writeFileSync(temporary, buildStoredZip(files), { flag: "wx", mode: 0o600 });
    const size = statSync(temporary).size;
    if (size < 1 || size > maxArchiveBytes) throw new DashboardBundleError("Dashboard bundle archive exceeds its size limit");
    renameSync(temporary, archive);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const manifest = {
    asset_url: `${CANONICAL_RELEASE_ROOT}/${canonicalReleaseTag}/${`dashboard-ui-${digest}.zip`}`,
    archive_sha256: sha256File(archive),
    tree_sha256: digest,
    entrypoint: "index.html",
    max_archive_bytes: maxArchiveBytes,
    max_unpacked_bytes: maxUnpackedBytes,
    max_files: maxFiles,
  };
  return { archive, manifest };
}

export async function materializeDashboardUi({ uiDir = null, manifestPath = DEFAULT_MANIFEST_PATH, download = downloadArchive } = {}) {
  if (uiDir !== null) {
    const root = resolve(uiDir);
    return {
      ui: {
        root,
        mode: "trusted_local_override",
        temporary: false,
        integrity_verified: false,
        archive_sha256: null,
        tree_sha256: treeDigest(root),
      },
      dispose() {},
    };
  }
  const manifest = loadManifest(manifestPath);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-"));
  chmodSync(temporaryRoot, 0o700);
  const archive = join(temporaryRoot, "dashboard-ui.zip");
  const uiRoot = join(temporaryRoot, "ui");
  try {
    await download(manifest, archive);
    const digest = extractArchive(archive, uiRoot, manifest);
    unlinkSync(archive);
    return {
      ui: {
        root: uiRoot,
        mode: "temporary_verified_bundle",
        temporary: true,
        integrity_verified: true,
        archive_sha256: manifest.archive_sha256,
        tree_sha256: digest,
      },
      dispose() {
        rmSync(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!command || argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (!["package", "verify"].includes(command)) throw new Error(`unknown command: ${command}`);
  const values = { command };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = tokens[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    if (token === "--ui-dir") values.uiDir = resolve(value);
    else if (token === "--output-dir") values.outputDir = resolve(value);
    else if (token === "--manifest-output") values.manifestOutput = resolve(value);
    else if (token === "--manifest") values.manifestPath = resolve(value);
    else if (token === "--archive") values.archive = resolve(value);
    else if (token === "--max-archive-bytes") values.maxArchiveBytes = Number(value);
    else if (token === "--max-unpacked-bytes") values.maxUnpackedBytes = Number(value);
    else if (token === "--max-files") values.maxFiles = Number(value);
    else if (token === "--release-tag") values.releaseTag = value;
    else throw new Error(`unknown option: ${token}`);
  }
  if (!values.outputDir) throw new Error("--output-dir is required");
  if (command === "package" && !values.uiDir) throw new Error("--ui-dir is required");
  if (command === "package" && !values.releaseTag) throw new Error("--release-tag is required");
  if (command === "verify" && (!values.manifestPath || !values.archive)) throw new Error("--manifest and --archive are required");
  return values;
}

function usage() {
  return [
    "Usage:",
    "  dashboard_bundle.mjs package --ui-dir PATH --output-dir PATH --release-tag vX.Y.Z [--manifest-output PATH]",
    "  dashboard_bundle.mjs verify --manifest PATH --archive PATH --output-dir PATH",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  try {
    if (args.command === "package") {
      const limits = {
        maxArchiveBytes: boundedInt(args.maxArchiveBytes ?? 12 * 1024 * 1024, "max_archive_bytes", HARD_MAX_ARCHIVE_BYTES),
        maxUnpackedBytes: boundedInt(args.maxUnpackedBytes ?? 32 * 1024 * 1024, "max_unpacked_bytes", HARD_MAX_UNPACKED_BYTES),
        maxFiles: boundedInt(args.maxFiles ?? 96, "max_files", HARD_MAX_FILES),
        releaseTag: args.releaseTag,
      };
      const { archive, manifest } = packageUi(args.uiDir, args.outputDir, limits);
      if (args.manifestOutput) writeManifest(args.manifestOutput, manifest);
      console.log(JSON.stringify({ ok: true, archive, manifest: manifestObject(manifest) }, null, 2));
      return 0;
    }
    const manifest = loadManifest(args.manifestPath);
    const metadata = lstatSync(args.archive);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new DashboardBundleError("Dashboard bundle archive is not a safe file");
    if (metadata.size > manifest.max_archive_bytes) throw new DashboardBundleError("Dashboard bundle archive exceeds its size limit");
    if (sha256File(args.archive) !== manifest.archive_sha256) throw new DashboardBundleError("Dashboard bundle archive digest does not match");
    const digest = extractArchive(args.archive, args.outputDir, manifest);
    console.log(JSON.stringify({ ok: true, tree_sha256: digest, output_dir: resolve(args.outputDir) }, null, 2));
    return 0;
  } catch (error) {
    if (args.command === "verify" && args.outputDir && existsSync(args.outputDir)) rmSync(args.outputDir, { recursive: true, force: true });
    console.log(JSON.stringify({ ok: false, error: error.message }));
    return 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
