<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { layoutStore, NOTES_DM_ID } from '$lib/layoutStore';
	import {
		pinnedDmChannelId,
		pinnedDmOtherUser,
		selectedDmChannelId,
		dmOtherUser
	} from '$lib/layoutStoreStates';
	import { channelMessages, currentUser, sendMessage, type Message, type User } from '$lib/socket';
	import {
		getQuickScratchpadStorageKey,
		readScratchpadText,
		writeScratchpadText
	} from '$lib/notesStore';

	export let parentHeight = 600;

	const QUICK_MIN_HEIGHT = 160;
	const QUICK_DEFAULT_HEIGHT = 240;
	const QUICK_MAX_RATIO = 0.56;
	const QUICK_COLLAPSED_BAR_HEIGHT = 44;
	const QUICK_COLLAPSE_THRESHOLD = 130;

	type MicroTab = 'notes' | 'dm';

	let quickPanelHeight = QUICK_DEFAULT_HEIGHT;
	let quickPanelCollapsed = false;
	let isResizingQuick = false;
	let quickResizeStartY = 0;
	let quickResizeStartHeight = QUICK_DEFAULT_HEIGHT;
	let activeTab: MicroTab = 'notes';

	// --- Scratchpad (inline notes; not full N1–N4 workspace) ---
	let loadedStorageKey = '';
	let scratchpadText = '';
	let saveState: 'saved' | 'unsaved' = 'saved';
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	const SAVE_DELAY_MS = 650;

	$: storageKey = getQuickScratchpadStorageKey($currentUser?.id);
	$: if (storageKey && storageKey !== loadedStorageKey) {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		loadedStorageKey = storageKey;
		scratchpadText = readScratchpadText(storageKey);
		saveState = 'saved';
	}

	function updateScratchpad(value: string): void {
		scratchpadText = value;
		saveState = 'unsaved';
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			writeScratchpadText(storageKey, value);
			saveState = 'saved';
			persistTimer = null;
		}, SAVE_DELAY_MS);
	}

	// --- Compact DM slot: prefer pinned aux, else active right-panel DM ---
	// Never bind NOTES_DM_ID (__keep_notes__) — openNotes() would hijack this slot.
	$: rawDmId = $pinnedDmChannelId || $selectedDmChannelId;
	$: microDmChannelId = rawDmId && rawDmId !== NOTES_DM_ID ? rawDmId : null;
	$: microDmOther = (
		$pinnedDmChannelId
			? $pinnedDmOtherUser
			: $selectedDmChannelId && $selectedDmChannelId !== NOTES_DM_ID
				? $dmOtherUser
				: null
	) as User | null;
	$: microDmMessages = (microDmChannelId ? $channelMessages[microDmChannelId] || [] : []) as Message[];
	$: recentDmMessages = microDmMessages.slice(-8);
	$: dmLabel = microDmOther?.username || (microDmChannelId ? 'Direct message' : null);

	let dmDraft = '';
	let dmListEl: HTMLDivElement | null = null;

	async function scrollDmToBottom(): Promise<void> {
		await tick();
		if (dmListEl) dmListEl.scrollTop = dmListEl.scrollHeight;
	}

	$: if (activeTab === 'dm' && recentDmMessages.length) {
		void scrollDmToBottom();
	}

	function sendMicroDm(): void {
		const text = dmDraft.trim();
		if (!text || !microDmChannelId) return;
		void sendMessage(microDmChannelId, text, 'text');
		dmDraft = '';
		void scrollDmToBottom();
	}

	function handleDmKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendMicroDm();
		}
	}

	function openFullNotes(): void {
		layoutStore.openNotes();
	}

	function openFullDms(): void {
		if (microDmChannelId && microDmOther) {
			layoutStore.openDM(microDmChannelId, microDmOther);
		} else {
			layoutStore.openRightPanel('dms');
		}
	}

	function unpinMicroDm(): void {
		pinnedDmChannelId.set(null);
		pinnedDmOtherUser.set(null);
	}

	onDestroy(() => {
		stopQuickResize();
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		if (saveState === 'unsaved' && storageKey) {
			writeScratchpadText(storageKey, scratchpadText);
			saveState = 'saved';
		}
	});

	function startQuickResize(event: MouseEvent): void {
		event.preventDefault();
		isResizingQuick = true;
		quickResizeStartY = event.clientY;
		quickResizeStartHeight = quickPanelHeight;
		window.addEventListener('mousemove', handleQuickResizeMove);
		window.addEventListener('mouseup', stopQuickResize);
	}

	function handleQuickResizeMove(event: MouseEvent): void {
		if (!isResizingQuick) return;
		const delta = quickResizeStartY - event.clientY;
		const maxHeight = Math.floor(parentHeight * QUICK_MAX_RATIO);
		const nextHeight = quickResizeStartHeight + delta;
		if (nextHeight <= QUICK_COLLAPSE_THRESHOLD) {
			quickPanelCollapsed = true;
			return;
		}
		quickPanelCollapsed = false;
		quickPanelHeight = Math.max(QUICK_MIN_HEIGHT, Math.min(maxHeight, nextHeight));
	}

	function stopQuickResize(): void {
		isResizingQuick = false;
		window.removeEventListener('mousemove', handleQuickResizeMove);
		window.removeEventListener('mouseup', stopQuickResize);
	}

	function collapseQuickPanel(): void {
		quickPanelCollapsed = true;
	}

	function expandQuickPanel(): void {
		quickPanelCollapsed = false;
		if (quickPanelHeight < QUICK_MIN_HEIGHT) quickPanelHeight = QUICK_DEFAULT_HEIGHT;
	}

	function formatTime(ts: number | undefined): string {
		if (!ts) return '';
		try {
			return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		} catch {
			return '';
		}
	}
