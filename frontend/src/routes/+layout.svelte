<script lang="ts">
	import '../app.css';
	import '$lib/prism-theme.css';
	import type { PageData } from './$types';
	import { onMount, onDestroy } from 'svelte';
	import { initSocket, channelMessages, channels } from '$lib/socket';
  import PureRefViewer from '$lib/components/PureRefViewer.svelte';
	import { isRunningInTauri, startAutoSaveTauri, type WabiData } from '$lib/tauri-storage';
	import { migrateTauriData, loadMigratedTauriData } from '$lib/tauri-migration';
	import { chatStorage } from '$lib/storage';
	import { get } from 'svelte/store';

	// Accept data prop to suppress warning (we don't use it in root layout)
	export let data: PageData;

	let cleanupAutoSave: (() => void) | null = null;

	onMount(async () => {
		// Register service worker for PWA support
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').then((registration) => {
				console.log('✅ Service Worker registered:', registration);
			}).catch((error) => {
				console.error('❌ Service Worker registration failed:', error);
			});
		}

		// Only initialize socket if user has a saved session (from explicit login)
		// Don't auto-login on page load - user must submit login form first
		const username = localStorage.getItem('username');
		const sessionId = localStorage.getItem('sessionId');

		if (username && sessionId) {
			// User has a saved session, reconnect them
			initSocket(username);
		}

		// Initialize Tauri features if running in Tauri
		if (isRunningInTauri()) {
			console.log('[Layout] Tauri detected');

			// Check if user has enabled Tauri storage
			const tauriStorageEnabled = localStorage.getItem('tauriStorageEnabled') === 'true';

			if (tauriStorageEnabled) {
				console.log('[Layout] Tauri storage enabled, initializing...');

				// Run migration if needed
				const migrated = await migrateTauriData();
				if (migrated) {
					console.log('[Layout] Data migrated from IndexedDB to Tauri storage');
					// Load the migrated data to verify
					await loadMigratedTauriData();
				}

				// Create a data getter function that collects all current data
				const getDataFunction = (): WabiData => {
					// Get all current stores
					const messages = get(channelMessages);
					const channelsList = get(channels);

					return {
						version: '1.0',
						exported_at: Date.now(),
						messages,
						settings: {
							channels: channelsList,
							// Add more settings as needed
						}
					};
				};

				// Start auto-save with 30 second interval
				cleanupAutoSave = startAutoSaveTauri(getDataFunction, 30000);
			} else {
				console.log('[Layout] Tauri storage not enabled - skipping auto-save');
			}
		}
	});

	onDestroy(() => {
		// Clean up auto-save on app shutdown
		if (cleanupAutoSave) {
			cleanupAutoSave();
		}
	});
</script>

<!-- Calling components disabled - re-enable after testing basic functionality -->
<!-- <IncomingCallModal /> -->
<!-- <CallView /> -->

<PureRefViewer />

<slot />
