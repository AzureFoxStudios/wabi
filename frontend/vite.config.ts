import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const isTauri = process.env.TAURI_ENV_PLATFORM ? true : false;

export default defineConfig({
	// Tauri requires specific builder config
	build: {
		target: isTauri ? 'ES2021' : ['ES2020', 'edge88', 'firefox78', 'chrome87', 'safari13.1'],
		minify: !process.env.TAURI_DEBUG ? 'terser' : false,
		terserOptions: {
			compress: {
				drop_console: !process.env.TAURI_DEBUG
			}
		}
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
		'__WABI_SW_VERSION__': JSON.stringify('8'),
		'__WABI_IS_TAURI__': JSON.stringify(isTauri)
	},
	plugins: [
		sveltekit()
		// PWA handled by static/sw.js — no vite-plugin-pwa dependency
	]
});
