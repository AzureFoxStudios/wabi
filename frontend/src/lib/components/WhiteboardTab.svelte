<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		getChannelBoardId,
		type WhiteboardPresenceUser,
		type WhiteboardSnapshotPayload
	} from '$lib/whiteboard/boardTypes';
	import {
		joinWhiteboardChannel,
		leaveWhiteboard,
		subscribeWhiteboardEvents
	} from '$lib/whiteboard/boardSocket';

	export let channelId = '';

	let snapshot: WhiteboardSnapshotPayload | null = null;
	let presence: WhiteboardPresenceUser[] = [];
	let errorMessage = '';
	let unsubscribe = () => {};

	$: boardId = channelId ? getChannelBoardId(channelId) : '';

	onMount(() => {
		if (!channelId) {
			errorMessage = 'Whiteboard needs a channel scope before it can connect.';
			return;
		}

		unsubscribe = subscribeWhiteboardEvents({
			onSnapshot: (next) => {
				if (next.boardId !== boardId) return;
				snapshot = next;
				errorMessage = '';
			},
			onPresence: (next) => {
				if (next.boardId !== boardId) return;
				presence = next.users;
			},
			onError: (next) => {
				if (next.boardId && next.boardId !== boardId) return;
				if (next.channelId && next.channelId !== channelId) return;
				errorMessage = next.message;
			}
		});

		joinWhiteboardChannel(channelId);
	});

	onDestroy(() => {
		if (boardId) {
			leaveWhiteboard(boardId);
		}
		unsubscribe();
	});
</script>

<div class="whiteboard-shell">
	<div class="whiteboard-topbar">
		<div>
			<h2>Whiteboard</h2>
			<p>Blank-slate Svelte rebuild. Canvas tools land next.</p>
		</div>

		<div class="whiteboard-meta">
			<span>Board: {boardId || 'unscoped'}</span>
			<span>Version: {snapshot?.version ?? 0}</span>
			<span>Live users: {presence.length}</span>
		</div>
	</div>

	{#if errorMessage}
		<div class="whiteboard-banner error">{errorMessage}</div>
	{/if}

	<div class="whiteboard-stage">
		<div class="whiteboard-grid" aria-hidden="true"></div>
		<div class="whiteboard-placeholder">
			<h3>Foundation Wired</h3>
			<p>Room-scoped snapshot sync and presence are ready for the native board renderer.</p>
			{#if snapshot}
				<p>
					Loaded {snapshot.document.elements.length} element{snapshot.document.elements.length === 1 ? '' : 's'} from the current board snapshot.
				</p>
			{:else}
				<p>Waiting for the first board snapshot.</p>
			{/if}
		</div>
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
		padding: 1rem 1.2rem;
		border-bottom: 1px solid rgba(148, 163, 184, 0.18);
		background: rgba(15, 23, 42, 0.72);
		backdrop-filter: blur(10px);
	}

	.whiteboard-topbar h2 {
		margin: 0;
		font-size: 1.2rem;
	}

	.whiteboard-topbar p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary, #94a3b8);
		font-size: 0.92rem;
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
		padding: 0.32rem 0.58rem;
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

	.whiteboard-grid {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
			linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
		background-size: 24px 24px;
		opacity: 0.65;
	}

	.whiteboard-placeholder {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(560px, calc(100% - 2rem));
		padding: 1.4rem;
		border-radius: 16px;
		background: rgba(15, 23, 42, 0.82);
		border: 1px solid rgba(148, 163, 184, 0.22);
		box-shadow: 0 22px 54px rgba(2, 6, 23, 0.4);
		text-align: center;
	}

	.whiteboard-placeholder h3 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}

	.whiteboard-placeholder p {
		margin: 0.35rem 0;
		color: var(--text-secondary, #cbd5e1);
		line-height: 1.5;
	}
</style>
