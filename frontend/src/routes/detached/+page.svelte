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
	import { brandName } from '$lib/branding';
	import { canAccessWorkspacePanel, getWorkspacePanelManifest } from '$lib/workspacePanels';
	import { currentUser } from '$lib/socket';
	import { isDesktopTauri } from '$lib/tauri-platform';
	import { snapWindow, type SnapPosition } from '$lib/tauri-window';

	let panelState = readDetachedPanelState($page.url);
	let bootError: string | null = null;
	let isReady = false;
	let unsubscribeThemeWatcher: (() => void) | null = null;
	let unsubscribeLocalStorageSync: (() => void) | null = null;
	let stopTimedThemeScheduler: (() => void) | null = null;
	let workspaceManifest: ReturnType<typeof getWorkspacePanelManifest> = null;
	let showWindowControls = false;

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

		document.title = brandName;

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

		if (isDesktopTauri()) {
			document.addEventListener('keydown', handleKeyDown);
		}
	});

	function handleKeyDown(event: KeyboardEvent) {
		if (!isDesktopTauri()) return;
		if (event.metaKey || event.ctrlKey) {
			switch (event.key) {
				case 'ArrowLeft':
					event.preventDefault();
					snapWindow('left');
					break;
				case 'ArrowRight':
					event.preventDefault();
					snapWindow('right');
					break;
				case 'ArrowUp':
					event.preventDefault();
					snapWindow('top');
					break;
				case 'ArrowDown':
					event.preventDefault();
					snapWindow('bottom');
					break;
				case 'Enter':
					event.preventDefault();
					snapWindow('maximize');
					break;
				case 'Escape':
					event.preventDefault();
					snapWindow('center');
					break;
			}
		}
	}

	async function handleSnap(position: SnapPosition) {
		await snapWindow(position);
		showWindowControls = false;
	}

	onDestroy(async () => {
		unsubscribeThemeWatcher?.();
		unsubscribeLocalStorageSync?.();
		stopTimedThemeScheduler?.();
		disconnect();

		if (isDesktopTauri()) {
			document.removeEventListener('keydown', handleKeyDown);
		}

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
{:else}
	<div class="detached-shell">
		{#if isDesktopTauri()}
			<div class="window-controls-trigger" on:mouseenter={() => showWindowControls = true}></div>
			<div class="window-controls-bar" class:visible={showWindowControls} on:mouseleave={() => showWindowControls = false} on:mouseenter={() => showWindowControls = true}>
				<div class="window-controls-title">
					{#if panelState?.kind === 'channel-chat' && panelState.channelName}
						#{panelState.channelName}
					{:else if panelState?.kind === 'workspace-panel' && panelState.panelId}
						{panelState.panelId}
					{:else}
						Detached Panel
					{/if}
				</div>
				<div class="window-controls-actions">
					<button class="snap-btn" title="Snap Left (Ctrl+←)" on:click={() => handleSnap('left')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="9" height="18" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Snap Right (Ctrl+→)" on:click={() => handleSnap('right')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="12" y="3" width="9" height="18" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Snap Top (Ctrl+↑)" on:click={() => handleSnap('top')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="9" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Snap Bottom (Ctrl+↓)" on:click={() => handleSnap('bottom')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="18" height="9" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Maximize (Ctrl+Enter)" on:click={() => handleSnap('maximize')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Center (Ctrl+Esc)" on:click={() => handleSnap('center')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><circle cx="12" cy="12" r="7"></circle></svg>
					</button>
					<button class="snap-btn" title="Quarter: Top-Left" on:click={() => handleSnap('top-left')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="9" height="9" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Quarter: Top-Right" on:click={() => handleSnap('top-right')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="12" y="3" width="9" height="9" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Quarter: Bottom-Left" on:click={() => handleSnap('bottom-left')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="9" height="9" rx="1"></rect></svg>
					</button>
					<button class="snap-btn" title="Quarter: Bottom-Right" on:click={() => handleSnap('bottom-right')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="12" y="12" width="9" height="9" rx="1"></rect></svg>
					</button>
				</div>
			</div>
		{/if}
		{#if panelState?.kind === 'channel-chat'}
			<Chat />
		{:else if panelState?.kind === 'server-map'}
			<MapWorkspace variant="detached" initialPlaceId={panelState.placeId || null} />
		{:else if panelState?.kind === 'workspace-panel' && panelState.panelId}
			{#if workspaceManifest && canAccessWorkspacePanel(workspaceManifest, $currentUser)}
				<WorkspacePanelHost panel={workspaceManifest} />
			{:else}
				<div class="detached-shell error">
					<h1>Panel Not Found</h1>
					<p>This panel is not available or you don't have permission to view it.</p>
				</div>
			{/if}
		{:else}
			<div class="detached-shell error">
				<h1>Detached Panel Error</h1>
				<p>Unsupported panel type.</p>
			</div>
		{/if}
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

	.window-controls-trigger {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 4px;
		background: transparent;
		z-index: 999;
	}

	.window-controls-bar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 1rem;
		background: var(--surface-base, #1e1e2e);
		border-bottom: 1px solid var(--border-subtle, #3a3a4a);
		z-index: 1000;
		opacity: 0;
		pointer-events: none;
		transform: translateY(-100%);
		transition: opacity 0.2s ease, transform 0.2s ease;
	}

	.window-controls-bar.visible {
		opacity: 1;
		pointer-events: auto;
		transform: translateY(0);
	}

	.window-controls-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-heading, #f3f4f6);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 300px;
	}

	.window-controls-actions {
		display: flex;
		gap: 0.25rem;
	}

	.snap-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-secondary, #a0a0a0);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.snap-btn:hover {
		background: var(--surface-raised, #2a2a3a);
		color: var(--text-heading, #f3f4f6);
	}

	.snap-btn svg {
		width: 16px;
		height: 16px;
	}

	:global(body) {
		margin: 0;
		overflow: hidden;
	}
</style>
