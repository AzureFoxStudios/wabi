/**
 * opus-recorder asset typings.
 *
 * The decoder worker ships as TWO files: `decoderWorker.min.js` (Emscripten
 * glue) and `decoderWorker.min.wasm` (the actual decoder). The glue resolves
 * the wasm at runtime as a SIBLING file of the worker script — Vite emits
 * the worker JS as a hashed asset but never the sibling wasm, so on a built
 * site the wasm request falls through to the SPA fallback (index.html,
 * text/html) and the worker aborts with "wasm validation error: failed to
 * match magic number". We therefore import both files explicitly:
 *  - the wasm via `?url` (hashed asset, served with application/wasm), and
 *  - the worker source via `?raw` so we can prepend a `Module.locateFile`
 *    prelude (see wabidbMediaRelay.ts) pointing the glue at that URL.
 */
declare module 'opus-recorder/dist/decoderWorker.min.js?raw' {
	const source: string;
	export default source;
}

declare module 'opus-recorder/dist/decoderWorker.min.wasm?url' {
	const url: string;
	export default url;
}