</script>

<div
	class="quick-resources"
	class:is-collapsed={quickPanelCollapsed}
	style={`height: ${quickPanelCollapsed ? QUICK_COLLAPSED_BAR_HEIGHT : quickPanelHeight}px;`}
>
	{#if quickPanelCollapsed}
		<div class="quick-collapsed-bar">
			<span class="quick-kicker">Quick</span>
			<div class="quick-collapsed-summary">
				<span class="quick-sub">
					{activeTab === 'notes' ? 'Notes' : dmLabel ? `DM · ${dmLabel}` : 'DM'}
				</span>
			</div>
			<button
				class="quick-collapse-btn"
				type="button"
				title="Expand quick panel"
				aria-label="Expand quick panel"
				on:click={expandQuickPanel}
			>
				<!-- caret ^ -->
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<polyline points="18 15 12 9 6 15"></polyline>
				</svg>
			</button>
		</div>
	{:else}
		<button
			class="quick-resize-handle"
			type="button"
			on:mousedown={startQuickResize}
			title="Drag down to collapse"
			aria-label="Resize or collapse bottom panel"
		></button>

		<div class="quick-header">
			<div class="quick-tabs" role="tablist" aria-label="Quick panel">
				<button
					type="button"
					class="quick-tab"
					class:active={activeTab === 'notes'}
					role="tab"
					aria-selected={activeTab === 'notes'}
					on:click={() => (activeTab = activeTab === 'notes' ? 'dm' : 'notes')}
				>
					Notes
				</button>
				<button
					type="button"
					class="quick-tab"
					class:active={activeTab === 'dm'}
					role="tab"
					aria-selected={activeTab === 'dm'}
					on:click={() => (activeTab = activeTab === 'dm' ? 'notes' : 'dm')}
				>
					{dmLabel ? `DM · ${dmLabel}` : 'DM'}
				</button>
			</div>

			<div class="quick-header-actions">
				{#if activeTab === 'notes'}
					<button class="quick-link-btn" type="button" title="Open full notes" on:click={openFullNotes}>
						Full
					</button>
				{:else}
					<button class="quick-link-btn" type="button" title="Open messages panel" on:click={openFullDms}>
						Open
					</button>
				{/if}
				<button
					class="quick-collapse-btn"
					type="button"
					title="Collapse quick panel"
					aria-label="Collapse quick panel"
					on:click={collapseQuickPanel}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<polyline points="6 9 12 15 18 9"></polyline>
					</svg>
				</button>
			</div>
		</div>

		<div class="quick-body">
			{#if activeTab === 'notes'}
				<section class="micro-notes" aria-label="Quick notes">
					<textarea
						class="micro-notes-input"
						value={scratchpadText}
						on:input={(event) =>
							updateScratchpad((event.currentTarget as HTMLTextAreaElement).value)}
						placeholder="Quick note — auto-saves."
						spellcheck="true"
					></textarea>
					<div class="micro-footer">
						<span class:dirty={saveState === 'unsaved'}>
							{saveState === 'saved' ? 'Saved' : 'Unsaved'}
						</span>
						<span class="micro-hint">Scratchpad · not full notes workspace</span>
					</div>
				</section>
			{:else}
				<section class="micro-dm" aria-label="Quick DM">
					{#if !microDmChannelId || !microDmOther}
						<div class="micro-dm-empty">
							<p>No DM pinned here.</p>
							<p class="micro-hint">Open Messages, pick a chat, or pin one to keep it in this slot.</p>
							<button class="quick-link-btn primary" type="button" on:click={openFullDms}>
								Open messages
							</button>
						</div>
					{:else}
						<div class="micro-dm-head">
							<span class="micro-dm-name">{microDmOther.username}</span>
							{#if $pinnedDmChannelId === microDmChannelId}
								<button
									class="quick-link-btn"
									type="button"
									title="Unpin from quick slot"
									on:click={unpinMicroDm}
								>
									Unpin
								</button>
							{/if}
						</div>
						<div class="micro-dm-list" bind:this={dmListEl}>
							{#if recentDmMessages.length === 0}
								<div class="micro-dm-empty-inline">No messages yet — say hi.</div>
							{:else}
								{#each recentDmMessages as msg (msg.id || msg.clientMessageId)}
									<div
										class="micro-dm-row"
										class:own={msg.userId === $currentUser?.id ||
											msg.senderStableId === $currentUser?.id ||
											msg.user === $currentUser?.username}
									>
										<span class="micro-dm-meta">{formatTime(msg.timestamp)}</span>
										<span class="micro-dm-text">{msg.text}</span>
									</div>
								{/each}
							{/if}
						</div>
						<div class="micro-dm-compose">
							<input
								class="micro-dm-input"
								type="text"
								bind:value={dmDraft}
								placeholder={`Message ${microDmOther.username}…`}
								on:keydown={handleDmKeydown}
							/>
							<button
								class="quick-link-btn primary"
								type="button"
								disabled={!dmDraft.trim()}
								on:click={sendMicroDm}
							>
								Send
							</button>
						</div>
					{/if}
				</section>
			{/if}
		</div>
	{/if}
</div>

<style>
	.quick-resources {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 86%, transparent);
		background:
			radial-gradient(circle at bottom right, rgba(var(--accent-rgb), 0.12), transparent 38%),
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--surface-base) 94%, transparent),
				color-mix(in srgb, var(--surface-raised) 82%, transparent)
			);
		overflow: hidden;
	}

	:global(.mobile-workspace) .quick-resources {
		display: none;
	}

	.quick-resize-handle {
		height: 8px;
		border: none;
		background: transparent;
		cursor: ns-resize;
		padding: 0;
		flex-shrink: 0;
	}

	.quick-header,
	.quick-collapsed-bar {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.4rem 0.65rem;
		flex-shrink: 0;
	}

	.quick-header {
		justify-content: space-between;
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
	}

	.quick-collapsed-bar {
		justify-content: space-between;
		height: 100%;
	}

	.quick-collapsed-summary {
		flex: 1;
		min-width: 0;
	}

	.quick-tabs {
		display: inline-flex;
		gap: 0.25rem;
		min-width: 0;
		flex: 1;
	}

	.quick-tab {
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 650;
		padding: 0.3rem 0.55rem;
		border-radius: 8px;
		cursor: pointer;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.quick-tab:hover {
		color: var(--text-heading);
		background: rgba(var(--accent-rgb), 0.08);
	}

	.quick-tab.active {
		color: var(--text-heading);
		border-color: color-mix(in srgb, var(--border-subtle) 80%, transparent);
		background: color-mix(in srgb, var(--surface-raised) 90%, transparent);
	}

	.quick-header-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 0;
	}

	.quick-kicker {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-primary-color, var(--text-secondary));
		white-space: nowrap;
	}

	.quick-sub {
		font-size: 0.72rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.quick-collapse-btn {
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}

	.quick-collapse-btn:hover {
		background: rgba(var(--accent-rgb), 0.12);
		color: var(--text-heading);
	}

	.quick-collapse-btn svg {
		width: 16px;
		height: 16px;
	}

	.quick-link-btn {
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		background: color-mix(in srgb, var(--surface-raised) 88%, transparent);
		color: var(--text-heading);
		font-size: 0.7rem;
		font-weight: 650;
		padding: 0.28rem 0.55rem;
		border-radius: 8px;
		cursor: pointer;
	}

	.quick-link-btn:hover {
		border-color: rgba(var(--accent-rgb), 0.45);
		background: rgba(var(--accent-rgb), 0.1);
	}

	.quick-link-btn.primary {
		background: rgba(var(--accent-rgb), 0.18);
		border-color: rgba(var(--accent-rgb), 0.4);
	}

	.quick-link-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.quick-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.micro-notes,
	.micro-dm {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.micro-notes-input {
		flex: 1;
		min-height: 0;
		width: 100%;
		resize: none;
		border: none;
		outline: none;
		background: transparent;
		color: var(--text-heading);
		padding: 0.65rem 0.75rem;
		font-size: 0.82rem;
		line-height: 1.5;
		font-family: inherit;
	}

	.micro-notes-input::placeholder {
		color: var(--text-muted);
	}

	.micro-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.75rem 0.5rem;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
		font-size: 0.68rem;
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.micro-footer .dirty {
		color: color-mix(in srgb, var(--color-warning, #f59e0b) 78%, var(--text-heading) 22%);
	}

	.micro-hint {
		color: var(--text-muted);
		font-size: 0.68rem;
	}

	.micro-dm-empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 0.45rem;
		padding: 0.85rem;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.micro-dm-empty p {
		margin: 0;
	}

	.micro-dm-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.35rem 0.65rem;
		border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 70%, transparent);
		flex-shrink: 0;
	}

	.micro-dm-name {
		font-size: 0.78rem;
		font-weight: 650;
		color: var(--text-heading);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.micro-dm-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.4rem 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.micro-dm-empty-inline {
		color: var(--text-muted);
		font-size: 0.75rem;
		padding: 0.5rem 0;
	}

	.micro-dm-row {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		max-width: 92%;
		padding: 0.3rem 0.45rem;
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-raised) 70%, transparent);
		align-self: flex-start;
	}

	.micro-dm-row.own {
		align-self: flex-end;
		background: rgba(var(--accent-rgb), 0.14);
	}

	.micro-dm-meta {
		font-size: 0.62rem;
		color: var(--text-muted);
	}

	.micro-dm-text {
		font-size: 0.78rem;
		color: var(--text-heading);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.micro-dm-compose {
		display: flex;
		gap: 0.35rem;
		padding: 0.4rem 0.55rem 0.55rem;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
		flex-shrink: 0;
	}

	.micro-dm-input {
		flex: 1;
		min-width: 0;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
		background: color-mix(in srgb, var(--surface-input, var(--surface-base)) 92%, transparent);
		color: var(--text-heading);
		border-radius: 8px;
		padding: 0.35rem 0.55rem;
		font-size: 0.78rem;
		outline: none;
	}

	.micro-dm-input:focus {
		border-color: rgba(var(--accent-rgb), 0.5);
	}

	@media (prefers-reduced-motion: reduce) {
		.quick-collapse-btn,
		.quick-tab,
		.quick-link-btn {
			transition: none;
		}
	}
</style>
