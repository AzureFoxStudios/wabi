<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/stores';
	import Chat from '$lib/components/Chat.svelte';
	import MapWorkspace from '$lib/components/MapWorkspace.svelte';
	import WorkspacePanelHost from '$lib/components/WorkspacePanelHost.svelte';
	import { initSocket, disconnect, joinChannel } from '$lib/socket';
	import { getAuthToken, getStoredDbUserId, getStoredUsername } from '$lib/authSession';
	import { initializeTheme, watchThemeChanges, syncThemeToLocalStorage } from '$lib/theme/initTheme';
	import { startTimedThemeModeScheduler } from '$lib/timedThemeMode';
	import { readDetachedPanelState } from '$lib/detachedPanels';
	import { canAccessWorkspacePanel, getWorkspacePanelManifest } from '$lib/workspacePanels';
	import { currentUser } from '$lib/socket';

	let panelState = readDetachedPanelState($page.url);
	let bootError: string | null = null;
	let isReady = false;
	let unsubscribeThemeWatcher: (() => void) | null = null;
	let unsubscribeLocalStorageSync: (() => void) | null = null;
	let stopTimedThemeScheduler: (() => void) | null = null;
	let workspaceManifest: ReturnType<typeof getWorkspacePanelManifest> = null;

	$: panelState = readDetachedPanelState($page.url);

	// Resolve workspace panel manifest once panelState is available
	$: if (panelState?.kind === 'workspace-panel' && panelState.panelId) {
		workspaceManifest = getWorkspacePanelManifest(panelState.panelId as any);
	}

	onMount(async () => {
		if (!panelState) {
			bootError = 'Invalid detached panel request.';
			return;
		}

		const username = getStoredUsername();
		const token = getAuthToken() || undefined;
		const isRegistered = Boolean(token || getStoredDbUserId());

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
			stopTimedThemeScheduler = startTimedThemeModeScheduler();
			if (!isRegistered) {
				unsubscribeLocalStorageSync = syncThemeToLocalStorage();
			}

			isReady = true;
		} catch (error) {
			console.error('[DetachedPanel] Failed to bootstrap detached panel:', error);
			bootError = 'Failed to initialize detached panel.';
		}
	});

	onDestroy(async () => {
		unsubscribeThemeWatcher?.();
		unsubscribeLocalStorageSync?.();
		stopTimedThemeScheduler?.();
		disconnect();

		// Emit close event so the main window can re-dock this panel
		if (import.meta.env.TAURI && panelState?.panelId) {
			try {
				const { emit } = await import('@tauri-apps/api/event');
				await emit('detached-window-closed', { panelId: panelState.panelId });
			} catch (err) {
				console.warn('[DetachedPanel] Failed to emit close event:', err);
			}
		}
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
{:else if panelState?.kind === 'server-map'}
	<div class="detached-shell">
		<MapWorkspace variant="detached" initialPlaceId={panelState.placeId || null} />
	</div>
{:else if panelState?.kind === 'workspace-panel' && panelState.panelId}
	<div class="detached-shell">
		{#if workspaceManifest && canAccessWorkspacePanel(workspaceManifest, $currentUser)}
			<WorkspacePanelHost panel={workspaceManifest} />
		{:else}
			<div class="detached-shell error">
				<h1>Panel Not Found</h1>
				<p>This panel is not available or you don't have permission to view it.</p>
			</div>
		{/if}
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
		background: var(--surface-app, #12131f);
	}

	.detached-shell.loading,
	.detached-shell.error {
		align-items: center;
		justify-content: center;
		color: var(--text-heading, #f3f4f6);
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
