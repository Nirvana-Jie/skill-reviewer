import {
  createBundledHighlighter,
  createCssVariablesTheme,
  createSingletonShorthands,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

// @pierre/diffs resolves languages by name at runtime. Keep that API surface,
// but expose only the file types the Dashboard can actually render. Importing
// Shiki's default bundle would otherwise publish every grammar and theme.
export const bundledLanguages = {
  shellscript: () => import("@shikijs/langs/shellscript"),
  javascript: () => import("@shikijs/langs/javascript"),
  css: () => import("@shikijs/langs/css"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  yaml: () => import("@shikijs/langs/yaml"),
};

export const bundledThemes = {};

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: createJavaScriptRegexEngine,
});

const shorthands = createSingletonShorthands(createHighlighter);

export const codeToHast = shorthands.codeToHast;
export const codeToHtml = shorthands.codeToHtml;
export const codeToTokens = shorthands.codeToTokens;
export const codeToTokensBase = shorthands.codeToTokensBase;
export const codeToTokensWithThemes = shorthands.codeToTokensWithThemes;
export const getLastGrammarState = shorthands.getLastGrammarState;
export const getSingletonHighlighter = shorthands.getSingletonHighlighter;

export { createCssVariablesTheme, createJavaScriptRegexEngine };

export function createOnigurumaEngine(): never {
  throw new Error(
    "The Dashboard disables the Shiki WASM engine; use the JavaScript regex engine.",
  );
}
