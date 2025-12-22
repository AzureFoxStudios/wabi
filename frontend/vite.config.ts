import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
	server: {
		allowedHosts: ['ungruff-subtarsal-libby.ngrok-free.dev', 'wabi.onrender.com']
	},
	define: {
		'process.env': {}
	},
	plugins: [
		sveltekit(),
		VitePWA({
			registerType: 'autoUpdate',
			devOptions: {
				enabled: true // This enables PWA features in dev mode
			},
			manifest: {
				name: 'Community Chat',
				short_name: 'Chat',
				description: 'Self-hosted ephemeral chat with screen sharing',
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
		})
	]
});
