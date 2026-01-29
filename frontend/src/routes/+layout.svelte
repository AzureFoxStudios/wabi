<script lang="ts">
	import '../app.css';
	import '$lib/prism-theme.css';
	import type { PageData } from './$types';
	import { onMount, onDestroy } from 'svelte';
	import { channelMessages, channels } from '$lib/socket';
	import PureRefViewer from '$lib/components/PureRefViewer.svelte';
	import { isRunningInTauri, startAutoSaveTauri, type WabiData } from '$lib/tauri-storage';
	import { migrateTauriData, loadMigratedTauriData } from '$lib/tauri-migration';
	import { chatStorage } from '$lib/storage';
	import { get } from 'svelte/store';
	import { updated } from '$app/stores';

	// Accept data prop to suppress warning (we don't use it in root layout)
	export let data: PageData;

	let cleanupAutoSave: (() => void) | null = null;
	let showUpdateNotification = false;

	// Watch for updates
	$: if ($updated) {
		showUpdateNotification = true;
	}

	function reloadApp() {
		window.location.reload();
	}

	function dismissUpdate() {
		showUpdateNotification = false;
	}

	onMount(async () => {
		// Register service worker for PWA support
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').then((registration) => {
				console.log('✅ Service Worker registered:', registration);
			}).catch((error) => {
				console.error('❌ Service Worker registration failed:', error);
			});
		}

		// NOTE: Socket initialization is handled ONLY by +page.svelte
		// This prevents duplicate connections when both layout and page mount

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

{#if showUpdateNotification}
	<div class="update-notification">
		<div class="update-content">
			<div class="update-icon">🚀</div>
			<div class="update-text">
				<h3>New Version Available!</h3>
				<p>A new version of Wabi is ready. Refresh to update.</p>
			</div>
			<div class="update-actions">
				<button class="update-btn primary" on:click={reloadApp}>
					Update Now
				</button>
				<button class="update-btn secondary" on:click={dismissUpdate}>
					Later
				</button>
			</div>
		</div>
	</div>
{/if}

<slot />

<style>
	.update-notification {
		position: fixed;
		bottom: 2rem;
		right: 2rem;
		z-index: 9999;
		animation: slideIn 0.3s ease-out;
	}

	.update-content {
		background: linear-gradient(135deg, rgba(88, 101, 242, 0.95) 0%, rgba(139, 92, 246, 0.95) 100%);
		backdrop-filter: blur(10px);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 12px;
		padding: 1.5rem;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
		display: flex;
		align-items: center;
		gap: 1rem;
		max-width: 400px;
	}

	.update-icon {
		font-size: 2rem;
		flex-shrink: 0;
	}

	.update-text {
		flex: 1;
	}

	.update-text h3 {
		margin: 0 0 0.25rem 0;
		font-size: 1rem;
		font-weight: 600;
		color: white;
	}

	.update-text p {
		margin: 0;
		font-size: 0.875rem;
		color: rgba(255, 255, 255, 0.9);
	}

	.update-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.update-btn {
		padding: 0.5rem 1rem;
		border: none;
		border-radius: 6px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s ease;
		font-size: 0.875rem;
	}

	.update-btn.primary {
		background: white;
		color: #5865f2;
	}

	.update-btn.primary:hover {
		background: rgba(255, 255, 255, 0.9);
		transform: translateY(-1px);
	}

	.update-btn.secondary {
		background: rgba(255, 255, 255, 0.2);
		color: white;
	}

	.update-btn.secondary:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	@keyframes slideIn {
		from {
			transform: translateY(100%);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}

	@media (max-width: 768px) {
		.update-notification {
			bottom: 1rem;
			right: 1rem;
			left: 1rem;
		}

		.update-content {
			max-width: 100%;
		}

		.update-actions {
			flex-direction: row;
		}
	}
</style>
