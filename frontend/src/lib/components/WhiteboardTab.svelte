<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { channels, currentUser } from '$lib/socket';
	import {
		getChannelBoardId,
		type WhiteboardPresenceUser
	} from '$lib/whiteboard/boardTypes';
	import { createSyncSession, type SyncSession } from '$lib/whiteboard/boardSync';
	import { boardStore } from '$lib/whiteboard/boardStore';
	import { exportBoardAsJson, exportBoardAsPng } from '$lib/whiteboard/export';
	import { queueWhiteboardImport } from '$lib/whiteboard/whiteboardSurface';
	import WhiteboardCanvas from './WhiteboardCanvas.svelte';
	import WhiteboardToolbar from './WhiteboardToolbar.svelte';

	export let channelId = '';

	type RemoteCursorEntry = {
		userId: string;
		username: string;
		color: string;
		x: number;
		y: number;
		lastSeenAt: number;
	};

	let presence: WhiteboardPresenceUser[] = [];
	let remoteCursors: RemoteCursorEntry[] = [];
	let errorMessage = '';
	let exportBusy = false;
	let syncSession: SyncSession | null = null;
	let cursorCleanupTimer: ReturnType<typeof setInterval> | null = null;
	let syncReady = false;
	let mounted = false;
	let activeChannelId = '';
	let activeChannel: { id: string; name: string; type?: string } | null = null;
	let channelLabel = 'Whiteboard';
	let importInput: HTMLInputElement | null = null;
	let showGrid = true;

	$: boardId = channelId ? getChannelBoardId(channelId) : '';
	$: activeChannel = $channels.find((channel) => channel.id === channelId) || null;
	$: channelLabel = activeChannel?.type === 'dm' || activeChannel?.type === 'group'
		? activeChannel?.name || 'Conversation board'
		: activeChannel?.name
			? `#${activeChannel.name}`
			: channelId || 'Whiteboard';
	$: localUsername = $currentUser?.username || 'Guest';
	$: localUserColor = $currentUser?.color || '#6366f1';

	function resetSessionState(): void {
		presence = [];
		remoteCursors = [];
		syncReady = false;
		errorMessage = '';
	}

	function destroySyncSession(): void {
		if (syncSession) {
			syncSession.destroy();
			syncSession = null;
		}
		activeChannelId = '';
		resetSessionState();
	}

	function ensureCursorCleanupTimer(): void {
		if (cursorCleanupTimer) return;
		cursorCleanupTimer = setInterval(() => {
			const cutoff = Date.now() - 6000;
			remoteCursors = remoteCursors.filter((cursor) => cursor.lastSeenAt >= cutoff);
		}, 3000);
	}

	function syncChannelSession(nextChannelId: string): void {
		if (!mounted || activeChannelId === nextChannelId) return;

		destroySyncSession();
		boardStore.reset();

		if (!nextChannelId) {
			errorMessage = 'Whiteboard needs a channel scope before it can connect.';
			return;
		}

		activeChannelId = nextChannelId;
		syncSession = createSyncSession(nextChannelId, {
			onReady() {
				syncReady = true;
				errorMessage = '';
			},
			onRemoteCursor(payload) {
				const cursor = payload.cursor as { x?: number; y?: number; username?: string; color?: string } | null;
				if (!cursor || typeof cursor.x !== 'number' || typeof cursor.y !== 'number') return;
				const entry: RemoteCursorEntry = {
					userId: payload.userId,
					username: cursor.username || payload.userId,
					color: cursor.color || '#6366f1',
					x: cursor.x,
					y: cursor.y,
					lastSeenAt: Date.now()
				};
				const next = remoteCursors.filter((item) => item.userId !== payload.userId);
				remoteCursors = [...next, entry];
			},
			onPresence(payload) {
				presence = payload.users || [];
				const activeIds = new Set(presence.map((user) => user.userId));
				remoteCursors = remoteCursors.filter((cursor) => activeIds.has(cursor.userId));
				if (!syncReady) {
					syncReady = true;
				}
				errorMessage = '';
			},
			onError(payload) {
				errorMessage = payload.message || 'Whiteboard error';
			}
		});
	}

	async function handleExportPng(): Promise<void> {
		if (exportBusy) return;
		exportBusy = true;
		errorMessage = '';
		try {
			await exportBoardAsPng(boardStore.getDocument());
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to export whiteboard as PNG.';
		} finally {
			exportBusy = false;
		}
	}

	function handleExportJson(): void {
		errorMessage = '';
		try {
			exportBoardAsJson(boardStore.getDocument());
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to export whiteboard as JSON.';
		}
	}

	function triggerImportPicker(): void {
		importInput?.click();
	}

	function queueImportedFiles(fileList: FileList | File[]): void {
		if (!channelId) {
			errorMessage = 'Open the whiteboard from a channel before importing images.';
			return;
		}
		const imageFiles = Array.from(fileList).filter((file) => file.type.startsWith('image/'));
		if (imageFiles.length === 0) {
			errorMessage = 'Choose one or more image files to place on the whiteboard.';
			return;
		}
		errorMessage = '';
		for (const file of imageFiles) {
			queueWhiteboardImport(channelId, file, 'capture');
		}
	}

	function handleImportChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement | null;
		if (!input?.files?.length) return;
		queueImportedFiles(input.files);
		input.value = '';
	}

	onMount(() => {
		mounted = true;
		ensureCursorCleanupTimer();
		syncChannelSession(channelId);
	});

	$: if (mounted) {
		syncChannelSession(channelId);
	}

	onDestroy(() => {
		mounted = false;
		destroySyncSession();
		if (cursorCleanupTimer) {
			clearInterval(cursorCleanupTimer);
			cursorCleanupTimer = null;
		}
		boardStore.reset();
	});
