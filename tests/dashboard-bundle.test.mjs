import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { materializeDashboardUi } from "../skills/skill-reviewer/scripts/dashboard_bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleScript = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "dashboard_bundle.mjs",
);

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function run(args) {
  return spawnSync(process.execPath, [bundleScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createFixtureArchive(path, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content ?? "x");
    const compression = entry.compression ?? 0;
    const payload = compression === 8 ? deflateRawSync(content) : content;
    const declaredSize = entry.declaredSize ?? content.length;
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compression, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compression, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? (0o100000 | 0o644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...localParts, centralDirectory, end]));
}

function expectSuccess(result, label) {
  expect(
    result.status,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeManifest(path, archive, treeDigest = "0".repeat(64)) {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        contract: "skill-reviewer.dashboard-ui-bundle",
        asset_url:
          "https://github.com/Nirvana-Jie/skill-reviewer/releases/download/" +
          `dashboard-ui-assets/dashboard-ui-${treeDigest}.zip`,
        archive_sha256: sha256(archive),
        tree_sha256: treeDigest,
        entrypoint: "index.html",
        max_archive_bytes: 12 * 1024 * 1024,
        max_unpacked_bytes: 32 * 1024 * 1024,
        max_files: 96,
      },
      null,
      2,
    )}\n`,
  );
}

describe("temporary Dashboard UI bundle", () => {
  it("creates a deterministic content-addressed archive and safely extracts it", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-bundle-"));
    try {
      const ui = join(root, "ui");
      write(ui, "index.html", "<!doctype html><script src=\"/assets/app.js\"></script>");
      write(ui, "favicon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
      write(ui, "assets/app.js", "document.title = 'Skill Reviewer';\n");
      write(ui, "assets/app.css", ":root { color-scheme: light dark; }\n");

      const firstOutput = join(root, "first");
      const firstManifest = join(root, "first-manifest.json");
      const first = run([
        "package",
        "--ui-dir",
        ui,
        "--output-dir",
        firstOutput,
        "--manifest-output",
        firstManifest,
      ]);
      expectSuccess(first, "first package");
      const firstReport = JSON.parse(first.stdout);
      const firstArchive = firstReport.archive;

      const secondOutput = join(root, "second");
      const secondManifest = join(root, "second-manifest.json");
      const second = run([
        "package",
        "--ui-dir",
        ui,
        "--output-dir",
        secondOutput,
        "--manifest-output",
        secondManifest,
      ]);
      expectSuccess(second, "second package");
      const secondArchive = JSON.parse(second.stdout).archive;

      expect(readFileSync(firstArchive)).toEqual(readFileSync(secondArchive));
      expect(readFileSync(firstManifest, "utf8")).toBe(
        readFileSync(secondManifest, "utf8"),
      );
      expect(firstReport.manifest.asset_url).toContain(
        `dashboard-ui-${firstReport.manifest.tree_sha256}.zip`,
      );

      const extracted = join(root, "extracted");
      const verified = run([
        "verify",
        "--manifest",
        firstManifest,
        "--archive",
        firstArchive,
        "--output-dir",
        extracted,
      ]);
      expectSuccess(verified, "bundle verify");
      expect(readFileSync(join(extracted, "assets", "app.js"), "utf8")).toContain(
        "Skill Reviewer",
      );
      expect(existsSync(join(extracted, "dashboard-data.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to package evidence or other unexpected files with the UI", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-bundle-"));
    try {
      const ui = join(root, "ui");
      write(ui, "index.html", "<!doctype html>");
      write(ui, "dashboard-data.json", '{"secret":"must stay local"}');

      const result = run([
        "package",
        "--ui-dir",
        ui,
        "--output-dir",
        join(root, "output"),
      ]);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toMatch(/unexpected file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes a verified temporary UI when its Dashboard session exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-bundle-"));
    try {
      const ui = join(root, "ui");
      write(ui, "index.html", "<!doctype html><title>temporary</title>");
      const output = join(root, "bundle");
      const manifest = join(root, "manifest.json");
      const packaged = run([
        "package",
        "--ui-dir",
        ui,
        "--output-dir",
        output,
        "--manifest-output",
        manifest,
      ]);
      expectSuccess(packaged, "temporary package");
      const archive = JSON.parse(packaged.stdout).archive;
      const materialized = await materializeDashboardUi({
        manifestPath: manifest,
        download: async (_manifest, destination) => copyFileSync(archive, destination),
      });
      const temporaryUi = materialized.ui.root;
      expect(materialized.ui).toEqual(expect.objectContaining({
        temporary: true,
        integrity_verified: true,
      }));
      expect(existsSync(temporaryUi)).toBe(true);
      materialized.dispose();
      expect(existsSync(temporaryUi)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["traversal", "symlink", "casefold-duplicate", "unexpected-directory"])(
    "rejects a malicious %s archive before materialization",
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-bundle-"));
      try {
        const archive = join(root, `${kind}.zip`);
        const entries = [{ name: "index.html", content: "<!doctype html>" }];
        if (kind === "traversal") entries.push({ name: "../escape.js" });
        else if (kind === "symlink") entries.push({ name: "assets/link.js", content: "index.html", mode: 0o120777 });
        else if (kind === "casefold-duplicate") entries.push({ name: "assets/Main.js" }, { name: "assets/main.js" });
        else entries.push({ name: "docs/", content: "", mode: 0o040755 });
        createFixtureArchive(archive, entries);
        const manifest = join(root, "manifest.json");
        writeManifest(manifest, archive);
        const output = join(root, "output");

        const result = run([
          "verify",
          "--manifest",
          manifest,
          "--archive",
          archive,
          "--output-dir",
          output,
        ]);
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stdout).ok).toBe(false);
        expect(existsSync(output)).toBe(false);
        expect(existsSync(join(root, "escape.js"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("bounds deflate output by the declared entry size before materialization", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-reviewer-dashboard-bundle-"));
    try {
      const archive = join(root, "oversized-deflate.zip");
      createFixtureArchive(archive, [{
        name: "index.html",
        content: "x".repeat(1024 * 1024),
        compression: 8,
        declaredSize: 32,
      }]);
      const manifest = join(root, "manifest.json");
      writeManifest(manifest, archive);

      const result = run([
        "verify",
        "--manifest",
        manifest,
        "--archive",
        archive,
        "--output-dir",
        join(root, "output"),
      ]);

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toMatch(/archive is invalid|entry size/);
      expect(existsSync(join(root, "output"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
