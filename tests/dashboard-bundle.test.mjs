import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleScript = join(
  repoRoot,
  "skills",
  "skill-reviewer",
  "scripts",
  "dashboard_bundle.py",
);
const python = process.env.PYTHON ?? "python3";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function run(args) {
  return spawnSync(python, [bundleScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
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

  it("removes a verified temporary UI when its control-plane context exits", () => {
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
      const scriptsRoot = join(repoRoot, "skills", "skill-reviewer", "scripts");
      const materialized = spawnSync(
        python,
        [
          "-c",
          String.raw`
import json, pathlib, shutil, sys
sys.path.insert(0, sys.argv[1])
import dashboard_bundle as bundle
archive = pathlib.Path(sys.argv[2])
manifest = pathlib.Path(sys.argv[3])
bundle.download_archive = lambda _manifest, destination: shutil.copyfile(archive, destination)
with bundle.materialize_dashboard_ui(manifest_path=manifest) as ui:
    root = ui.root
    assert ui.temporary and ui.integrity_verified and root.is_dir()
assert not root.exists()
print(json.dumps({"removed": True}))
`,
          scriptsRoot,
          archive,
          manifest,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(materialized.status, materialized.stderr).toBe(0);
      expect(JSON.parse(materialized.stdout)).toEqual({ removed: true });
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
        const createArchive = spawnSync(
          python,
          [
            "-c",
            String.raw`
import stat, sys, zipfile
archive, kind = sys.argv[1:]
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
    def add(name, content=b"x", mode=stat.S_IFREG | 0o644):
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = mode << 16
        bundle.writestr(info, content)
    add("index.html", b"<!doctype html>")
    if kind == "traversal":
        add("../escape.js")
    elif kind == "symlink":
        add("assets/link.js", b"index.html", stat.S_IFLNK | 0o777)
    elif kind == "casefold-duplicate":
        add("assets/Main.js")
        add("assets/main.js")
    else:
        add("docs/", b"", stat.S_IFDIR | 0o755)
`,
            archive,
            kind,
          ],
          { cwd: repoRoot, encoding: "utf8" },
        );
        expect(createArchive.status, createArchive.stderr).toBe(0);
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
});
