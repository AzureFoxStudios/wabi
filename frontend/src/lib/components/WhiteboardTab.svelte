<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { currentUser } from '$lib/socket';
	import {
		getChannelBoardId,
		type WhiteboardPresenceUser
	} from '$lib/whiteboard/boardTypes';
	import { createSyncSession, type SyncSession } from '$lib/whiteboard/boardSync';
	import { boardStore, elements } from '$lib/whiteboard/boardStore';
	import { exportBoardAsJson, exportBoardAsPng } from '$lib/whiteboard/export';
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

	$: boardId = channelId ? getChannelBoardId(channelId) : '';
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
	<div class="whiteboard-topbar">
		<div>
			<h2>Whiteboard</h2>
		</div>

		<div class="whiteboard-meta">
			<span>Board: {boardId || 'unscoped'}</span>
			<span>{$elements.length} element{$elements.length === 1 ? '' : 's'}</span>
			<span>{presence.length} online</span>
		</div>
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
		/>
		<WhiteboardToolbar
			onExportPng={handleExportPng}
			onExportJson={handleExportJson}
			{exportBusy}
		/>
	</div>
</div>

<style>
	.whiteboard-shell {
		height: 100%;
		min-height: 0;
		display: grid;
		grid-template-rows: auto auto 1fr;
		background:
			radial-gradient(circle at top left, rgba(63, 94, 251, 0.08), transparent 35%),
			radial-gradient(circle at bottom right, rgba(16, 185, 129, 0.1), transparent 32%),
			var(--bg-primary, #0f172a);
	}

	.whiteboard-topbar {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.6rem 1.2rem;
		border-bottom: 1px solid rgba(148, 163, 184, 0.18);
		background: rgba(15, 23, 42, 0.72);
		backdrop-filter: blur(10px);
	}

	.whiteboard-topbar h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.whiteboard-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		font-size: 0.76rem;
		color: #cbd5e1;
	}

	.whiteboard-meta span {
		padding: 0.28rem 0.52rem;
		border-radius: 999px;
		background: rgba(30, 41, 59, 0.85);
		border: 1px solid rgba(148, 163, 184, 0.18);
	}

	.whiteboard-banner {
		padding: 0.75rem 1rem;
		font-size: 0.9rem;
	}

	.whiteboard-banner.error {
		background: rgba(127, 29, 29, 0.22);
		color: #fecaca;
		border-bottom: 1px solid rgba(248, 113, 113, 0.24);
	}

	.whiteboard-stage {
		position: relative;
		min-height: 0;
		overflow: hidden;
	}
</style>
