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
		allowedHosts: [
		'localhost',
		'.ngrok-free.dev',
		'wabi.onrender.com',
		process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : null
	].filter(Boolean) as string[]
	},
	define: {
		'process.env': {},
		'__WABI_SW_VERSION__': JSON.stringify('7')
	},
	plugins: [
		sveltekit()
		// PWA handled by static/sw.js — no vite-plugin-pwa dependency
	]
});