</script>

<div class="whiteboard-shell">
	<input
		bind:this={importInput}
		class="whiteboard-hidden-input"
		type="file"
		accept="image/*"
		multiple
		on:change={handleImportChange}
	/>
	<div class="whiteboard-topbar">
		<div class="whiteboard-title-row">
			<span class="whiteboard-channel-pill">{channelLabel}</span>
			<span class="whiteboard-activity-pill">{presence.length} Active</span>
			{#if !syncReady}
				<span class="whiteboard-connecting-pill" aria-live="polite">Joining board...</span>
			{/if}
		</div>

		<button
			type="button"
			class="whiteboard-grid-toggle"
			class:active={showGrid}
			on:click={() => (showGrid = !showGrid)}
			aria-pressed={showGrid}
		>
			{showGrid ? 'Grid On' : 'Grid Off'}
		</button>
	</div>

	{#if errorMessage}
		<div class="whiteboard-banner error">{errorMessage}</div>
	{/if}

	<div class="whiteboard-stage">
		<WhiteboardCanvas
			{remoteCursors}
			{boardId}
			{channelId}
			username={localUsername}
			userColor={localUserColor}
			{syncReady}
			{showGrid}
		/>
		<WhiteboardToolbar
			onImportImages={triggerImportPicker}
			onExportPng={handleExportPng}
			onExportJson={handleExportJson}
			{exportBusy}
			importDisabled={!channelId}
		/>
	</div>
</div>

<style>
	.whiteboard-shell {
		position: relative;
		height: 100%;
		min-height: 0;
		display: block;
		background: transparent;
	}

	.whiteboard-topbar {
		position: absolute;
		top: 0.8rem;
		left: 0.9rem;
		right: 0.9rem;
		z-index: 18;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.42rem 0.62rem;
		border: 1px solid rgba(148, 163, 184, 0.18);
		border-radius: 14px;
		background: rgba(255, 251, 243, 0.76);
		backdrop-filter: blur(12px);
		box-shadow: 0 16px 30px rgba(15, 23, 42, 0.08);
	}

	.whiteboard-title-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.whiteboard-channel-pill,
	.whiteboard-activity-pill,
	.whiteboard-connecting-pill {
		display: inline-flex;
		align-items: center;
		min-height: 1.7rem;
		padding: 0.18rem 0.56rem;
		border-radius: 999px;
		font-size: 0.76rem;
		font-weight: 600;
		border: 1px solid rgba(148, 163, 184, 0.2);
		background: rgba(255, 255, 255, 0.86);
		color: #0f172a;
	}

	.whiteboard-channel-pill {
		background: rgba(15, 23, 42, 0.05);
	}

	.whiteboard-connecting-pill {
		background: rgba(59, 130, 246, 0.12);
		border-color: rgba(59, 130, 246, 0.24);
		color: #1d4ed8;
	}

	.whiteboard-grid-toggle {
		border: 1px solid rgba(148, 163, 184, 0.22);
		background: rgba(255, 255, 255, 0.84);
		color: #334155;
		border-radius: 999px;
		padding: 0.3rem 0.68rem;
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
	}

	.whiteboard-grid-toggle.active {
		background: rgba(37, 99, 235, 0.12);
		border-color: rgba(59, 130, 246, 0.26);
		color: #1d4ed8;
	}

	.whiteboard-banner {
		position: absolute;
		top: 4.2rem;
		left: 0.9rem;
		right: 0.9rem;
		z-index: 17;
		padding: 0.75rem 1rem;
		font-size: 0.9rem;
		border-radius: 14px;
	}

	.whiteboard-banner.error {
		background: rgba(127, 29, 29, 0.22);
		color: #fecaca;
		border-bottom: 1px solid rgba(248, 113, 113, 0.24);
	}

	.whiteboard-stage {
		position: relative;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		padding: 0;
		background: transparent;
	}

	.whiteboard-stage :global(.whiteboard-canvas-container) {
		border-radius: 0;
		border: 0;
		box-shadow: none;
	}

	.whiteboard-stage :global(.whiteboard-layer) {
		border-radius: 0;
	}

	.whiteboard-stage :global(.wb-toolbar) {
		top: 4.25rem;
	}

	.whiteboard-hidden-input {
		display: none;
	}

	@media (max-width: 720px) {
		.whiteboard-topbar {
			top: 0.6rem;
			left: 0.6rem;
			right: 0.6rem;
			flex-wrap: wrap;
			justify-content: flex-start;
		}

		.whiteboard-banner {
			left: 0.6rem;
			right: 0.6rem;
			top: 5rem;
		}
	}
</style>
