import type { KeyboardEvent } from "react";

export function handleRovingListKeyDown(
  event: KeyboardEvent<HTMLElement>,
  orientation: "horizontal" | "vertical" = "vertical",
): void {
  const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-roving-item]"),
  ).filter((item) => !item.hasAttribute("disabled"));
  if (!items.length) return;

  const currentIndex = Math.max(items.indexOf(document.activeElement as HTMLElement), 0);
  let nextIndex = currentIndex;
  if (event.key === previousKey) nextIndex = Math.max(currentIndex - 1, 0);
  if (event.key === nextKey) nextIndex = Math.min(currentIndex + 1, items.length - 1);
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = items.length - 1;

  event.preventDefault();
  items[nextIndex]?.focus();
}
