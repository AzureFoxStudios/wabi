import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const isTauri = process.env.TAURI_ENV_PLATFORM ? true : false;
const enablePwaInDev = process.env.VITE_PWA_DEV === 'true';

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
		'process.env': {}
	},
	plugins: [
		sveltekit(),
		...(isTauri ? [] : [VitePWA({
			registerType: 'autoUpdate',
			devOptions: {
				enabled: enablePwaInDev
			},
			workbox: {
				navigateFallback: undefined,
				navigateFallbackDenylist: [/^\/_/, /\/[^\/.]+\.[^\/]+$/],
				runtimeCaching: [
					{
						urlPattern: /^\/api\//,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'api-cache',
							expiration: {
								maxEntries: 50,
								maxAgeSeconds: 3600
							}
						}
					},
					{
						urlPattern: ({ request, sameOrigin, url }) =>
							sameOrigin &&
							['image', 'video', 'audio'].includes(request.destination) &&
							(
								url.pathname.startsWith('/uploads/') ||
								/^\/api\/whiteboard\/boards\/[^/]+\/files\//.test(url.pathname)
							),
						handler: 'StaleWhileRevalidate',
						options: {
							cacheName: 'media-assets-cache',
							cacheableResponse: {
								statuses: [200]
							},
							expiration: {
								maxEntries: 300,
								maxAgeSeconds: 7 * 24 * 60 * 60
							}
						}
					}
				]
			},
			manifest: {
				name: 'Wabi',
				short_name: 'Wabi',
				description: 'Ephemeral chat with screen sharing and business features',
				start_url: '/',
				display: 'standalone',
				background_color: '#1a1a1a',
				theme_color: '#1a1a1a',
				icons: [
					{
						src: '/icon-192.png',
						sizes: '192x192',
						type: 'image/png'
					},
					{
						src: '/icon-512.png',
						sizes: '512x512',
						type: 'image/png'
					},
					{
						src: '/icon-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any maskable' // Added for better Android support
					}
				]
			}
		})])
	]
});
