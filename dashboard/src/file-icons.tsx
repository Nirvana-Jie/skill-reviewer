import {
  BracketsOrange,
  BracketsYellow,
  Csv,
  Document,
  Docker,
  Gear,
  Git,
  Ignore,
  Js,
  JsTest,
  License,
  Lock,
  Markdown,
  NPM,
  PNPM,
  PostCSS,
  Python,
  Reactjs,
  ReactTest,
  Reactts,
  Sass,
  Shell,
  SVG,
  TsTest,
  Tsconfig,
  TypeScript,
  Vite,
  Vitest,
  XML,
  Yaml,
} from "@react-symbols/icons/files";
import {
  Folder,
  FolderAssets,
  FolderBlueCode,
  FolderBuild,
  FolderConfig,
  FolderDocuments,
  FolderGreenCode,
  FolderNodeModules,
  FolderOpen,
  FolderPurple,
  FolderReact,
  FolderSrc,
  FolderYellowCode,
} from "@react-symbols/icons/folders";
import type { ComponentType, SVGProps } from "react";

type SymbolComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type FileSymbolKind =
  | "config"
  | "csv"
  | "docker"
  | "document"
  | "git"
  | "ignore"
  | "javascript"
  | "javascript-test"
  | "json"
  | "license"
  | "lock"
  | "markdown"
  | "markup"
  | "npm"
  | "pnpm"
  | "python"
  | "react"
  | "react-test"
  | "shell"
  | "style"
  | "svg"
  | "typescript"
  | "typescript-test"
  | "tsconfig"
  | "vite"
  | "vitest"
  | "xml"
  | "yaml";

export type FolderSymbolKind =
  | "assets"
  | "build"
  | "config"
  | "dependencies"
  | "documents"
  | "evals"
  | "folder"
  | "react"
  | "scripts"
  | "source"
  | "tests";

interface SymbolDescriptor<Kind extends string> {
  kind: Kind;
  Icon: SymbolComponent;
}

const fileByExtension: Record<string, SymbolDescriptor<FileSymbolKind>> = {
  bash: { kind: "shell", Icon: Shell },
  cjs: { kind: "javascript", Icon: Js },
  conf: { kind: "config", Icon: Gear },
  css: { kind: "style", Icon: PostCSS },
  csv: { kind: "csv", Icon: Csv },
  htm: { kind: "markup", Icon: BracketsOrange },
  html: { kind: "markup", Icon: BracketsOrange },
  ini: { kind: "config", Icon: Gear },
  js: { kind: "javascript", Icon: Js },
  json: { kind: "json", Icon: BracketsYellow },
  jsonc: { kind: "json", Icon: BracketsYellow },
  jsonl: { kind: "json", Icon: BracketsYellow },
  jsx: { kind: "react", Icon: Reactjs },
  less: { kind: "style", Icon: PostCSS },
  lock: { kind: "lock", Icon: Lock },
  md: { kind: "markdown", Icon: Markdown },
  mdx: { kind: "markdown", Icon: Markdown },
  mjs: { kind: "javascript", Icon: Js },
  py: { kind: "python", Icon: Python },
  sass: { kind: "style", Icon: Sass },
  scss: { kind: "style", Icon: Sass },
  sh: { kind: "shell", Icon: Shell },
  svg: { kind: "svg", Icon: SVG },
  toml: { kind: "config", Icon: Gear },
  ts: { kind: "typescript", Icon: TypeScript },
  tsv: { kind: "csv", Icon: Csv },
  tsx: { kind: "react", Icon: Reactts },
  xml: { kind: "xml", Icon: XML },
  yaml: { kind: "yaml", Icon: Yaml },
  yml: { kind: "yaml", Icon: Yaml },
  zsh: { kind: "shell", Icon: Shell },
};

const genericFile: SymbolDescriptor<FileSymbolKind> = {
  kind: "document",
  Icon: Document,
};

function basename(path: string): string {
  return path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
}

function extensionOf(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1);
}

