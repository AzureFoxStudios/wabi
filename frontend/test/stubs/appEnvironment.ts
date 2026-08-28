// Runtime stub for bun:test resolution — Vite/SvelteKit provides the real
// module in dev/build. Values mirror an SSR (non-browser) context; suites
// that need browser:true mock it explicitly.
export const browser = false;
export const dev = false;
export const building = false;
export const prerendering = false;
export const ssr = true;
export const version = {};
