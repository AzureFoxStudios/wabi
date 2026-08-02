<script lang="ts">
	import '../styles/styles.css';
	import '$lib/prism-theme.css';
	import 'katex/dist/katex.min.css';
	import { onMount, onDestroy } from 'svelte';
	import { channelMessages, channels } from '$lib/socket';
	import PureRefViewer from '$lib/components/PureRefViewer.svelte';
	import SyncLoadingOverlay from '$lib/components/SyncLoadingOverlay.svelte';
	import CallView from '$lib/components/CallView.svelte';
	import { isRunningInTauri, startAutoSaveTauri, type WabiData } from '$lib/tauri-storage';
	import { migrateTauriData, loadMigratedTauriData } from '$lib/tauri-migration';
	import { chatStorage } from '$lib/storage';
	import { get } from 'svelte/store';
	import { initI18n } from '$lib/i18n';
	import { openWabiDB, getWabiDB } from '$lib/wabidb';
import { drainOutboundQueue } from '$lib/wabidb/drain';

	import { updated } from '$app/stores';
	import { initRelaySelector } from '$lib/relaySelector';
	import { startupMark, startupMeasure } from '$lib/startupProfiler';
	import { initEmojis } from '$lib/emoji-store';
	import AmbientBackground from '$lib/effects/AmbientBackground.svelte';
	import ConnectionBadge from '$lib/effects/ConnectionBadge.svelte';
	import { startSocketErrorToasts, socketToasts } from '$lib/socketErrorToasts';

	initI18n();
	startSocketErrorToasts();

let cleanupAutoSave: (() => void) | null = null;
let relayInitTimer: ReturnType<typeof setTimeout> | null = null;
let onlineHandler: (() => void) | null = null;

function isLocalPreviewHost(): boolean {
	if (typeof window === 'undefined') return false;
	const { hostname } = window.location;
	if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
		return true;
	}
	if (/^10\.\d+\.\d+\.\d+$/.test(hostname) || /^192\.168\.\d+\.\d+$/.test(hostname)) {
		return true;
	}
	if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(hostname)) {
		return true;
	}
	return hostname.endsWith('.localhost') || hostname.endsWith('.local');
}

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

		void initEmojis();

		// Register service worker for PWA support (browser/PWA only, not Tauri webview)
		if ('serviceWorker' in navigator && !isRunningInTauri() && isLocalPreviewHost()) {
			try {
				const localResetKey = 'wabi.local-preview-cache-reset.v2';
				const registrations = await navigator.serviceWorker.getRegistrations();
				await Promise.all(registrations.map((registration) => registration.unregister()));
				const cacheKeys =
					typeof window !== 'undefined' && 'caches' in window
						? await caches.keys()
						: [];
				await Promise.all(cacheKeys.map((key) => caches.delete(key)));
				if (
					(registrations.length > 0 || cacheKeys.length > 0) &&
					typeof window !== 'undefined' &&
					window.sessionStorage.getItem(localResetKey) !== '1'
				) {
					window.sessionStorage.setItem(localResetKey, '1');
					window.location.reload();
					return;
				}
			} catch (error) {
				console.warn('Failed to clear local preview service workers:', error);
			}
		} else if (import.meta.env.PROD && 'serviceWorker' in navigator && !isRunningInTauri()) {
			startupMark('layout:sw:register:start');
			navigator.serviceWorker.register(`/sw.js?v=${__WABI_SW_VERSION__}`).then((registration) => {
				console.log('✅ Service Worker registered:', registration);
				void registration.update();
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

		// Initialize WabiDB (client-side offline persistence)
		try {
			await openWabiDB();
			const wabiDB = getWabiDB();
			if (wabiDB) {
				wabiDB.retryFailed();
				onlineHandler = () => {
					const db = getWabiDB();
					if (db) { void db.retryFailed(); void drainOutboundQueue(); }
				};
				window.addEventListener('online', onlineHandler);
			}
		} catch (error) {
			console.warn('[Layout] WabiDB init failed:', error);
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
		if (onlineHandler) {
			window.removeEventListener('online', onlineHandler);
			onlineHandler = null;
		}
	});
</script>

<AmbientBackground />
<div class="app-content-layer">
	<ConnectionBadge />

	<!-- CallView re-enabled in 2026-06-15 frontend cleanup pass. IncomingCallModal
	     is mounted by CallModal.svelte (it requires call-scoped props). -->
	<CallView />

	<PureRefViewer />

	<SyncLoadingOverlay />

	{#if $socketToasts.length}
		<div class="socket-toast-stack" role="status" aria-live="polite">
			{#each $socketToasts as t (t.id)}
				<div class="socket-toast">{t.message}</div>
			{/each}
		</div>
	{/if}

	<slot />
</div>

<style>
	/* Keep the ambient effect canvas painted behind all app UI.
	   The canvas is position:fixed; z-index:0, so this layer must sit
	   above it for effects to read as a background, not draw over content. */
	.app-content-layer {
		position: relative;
		z-index: 1;
	}
	.socket-toast-stack {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 9999;
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: min(360px, calc(100vw - 32px));
		pointer-events: none;
	}
	.socket-toast {
		background: rgba(15, 23, 42, 0.94);
		color: #f8fafc;
		border: 1px solid rgba(248, 113, 113, 0.45);
		border-radius: 10px;
		padding: 10px 14px;
		font-size: 13px;
		line-height: 1.35;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
	}
</style>
