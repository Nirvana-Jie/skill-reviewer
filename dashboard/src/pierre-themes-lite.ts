import {
  createThemeCollection,
  type ThemeDescriptor,
  type ThemeLike,
} from "@pierre/theming";
import { normalizeTheme } from "@shikijs/core";

interface CreateThemeOptions {
  name: string;
  load: () => Promise<unknown>;
  colorScheme?: "light" | "dark";
  collection?: string;
  displayName?: string;
}

function unwrapDefault(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "default" in value
  ) {
    return (value as { default: unknown }).default;
  }
  return value;
}

export function createTheme<TTheme extends ThemeLike = ThemeLike>({
  name,
  load,
  colorScheme,
  collection,
  displayName,
}: CreateThemeOptions): ThemeDescriptor<TTheme> {
  return {
    name,
    colorScheme,
    collection,
    displayName,
    load: async () =>
      normalizeTheme(
        unwrapDefault(await load()) as Parameters<typeof normalizeTheme>[0],
      ) as unknown as TTheme,
  };
}

export const pierreThemes = createThemeCollection({
  themes: [
    createTheme({
      name: "pierre-light",
      collection: "pierre",
      colorScheme: "light",
      displayName: "Pierre Light",
      load: () => import("@pierre/theme/pierre-light"),
    }),
    createTheme({
      name: "pierre-dark",
      collection: "pierre",
      colorScheme: "dark",
      displayName: "Pierre Dark",
      load: () => import("@pierre/theme/pierre-dark"),
    }),
  ],
});

// The Dashboard does not expose arbitrary Shiki themes. Keep the collection
// API because @pierre/diffs uses it for custom-theme registration.
export const shikiThemes = createThemeCollection<ThemeLike>({ themes: [] });
export const themes = createThemeCollection({
  themes: [pierreThemes, shikiThemes],
});
