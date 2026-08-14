<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { channels, currentUser } from '$lib/socket';
	import {
		getChannelBoardId,
		type WhiteboardPresenceUser
	} from '$lib/whiteboard/boardTypes';
	import { createSyncSession, boardSyncError, type SyncSession } from '$lib/whiteboard/boardSync';
	import { boardStore, policy, selection } from '$lib/whiteboard/boardStore';
	import { recognizeStrokes } from '$lib/whiteboard/mathRecognition';
	import {
		extractStrokeSelection,
		buildMathElementFromRecognition,
		type RecognitionDraft
	} from '$lib/whiteboard/recognitionUi';
	import type { StrokeElement } from '$lib/whiteboard/elementTypes';
	import { isTauriRuntime } from '$lib/tauri-platform';
	import { exportBoardAsJson, exportBoardAsPng } from '$lib/whiteboard/export';
	import { queueWhiteboardImport } from '$lib/whiteboard/whiteboardSurface';
	import { setWhiteboardPresence, clearWhiteboardPresence } from '$lib/presenceStore';
	import WhiteboardCanvas from './WhiteboardCanvas.svelte';
	import WhiteboardToolbar from './WhiteboardToolbar.svelte';
	import WhiteboardMathRecognize from './WhiteboardMathRecognize.svelte';
	import WhiteboardBoardSettings from './WhiteboardBoardSettings.svelte';

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
	let errorTimer: ReturnType<typeof setTimeout> | null = null;

	/** Show a transient error banner that auto-clears after a few seconds
	 *  (socket whiteboard:error events can otherwise linger behind the
	 *  toolbar and read as a stuck red bar). */
	function showTransientError(message: string): void {
		errorMessage = message;
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = setTimeout(() => {
			errorMessage = '';
			errorTimer = null;
		}, 6000);
	}
	let syncSession: SyncSession | null = null;
	let cursorCleanupTimer: ReturnType<typeof setInterval> | null = null;
	let syncReady = false;
	let mounted = false;
	let activeChannelId = '';
	let activeChannel: { id: string; name: string; type?: string } | null = null;
	let channelLabel = 'Whiteboard';
	let importInput: HTMLInputElement | null = null;
	let showGrid = true;

	let recognitionDraft: RecognitionDraft | null = null;
	let selectedForRecognition: StrokeElement[] | null = null;
	let boardSettingsOpen = false;

	const isDesktopClient = isTauriRuntime();

	$: boardSyncErrorText = $boardSyncError;
	$: desktopRequired = !!boardSyncErrorText && boardSyncErrorText.includes('desktop-only');
	$: readOnly = !isDesktopClient && (($policy?.writeAccess === 'desktop') || (!!boardSyncErrorText && boardSyncErrorText.includes('read-only')));
	// The sync store carries real failures ("Sync failed — reload the board",
	// conflict re-sync notices) that were previously set but never displayed
	// anywhere (only desktop/read-only were consumed). Surface them in the
	// banner unless they are the desktop/read-only gates (those render their
	// own full-screen UI).
	$: syncErrorToShow = !desktopRequired && boardSyncErrorText && !boardSyncErrorText.includes('read-only') ? boardSyncErrorText : '';

	$: selectedStrokeCount = (() => {
		const sel = $selection;
		if (!sel || sel.size === 0) return 0;
		return extractStrokeSelection(get(boardStore)).length;
	})();

	$: boardId = channelId ? getChannelBoardId(channelId) : '';
	$: activeChannel = $channels.find((channel) => channel.id === channelId) || null;
	$: channelLabel = activeChannel?.type === 'dm' || activeChannel?.type === 'group'
		? activeChannel?.name || 'Conversation board'
		: activeChannel?.name
			? `#${activeChannel.name}`
			: channelId || 'Whiteboard';
	$: localUsername = $currentUser?.username || 'Guest';
	$: localUserColor = $currentUser?.color || '#6366f1';

	// Board policy can only be changed by the instance owner. The whiteboard has
	// no per-board owner id; `highestRole === 'owner'` is the app's owner signal
	// (server still enforces channel membership on every join/snapshot).
	$: canManageBoard = $currentUser?.highestRole === 'owner';

	$: selfParticipant = ($currentUser
		? { userId: $currentUser.id, username: localUsername, color: localUserColor }
		: { userId: 'local-guest', username: localUsername, color: localUserColor }) as WhiteboardPresenceUser;
	$: boardParticipants = (() => {
		const seen = new Set<string>();
		const list: WhiteboardPresenceUser[] = [selfParticipant];
		seen.add(selfParticipant.userId);
		for (const user of presence) {
			if (!seen.has(user.userId)) {
				list.push(user);
				seen.add(user.userId);
			}
		}
		return list;
	})();
	$: boardVisibleParticipants = boardParticipants.slice(0, 5);
	$: boardParticipantOverflow = Math.max(0, boardParticipants.length - 5);

	function resetSessionState(): void {
		presence = [];
		remoteCursors = [];
		syncReady = false;
		errorMessage = '';
	}

	function destroySyncSession(): void {
		if (activeChannelId) clearWhiteboardPresence(activeChannelId);
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
			const cutoff = Date.now() - 2500;
			remoteCursors = remoteCursors.filter((cursor) => cursor.lastSeenAt >= cutoff);
		}, 800);
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
				const existing = remoteCursors.find((item) => item.userId === payload.userId);
				const entry: RemoteCursorEntry = {
					userId: payload.userId,
					username: cursor.username || existing?.username || payload.userId,
					color: cursor.color || existing?.color || '#6366f1',
					x: cursor.x,
					y: cursor.y,
					lastSeenAt: Date.now()
				};
				const next = remoteCursors.filter((item) => item.userId !== payload.userId);
				remoteCursors = [...next, entry];
			},
			onPresence(payload) {
				presence = payload.users || [];
				setWhiteboardPresence(activeChannelId, presence);
				const activeIds = new Set(presence.map((user) => user.userId));
				remoteCursors = remoteCursors.filter((cursor) => activeIds.has(cursor.userId));
				if (!syncReady) {
					syncReady = true;
				}
				errorMessage = '';
			},
			onError(payload) {
				showTransientError(payload.message || 'Whiteboard error');
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
			showTransientError(error instanceof Error ? error.message : 'Failed to export whiteboard as PNG.');
		} finally {
			exportBusy = false;
		}
	}

	function handleExportJson(): void {
		errorMessage = '';
		try {
			exportBoardAsJson(boardStore.getDocument());
		} catch (error) {
			showTransientError(error instanceof Error ? error.message : 'Failed to export whiteboard as JSON.');
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

	function handleRecognizeMath(): void {
		const strokes = extractStrokeSelection(get(boardStore));
		if (strokes.length === 0) return;
		const result = recognizeStrokes(strokes.map((s) => ({ points: s.points })));
		selectedForRecognition = strokes;
		recognitionDraft = { latex: result.latex, confidence: result.confidence, partial: result.partial };
	}

	function clearRecognition(): void {
		recognitionDraft = null;
		selectedForRecognition = null;
	}

	function handleAcceptRecognition(editedLatex: string): void {
		const strokes = selectedForRecognition;
		const trimmed = editedLatex.trim();
		if (strokes && strokes.length > 0 && trimmed) {
			boardStore.deleteElements(strokes.map((s) => s.id));
			boardStore.addElement(buildMathElementFromRecognition(strokes, trimmed));
		}
		clearRecognition();
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
		onchange={handleImportChange}
	/>
	<div class="whiteboard-topbar">
		<div class="whiteboard-title-row">
			<span class="whiteboard-channel-pill">{channelLabel}</span>
			<span class="whiteboard-activity-pill">{presence.length} Active</span>
			{#if !syncReady && !desktopRequired}
				<span class="whiteboard-connecting-pill" aria-live="polite">Joining board...</span>
			{/if}
			<div class="whiteboard-jam-strip" aria-label="People on this board">
				<div class="jam-avatars">
					{#each boardVisibleParticipants as person (person.userId)}
						<span
							class="jam-avatar"
							style="--jam-color: {person.color || 'var(--accent-primary, #6366f1)'}"
							title={person.username}
						>{person.username.charAt(0).toUpperCase()}</span>
					{/each}
					{#if boardParticipantOverflow > 0}
						<span class="jam-avatar jam-avatar-more" title="{boardParticipants.length} people">+{boardParticipantOverflow}</span>
					{/if}
				</div>
			</div>
		</div>

		<div class="whiteboard-topbar-actions">
			{#if canManageBoard}
				<button
					type="button"
					class="whiteboard-settings-btn"
					class:active={boardSettingsOpen}
					onclick={() => (boardSettingsOpen = !boardSettingsOpen)}
					aria-label="Board settings"
					aria-expanded={boardSettingsOpen}
					aria-haspopup="dialog"
					title="Board settings"
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path></svg>
				</button>
			{/if}
			<button
				type="button"
				class="whiteboard-grid-toggle"
				class:active={showGrid}
				onclick={() => (showGrid = !showGrid)}
				aria-pressed={showGrid}
			>
				{showGrid ? 'Grid On' : 'Grid Off'}
			</button>
			{#if selectedStrokeCount > 0 && !desktopRequired && !readOnly}
				<button
					type="button"
					class="whiteboard-recognize-btn"
					title="Recognize the selected strokes as a math formula"
					onclick={handleRecognizeMath}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8V5H6l6 7-6 7h12v-3"/></svg>
					<span>Recognize as math</span>
				</button>
			{/if}
		</div>
	</div>

	{#if (errorMessage || syncErrorToShow) && !desktopRequired}
		<div class="whiteboard-banner error">
			<span>{errorMessage || syncErrorToShow}</span>
			{#if errorMessage}<button type="button" class="banner-dismiss" onclick={() => { errorMessage = ''; if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; } }} aria-label="Dismiss error">×</button>{/if}
		</div>
	{/if}

	{#if channelId}
		{#if desktopRequired}
			<div class="whiteboard-desktop-gate" role="status" aria-live="polite">
				<div class="whiteboard-desktop-gate-card">
					<div class="whiteboard-desktop-gate-icon">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/><path d="M12 14v2"/></svg>
					</div>
					<h3 class="whiteboard-desktop-gate-title">This board is desktop-only</h3>
					<p class="whiteboard-desktop-gate-body">
						This whiteboard is restricted to the Wabi desktop app. Open Wabi on your computer to view and edit it.
					</p>
					<p class="whiteboard-desktop-gate-note">Web viewing has been disabled by the board owner.</p>
				</div>
			</div>
		{:else}
			<div class="whiteboard-stage">
				{#if readOnly}
					<div class="whiteboard-banner read-only" role="status" aria-live="polite">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>
						<span>View-only — desktop app required to edit this board</span>
					</div>
				{/if}
				<WhiteboardCanvas
					{remoteCursors}
					{boardId}
					{channelId}
					username={localUsername}
					userColor={localUserColor}
					{syncReady}
					{showGrid}
					{readOnly}
				/>
				<WhiteboardToolbar
					onImportImages={triggerImportPicker}
					onExportPng={handleExportPng}
					onExportJson={handleExportJson}
					{exportBusy}
					importDisabled={!channelId}
					{readOnly}
				/>
			</div>
		{/if}
	{:else}
		<div class="whiteboard-empty">
			<div class="whiteboard-empty-icon">
				<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M8 8h32v32H8z"/>
					<path d="M18 18l12 12M30 18l-12 12"/>
					<path d="M8 28h32M8 20h32"/>
					<circle cx="36" cy="12" r="3" fill="currentColor" stroke="none"/>
				</svg>
			</div>
			<h3 class="whiteboard-empty-title">No Channel Selected</h3>
			<p class="whiteboard-empty-desc">Open a channel and switch to its whiteboard tab to start drawing together.</p>
		</div>
	{/if}

	{#if recognitionDraft}
		<WhiteboardMathRecognize
			latex={recognitionDraft.latex}
			confidence={recognitionDraft.confidence}
			partial={recognitionDraft.partial}
			onAccept={handleAcceptRecognition}
			onDismiss={clearRecognition}
		/>
	{/if}

	<WhiteboardBoardSettings open={boardSettingsOpen} onClose={() => (boardSettingsOpen = false)} />
</div>

<style>
	.whiteboard-shell {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
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
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 18%, transparent);
		border-radius: 14px;
		background: color-mix(in srgb, var(--surface-base, #24243e) 76%, transparent);
		backdrop-filter: blur(12px);
		box-shadow: 0 16px 30px rgba(var(--surface-app-rgb, 15, 23, 42), 0.08);
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
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 20%, transparent);
		background: color-mix(in srgb, var(--text-inverse, #ffffff) 86%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.whiteboard-channel-pill {
		background: color-mix(in srgb, var(--surface-app, #1a1a2e) 5%, transparent);
	}

	.whiteboard-connecting-pill {
		background: color-mix(in srgb, var(--color-info, #00bfff) 12%, transparent);
		border-color: color-mix(in srgb, var(--color-info, #00bfff) 24%, transparent);
		color: var(--color-info, #00bfff);
	}

	.whiteboard-grid-toggle {
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		background: color-mix(in srgb, var(--text-inverse, #ffffff) 84%, transparent);
		color: var(--text-secondary, #b3b3ff);
		border-radius: 999px;
		padding: 0.3rem 0.68rem;
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
	}

	.whiteboard-grid-toggle.active {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 12%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary, #6366f1) 26%, transparent);
		color: var(--accent-primary, #6366f1);
	}

	.whiteboard-topbar-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.whiteboard-settings-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		background: color-mix(in srgb, var(--text-inverse, #ffffff) 84%, transparent);
		color: var(--text-secondary, #b3b3ff);
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
	}

	.whiteboard-settings-btn:hover {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 12%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary, #6366f1) 26%, transparent);
		color: var(--accent-primary, #6366f1);
	}

	.whiteboard-settings-btn.active {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 16%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary, #6366f1) 34%, transparent);
		color: var(--accent-primary, #6366f1);
	}

	.whiteboard-settings-btn svg {
		width: 15px;
		height: 15px;
	}

	.whiteboard-recognize-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.3rem 0.68rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 30%, transparent);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 12%, transparent);
		color: var(--accent-primary, #6366f1);
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
	}

	.whiteboard-recognize-btn:hover {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 22%, transparent);
	}

	.whiteboard-recognize-btn svg {
		width: 13px;
		height: 13px;
	}

	.whiteboard-banner {
		position: absolute;
		top: 8.2rem;
		left: 0.9rem;
		right: 0.9rem;
		/* Above .wb-toolbar (z-index 20) so errors are never hidden behind it. */
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		font-size: 0.9rem;
		border-radius: 14px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
	}

	.whiteboard-banner.error {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 22%, transparent);
		color: var(--text-danger, #ef4444);
		border-bottom: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 24%, transparent);
	}

	.whiteboard-banner.error :global(span) {
		flex: 1;
	}

	.banner-dismiss {
		background: transparent;
		border: none;
		color: inherit;
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0 0 0.5rem;
		opacity: 0.7;
	}

	.banner-dismiss:hover {
		opacity: 1;
	}

	.whiteboard-banner.read-only {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 16%, transparent);
		color: var(--accent-primary, #6366f1);
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 26%, transparent);
		font-weight: 600;
	}

	.whiteboard-banner.read-only svg {
		width: 15px;
		height: 15px;
		flex-shrink: 0;
	}

	.whiteboard-desktop-gate {
		position: relative;
		height: 100%;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-6);
	}

	.whiteboard-desktop-gate-card {
		max-width: 420px;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: var(--space-3);
		padding: var(--space-8);
		border-radius: var(--radius-lg, 12px);
		background: color-mix(in srgb, var(--surface-raised, #302b63) 78%, transparent);
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 24%, transparent);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 40px rgba(var(--surface-app-rgb, 15, 23, 42), 0.22);
	}

	.whiteboard-desktop-gate-icon {
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 16%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 32%, transparent);
		color: var(--accent-primary, #6366f1);
	}

	.whiteboard-desktop-gate-icon svg {
		width: 1.8rem;
		height: 1.8rem;
	}

	.whiteboard-desktop-gate-title {
		margin: 0;
		font-size: var(--font-size-lg, 1.125rem);
		font-weight: var(--font-weight-bold, 700);
		color: var(--text-heading, #e0e0ff);
	}

	.whiteboard-desktop-gate-body {
		margin: 0;
		font-size: var(--font-size-sm, 0.875rem);
		line-height: var(--line-height-normal, 1.5);
		color: var(--text-secondary, #b3b3ff);
	}

	.whiteboard-desktop-gate-note {
		margin: 0;
		font-size: 0.72rem;
		color: var(--text-muted, #9999ff);
	}

	.whiteboard-stage {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: 1;
		height: 100%;
		min-height: 0;
		min-width: 0;
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

	.whiteboard-layer-panel-wrap {
		position: absolute;
		top: 4.25rem;
		right: 0.9rem;
		z-index: 25;
		width: min(380px, calc(100% - 1.8rem));
		pointer-events: auto;
	}

	.whiteboard-hidden-input {
		display: none;
	}

	.whiteboard-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: var(--space-3);
		padding: var(--space-8);
		text-align: center;
		color: var(--text-secondary, #b3b3ff);
	}

	.whiteboard-empty-icon {
		width: var(--space-16);
		height: var(--space-16);
		color: var(--text-muted, #9999ff);
		opacity: var(--opacity-50);
	}

	.whiteboard-empty-title {
		font-size: var(--font-size-lg);
		font-weight: var(--font-weight-bold);
		color: var(--text-heading, #e0e0ff);
		margin: 0;
	}

	.whiteboard-empty-desc {
		font-size: var(--font-size-sm);
		max-width: 320px;
		margin: 0;
		line-height: var(--line-height-normal);
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

		.whiteboard-stage :global(.wb-toolbar) {
			top: 10.5rem;
			left: 0.6rem;
			right: 0.6rem;
			transform: none;
			flex-wrap: wrap;
			justify-content: center;
			height: auto;
			padding: 8px 10px;
			border-radius: 12px;
		}

		.whiteboard-layer-panel-wrap {
			left: 0.6rem;
			right: 0.6rem;
			top: 16rem;
			width: auto;
		}
	}

	.whiteboard-jam-strip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: 0.15rem;
		padding-left: 0.55rem;
		border-left: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 18%, transparent);
	}

	.jam-avatars {
		display: inline-flex;
		align-items: center;
	}

	.jam-avatar {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.68rem;
		font-weight: 700;
		color: #ffffff;
		background: var(--jam-color, var(--accent-primary, #6366f1));
		border: 2px solid color-mix(in srgb, var(--surface-base, #24243e) 76%, transparent);
		margin-left: -0.35rem;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
	}

	.jam-avatar:first-child {
		margin-left: 0;
	}

	.jam-avatar-more {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 26%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.whiteboard-jam-call {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		margin-left: 0.2rem;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 26%, transparent);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 10%, transparent);
		color: var(--accent-primary, #6366f1);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		cursor: default;
		transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
	}

	.whiteboard-jam-call:hover {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 18%, transparent);
	}

	.whiteboard-jam-call svg {
		width: 13px;
		height: 13px;
	}

	@media (prefers-reduced-motion: reduce) {
		.whiteboard-grid-toggle { transition: none; }
		.whiteboard-jam-call { transition: none; }
		.whiteboard-settings-btn { transition: none; }
	}
</style>
