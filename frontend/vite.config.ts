import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const isTauri = process.env.TAURI_ENV_PLATFORM ? true : false;
const browserTargets = ['edge88', 'firefox78', 'chrome87', 'safari13.1'];

export default defineConfig({
	// Tauri requires specific builder config
	build: {
		target: isTauri ? 'ES2021' : ['ES2020', ...browserTargets],
		// Vite 8 uses Lightning CSS, whose targets must be browsers rather than ES versions.
		cssTarget: browserTargets,
		minify: !process.env.TAURI_DEBUG, // esbuild minify (terser broke Svelte store runtime in SPA client bundle)
		// AudioWorklet processors referenced via `new URL(..., import.meta.url)`
		// must stay real files. Below the default 4KB threshold Vite inlines
		// assets as base64 data: URLs, and addModule() loads them under the
		// page's script-src CSP — which wabi.chat's does not allow, so Firefox
		// aborted every load and dropped every incoming audio frame
		// (2026-09-03 no-audio incident). Never inline worklet modules; all
		// other assets keep the default 4KB behavior (undefined = default).
		assetsInlineLimit: (filePath: string) => (filePath.includes('worklet') ? false : undefined)
	},
	server: {
		// Plain localhost only. If you need a public URL, set PUBLIC_URL env
		// var to your own domain — don't hardcode ngrok or any other tunnel.
		allowedHosts: [
			'localhost',
			'127.0.0.1',
			process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : null
		].filter(Boolean) as string[],
		// In dev the frontend expects the local wabi-server on its default
		// port. Set VITE_SOCKET_URL in the environment to point elsewhere.
		// (frontend/src/lib/serverUrl.ts picks this up.)
		host: '0.0.0.0',
		port: 5173
	},
	define: {
		'process.env': {},
		'__WABI_SW_VERSION__': JSON.stringify('10'),
		'__WABI_IS_TAURI__': JSON.stringify(isTauri)
	},
	plugins: [
		sveltekit()
		// PWA handled by static/sw.js — no vite-plugin-pwa dependency
	]
});
