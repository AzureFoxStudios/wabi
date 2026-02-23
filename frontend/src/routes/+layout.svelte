<script lang="ts">
	import '../app.css';
	import '$lib/prism-theme.css';
	import { onMount, onDestroy } from 'svelte';
	import { channelMessages, channels } from '$lib/socket';
	import PureRefViewer from '$lib/components/PureRefViewer.svelte';
	import { isRunningInTauri, startAutoSaveTauri, type WabiData } from '$lib/tauri-storage';
	import { migrateTauriData, loadMigratedTauriData } from '$lib/tauri-migration';
	import { chatStorage } from '$lib/storage';
	import { get } from 'svelte/store';
	import { initI18n } from '$lib/i18n';

	import { updated } from '$app/stores';
	import { initRelaySelector } from '$lib/relaySelector';
	import { startupMark, startupMeasure } from '$lib/startupProfiler';

	initI18n();

	let cleanupAutoSave: (() => void) | null = null;
	let relayInitTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleNonCritical(task: () => void, timeout = 1500): void {
		if (typeof window === 'undefined') return;
		const ric = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
		if (ric) {
			ric(task, { timeout });
			return;
		}
		relayInitTimer = setTimeout(task, 0);
	}

	onMount(async () => {
		startupMark('layout:onMount:start');
		// Register service worker for PWA support (browser/PWA only, not Tauri webview)
		if (import.meta.env.PROD && 'serviceWorker' in navigator && !isRunningInTauri()) {
			startupMark('layout:sw:register:start');
			navigator.serviceWorker.register('/sw.js').then((registration) => {
				console.log('✅ Service Worker registered:', registration);
				startupMark('layout:sw:register:end');
				startupMeasure('layout:sw:register', 'layout:sw:register:start', 'layout:sw:register:end');
			}).catch((error) => {
				console.error('❌ Service Worker registration failed:', error);
				startupMark('layout:sw:register:end');
				startupMeasure('layout:sw:register', 'layout:sw:register:start', 'layout:sw:register:end');
			});
		}

		// Initialize relay selector in idle time (can trigger network+latency probes).
		scheduleNonCritical(() => {
			startupMark('layout:relay:init:start');
			void initRelaySelector().finally(() => {
				startupMark('layout:relay:init:end');
				startupMeasure('layout:relay:init', 'layout:relay:init:start', 'layout:relay:init:end');
			});
		});

		// NOTE: Socket initialization is handled ONLY by +page.svelte
		// This prevents duplicate connections when both layout and page mount

		// Initialize Tauri features if running in Tauri
		if (isRunningInTauri()) {
			console.log('[Layout] Tauri detected');
			startupMark('layout:tauri:init:start');

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
			startupMark('layout:tauri:init:end');
			startupMeasure('layout:tauri:init', 'layout:tauri:init:start', 'layout:tauri:init:end');
		}
		startupMark('layout:onMount:end');
		startupMeasure('layout:onMount', 'layout:onMount:start', 'layout:onMount:end');
	});

	onDestroy(() => {
		// Clean up auto-save on app shutdown
		if (cleanupAutoSave) {
			cleanupAutoSave();
		}
		if (relayInitTimer) {
			clearTimeout(relayInitTimer);
			relayInitTimer = null;
		}
	});
</script>

<!-- Calling components disabled - re-enable after testing basic functionality -->
<!-- <IncomingCallModal /> -->
<!-- <CallView /> -->

<PureRefViewer />

<slot />