function testDescriptor(name: string): SymbolDescriptor<FileSymbolKind> | null {
  if (!/\.(?:test|spec)\.[^.]+$/.test(name)) return null;
  const extension = extensionOf(name);
  if (extension === "tsx" || extension === "jsx") {
    return { kind: "react-test", Icon: ReactTest };
  }
  if (extension === "ts") {
    return { kind: "typescript-test", Icon: TsTest };
  }
  if (["js", "mjs", "cjs"].includes(extension)) {
    return { kind: "javascript-test", Icon: JsTest };
  }
  return null;
}

export function fileSymbolDescriptor(
  path: string,
): SymbolDescriptor<FileSymbolKind> {
  const name = basename(path);
  if (name === "package.json") return { kind: "npm", Icon: NPM };
  if (name === "pnpm-lock.yaml") return { kind: "pnpm", Icon: PNPM };
  if (/^vite\.config\.[^.]+$/.test(name)) return { kind: "vite", Icon: Vite };
  if (/^vitest\.config\.[^.]+$/.test(name)) {
    return { kind: "vitest", Icon: Vitest };
  }
  if (/^tsconfig(?:\.[^.]+)?\.json$/.test(name)) {
    return { kind: "tsconfig", Icon: Tsconfig };
  }
  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return { kind: "docker", Icon: Docker };
  }
  if (name === ".gitignore") return { kind: "ignore", Icon: Ignore };
  if (name === ".gitattributes" || name === ".gitmodules") {
    return { kind: "git", Icon: Git };
  }
  if (/^(?:license|licence)(?:\..+)?$/.test(name)) {
    return { kind: "license", Icon: License };
  }
  const test = testDescriptor(name);
  if (test) return test;
  return fileByExtension[extensionOf(name)] ?? genericFile;
}

const folderByName: Record<string, SymbolDescriptor<FolderSymbolKind>> = {
  ".github": { kind: "config", Icon: FolderConfig },
  assets: { kind: "assets", Icon: FolderAssets },
  build: { kind: "build", Icon: FolderBuild },
  config: { kind: "config", Icon: FolderConfig },
  dashboard: { kind: "react", Icon: FolderReact },
  dist: { kind: "build", Icon: FolderBuild },
  docs: { kind: "documents", Icon: FolderDocuments },
  evals: { kind: "evals", Icon: FolderPurple },
  fixtures: { kind: "assets", Icon: FolderAssets },
  node_modules: { kind: "dependencies", Icon: FolderNodeModules },
  public: { kind: "assets", Icon: FolderAssets },
  references: { kind: "documents", Icon: FolderDocuments },
  scripts: { kind: "scripts", Icon: FolderGreenCode },
  src: { kind: "source", Icon: FolderSrc },
  test: { kind: "tests", Icon: FolderYellowCode },
  tests: { kind: "tests", Icon: FolderYellowCode },
  __tests__: { kind: "tests", Icon: FolderYellowCode },
};

export function folderSymbolDescriptor(
  name: string,
  expanded: boolean,
): SymbolDescriptor<FolderSymbolKind> {
  const descriptor = folderByName[name.toLowerCase()];
  if (descriptor) return descriptor;
  return { kind: "folder", Icon: expanded ? FolderOpen : Folder };
}

function HiddenSymbol({ Icon }: { Icon: SymbolComponent }) {
  return (
    <Icon
      width={16}
      height={16}
      aria-hidden="true"
      focusable="false"
    />
  );
}

export function FileTypeIcon({ path }: { path: string }) {
  const { kind, Icon } = fileSymbolDescriptor(path);
  return (
    <span
      className="diff-file-icon"
      data-file-icon={kind}
      aria-hidden="true"
    >
      <HiddenSymbol Icon={Icon} />
    </span>
  );
}

export function FolderTypeIcon({
  name,
  expanded,
}: {
  name: string;
  expanded: boolean;
}) {
  const { kind, Icon } = folderSymbolDescriptor(name, expanded);
  return (
    <span
      className="diff-folder-icon"
      data-folder-icon={kind}
      aria-hidden="true"
    >
      <HiddenSymbol Icon={Icon} />
    </span>
  );
}

export function RootFolderIcon() {
  return (
    <span
      className="diff-folder-icon diff-root-icon"
      data-folder-icon="root"
      aria-hidden="true"
    >
      <HiddenSymbol Icon={FolderBlueCode} />
    </span>
  );
}
