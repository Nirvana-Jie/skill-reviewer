// @pierre/diffs keeps a dynamic WASM fallback in its generic worker. The
// Dashboard fixes the engine to shiki-js, so a tiny inert module prevents the
// unused 600+ KiB WASM payload from entering the static bundle.
export default new Uint8Array();
