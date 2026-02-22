<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/stores';
	import Chat from '$lib/components/Chat.svelte';
	import { initSocket, disconnect, joinChannel } from '$lib/socket';
	import { initializeTheme, watchThemeChanges, syncThemeToLocalStorage } from '$lib/theme/initTheme';
	import { readDetachedPanelState } from '$lib/detachedPanels';

	let panelState = readDetachedPanelState($page.url);
	let bootError: string | null = null;
	let isReady = false;
	let unsubscribeThemeWatcher: (() => void) | null = null;
	let unsubscribeLocalStorageSync: (() => void) | null = null;

	$: panelState = readDetachedPanelState($page.url);

	onMount(async () => {
		if (!panelState) {
			bootError = 'Invalid detached panel request.';
			return;
		}

		const username = localStorage.getItem('username');
		const token = localStorage.getItem('authToken') || undefined;
		const isRegistered = Boolean(token);

		if (!username) {
			bootError = 'No local session found. Sign in on the main window first.';
			return;
		}

		try {
			initSocket(username, token);
			if (panelState.kind === 'channel-chat' && panelState.channelId) {
				joinChannel(panelState.channelId);
			}

			await initializeTheme(isRegistered);
			unsubscribeThemeWatcher = watchThemeChanges();
			if (!isRegistered) {
				unsubscribeLocalStorageSync = syncThemeToLocalStorage();
			}

			isReady = true;
		} catch (error) {
			console.error('[DetachedPanel] Failed to bootstrap detached panel:', error);
			bootError = 'Failed to initialize detached panel.';
		}
	});

	onDestroy(() => {
		unsubscribeThemeWatcher?.();
		unsubscribeLocalStorageSync?.();
		disconnect();
	});
</script>

{#if bootError}
	<div class="detached-shell error">
		<h1>Detached Panel Error</h1>
		<p>{bootError}</p>
	</div>
{:else if !isReady}
	<div class="detached-shell loading">
		<div class="loading-title">Opening detached panel...</div>
	</div>
{:else if panelState?.kind === 'channel-chat'}
	<div class="detached-shell">
		<Chat />
	</div>
{:else}
	<div class="detached-shell error">
		<h1>Detached Panel Error</h1>
		<p>Unsupported panel type.</p>
	</div>
{/if}

<style>
	.detached-shell {
		height: 100vh;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--bg-primary, #12131f);
	}

	.detached-shell.loading,
	.detached-shell.error {
		align-items: center;
		justify-content: center;
		color: var(--text-primary, #f3f4f6);
		gap: 0.75rem;
		padding: 1.25rem;
		text-align: center;
	}

	.loading-title {
		font-weight: 600;
		letter-spacing: 0.01em;
	}

	.detached-shell.error h1 {
		font-size: 1.1rem;
		margin: 0;
	}

	.detached-shell.error p {
		margin: 0;
		opacity: 0.86;
	}

	:global(body) {
		margin: 0;
		overflow: hidden;
	}
</style>
