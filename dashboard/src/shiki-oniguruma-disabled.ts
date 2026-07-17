export function createOnigurumaEngine(): never {
  throw new Error(
    "The Dashboard disables the Shiki WASM engine; use the JavaScript regex engine.",
  );
}
