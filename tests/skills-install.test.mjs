import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "skills.cmd" : "skills",
);
const python = process.env.PYTHON ?? "python3";

const REQUIRED_FILES = [
  "SKILL.md",
  "assets/dashboard-ui-bundle.json",
  "assets/semantic-grader-contract.md",
  "references/evolution-workflow.md",
  "references/output-contract.md",
  "references/review-rubric.md",
  "references/verification-workflow.md",
  "evals/evals.json",
  "evals/fixtures/README.md",
  "evals/fixtures/ready-csv-column-renamer/SKILL.md",
  "evals/fixtures/needs-revision-meeting-note/SKILL.md",
  "evals/fixtures/not-ready-repo-cleaner/SKILL.md",
];

const FORBIDDEN_FILES = [
  "scripts/run_codex_skill_evals.py",
  "scripts/validate_local_snapshot.py",
  "evals/local-skill-review-snapshot.json",
  "evals/fixtures/ready-csv-column-renamer/expected.md",
  "evals/fixtures/needs-revision-meeting-note/expected.md",
  "evals/fixtures/not-ready-repo-cleaner/expected.md",
];

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
    },
  });
}

function expectSuccess(result, label) {
  expect(
    result.status,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sortManifest(manifest) {
  return Object.fromEntries(
    Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function fileManifest(root, current = root, manifest = {}) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      fileManifest(root, path, manifest);
      continue;
    }
    if (!entry.isFile()) continue;
    manifest[relative(root, path).split(sep).join("/")] = hashFile(path);
  }
  return sortManifest(manifest);
}

function trackedSkillManifest(repository) {
  const packageRoot = join(repository, "skills", "skill-reviewer");
  const listed = run(
    "git",
    ["ls-files", "-z", "--", "skills/skill-reviewer"],
    repository,
  );
  expectSuccess(listed, "fixture tracked skill manifest");
  const manifest = {};
  for (const tracked of listed.stdout.split("\0").filter(Boolean)) {
    const path = join(repository, ...tracked.split("/"));
    manifest[relative(packageRoot, path).split(sep).join("/")] = hashFile(path);
  }
  return sortManifest(manifest);
}

function makeRemoteFixture(root) {
  const source = join(root, "source");
  const ignoredTopLevel = new Set([
    ".git",
    ".agents",
    ".playwright-cli",
    "build",
    "coverage",
    "node_modules",
    "output",
  ]);

  cpSync(repoRoot, source, {
    recursive: true,
    filter(path) {
      const pathFromRoot = relative(repoRoot, path);
      const segments = pathFromRoot.split(sep).filter(Boolean);
      if (segments.length === 0) return true;
      if (ignoredTopLevel.has(segments[0])) return false;
      return !(segments[0] === "dashboard" && segments[1] === "dist");
    },
  });

  expectSuccess(run("git", ["init", "-q"], source), "fixture git init");
  expectSuccess(
    run("git", ["config", "user.email", "skills-install@example.invalid"], source),
    "fixture git email",
  );
  expectSuccess(
    run("git", ["config", "user.name", "Skills Install Test"], source),
    "fixture git name",
  );
  expectSuccess(run("git", ["add", "-A"], source), "fixture git add");
  expectSuccess(
    run("git", ["commit", "-qm", "test fixture"], source),
    "fixture git commit",
  );
  return {
    sourceUrl: pathToFileURL(source).href,
    sourceManifest: trackedSkillManifest(source),
  };
}

describe("skills CLI installation contract", () => {
  it(
    "installs a self-contained skill from a remote git source",
    () => {
      const root = mkdtempSync(join(tmpdir(), "skill-reviewer-skills-install-"));
      try {
        const { sourceUrl, sourceManifest } = makeRemoteFixture(root);
        const consumer = join(root, "consumer");
        mkdirSync(consumer, { recursive: true });
        expectSuccess(run("git", ["init", "-q"], consumer), "consumer git init");

        const install = run(
          skillsBin,
          [
            "add",
            sourceUrl,
            "--skill",
            "skill-reviewer",
            "--agent",
            "codex",
            "--copy",
            "--yes",
          ],
          consumer,
        );
        expectSuccess(install, "skills add");

        const installed = join(
          consumer,
          ".agents",
          "skills",
          "skill-reviewer",
        );
        for (const path of REQUIRED_FILES) {
          expect(existsSync(join(installed, path)), path).toBe(true);
        }
        for (const path of FORBIDDEN_FILES) {
          expect(existsSync(join(installed, path)), path).toBe(false);
        }
        expect(fileManifest(installed)).toEqual(sourceManifest);
        expect(existsSync(join(installed, "tests"))).toBe(false);
        expect(existsSync(join(installed, "docs"))).toBe(false);
        rmSync(join(root, "source"), { recursive: true, force: true });

        const lock = JSON.parse(
          readFileSync(join(consumer, "skills-lock.json"), "utf8"),
        );
        expect(lock.skills["skill-reviewer"].skillPath).toBe(
          "skills/skill-reviewer/SKILL.md",
        );

        const lint = run(
          python,
          [
            join(installed, "scripts", "lint_skill_package.py"),
            installed,
            "--format",
            "json",
            "--fail-on",
            "error",
          ],
          installed,
        );
        expectSuccess(lint, "installed package lint");
        expect(JSON.parse(lint.stdout).passed).toBe(true);

        expectSuccess(
          run(
            python,
            ["-m", "json.tool", join(installed, "evals", "evals.json")],
            installed,
          ),
          "installed eval manifest validation",
        );
        expectSuccess(
          run(
            python,
            [join(installed, "scripts", "skill_eval_runtime.py"), "--help"],
            installed,
          ),
          "installed eval runtime",
        );

        expect(existsSync(join(installed, "dashboard"))).toBe(false);

        const workspace = join(root, "workspace");
        mkdirSync(workspace, { recursive: true });
        writeFileSync(
          join(workspace, "dashboard-data.json"),
          JSON.stringify({
            contract: "skill-reviewer.dashboard-data",
            run: { id: "installed-package-check" },
            diffs: [],
          }),
        );
        const dashboard = run(
          python,
          [
            join(installed, "scripts", "serve_skill_dashboard.py"),
            "--workspace",
            workspace,
            "--check",
          ],
          installed,
        );
        expectSuccess(dashboard, "installed dashboard");
        expect(JSON.parse(dashboard.stdout)).toEqual(
          expect.objectContaining({
            ok: true,
            evidence_read_only: true,
            action_requests_enabled: true,
            run_id: "installed-package-check",
          }),
        );

        const launcher = run(
          python,
          [
            join(installed, "scripts", "start_skill_dashboard.py"),
            "--workspace",
            workspace,
            "--serve-existing",
            "--prepare-only",
          ],
          installed,
        );
        expectSuccess(launcher, "installed dashboard launcher");
        expect(JSON.parse(launcher.stdout)).toEqual(
          expect.objectContaining({
            ok: true,
            projected: false,
            projection_source: "existing_projection",
            run_id: "installed-package-check",
            dashboard_hosted: false,
            control_plane_started: false,
            evidence_uploaded: false,
            ui_downloaded: false,
          }),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
