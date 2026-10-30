<script context="module" lang="ts">
	let trayCounter = 0;
</script>

<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { layoutStore, NOTES_DM_ID } from '$lib/layoutStore';
	import {
		pinnedDmChannelId,
		pinnedDmOtherUser,
		selectedDmChannelId,
		dmOtherUser
	} from '$lib/layoutStoreStates';
	import { channelMessages, currentUser, sendMessage, joinChannel, type Message, type User } from '$lib/socket';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import QuickScratchpad from './QuickScratchpad.svelte';

	/*
	 * The Scratchpad tray (design contract §7.21, §8.4): the companion's 80px footer band, on the
	 * same footer rule as the sidebar foot, the composer and the rail's "Add panels". Collapsed it
	 * names the scratchpad and where it is kept; expanded it grows upward (280px by default) with
	 * the editor above the band, so the chevron never moves. The top edge is a keyboard separator.
	 * A conversation pinned to the tray (or the one open in the DMs companion) gets its own view.
	 */

	let scratchpad: { openFull: () => void } | undefined;

	export let parentHeight = 600;

	const TRAY_MIN_HEIGHT = 200;
	const TRAY_DEFAULT_HEIGHT = 280;
	const TRAY_MAX_RATIO = 0.6;
	const TRAY_COLLAPSE_THRESHOLD = 150;
	const TRAY_STEP = 16;
	const TRAY_STEP_LARGE = 64;

	type TrayView = 'notes' | 'dm';

	const trayId = `scratchpad-tray-${++trayCounter}`;
	let trayHeight = TRAY_DEFAULT_HEIGHT;
	let collapsed = true;
	let isResizing = false;
	let resizeStartY = 0;
	let resizeStartHeight = TRAY_DEFAULT_HEIGHT;
	let activeView: TrayView = 'notes';
	let scratchStatus = '';

	$: maxHeight = Math.max(TRAY_MIN_HEIGHT, Math.floor(parentHeight * TRAY_MAX_RATIO));
	$: shownHeight = Math.max(TRAY_MIN_HEIGHT, Math.min(maxHeight, trayHeight));

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
	$: hasDm = Boolean(microDmChannelId && microDmOther);
	// The conversation view exists only while there is a conversation to show.
	$: if (!hasDm && activeView === 'dm') activeView = 'notes';
	$: showingDm = activeView === 'dm' && hasDm;
	$: viewOptions = [
		{ value: 'notes' as const, label: 'Scratchpad' },
		{ value: 'dm' as const, label: dmLabel ?? 'Conversation' }
	];

	let dmDraft = '';
	let dmListEl: HTMLDivElement | null = null;

	async function scrollDmToBottom(): Promise<void> {
		await tick();
		if (dmListEl) dmListEl.scrollTop = dmListEl.scrollHeight;
	}

	$: if (showingDm && !collapsed && recentDmMessages.length) {
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
		scratchpad?.openFull();
	}

	function openFullDms(): void {
		if (microDmChannelId && microDmOther) {
			layoutStore.openDM(microDmChannelId, microDmOther);
			joinChannel(microDmChannelId);
		} else {
			layoutStore.openRightPanel('dms');
		}
	}

	function unpinMicroDm(): void {
		pinnedDmChannelId.set(null);
		pinnedDmOtherUser.set(null);
	}

	onDestroy(() => {
		stopResize();
	});

	function startResize(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		isResizing = true;
		resizeStartY = event.clientY;
		resizeStartHeight = shownHeight;
		window.addEventListener('pointermove', handleResizeMove);
		window.addEventListener('pointerup', stopResize);
		window.addEventListener('pointercancel', stopResize);
	}

	function handleResizeMove(event: PointerEvent): void {
		if (!isResizing) return;
		const next = resizeStartHeight + (resizeStartY - event.clientY);
		if (next <= TRAY_COLLAPSE_THRESHOLD) {
			collapsed = true;
			return;
		}
		collapsed = false;
		trayHeight = Math.max(TRAY_MIN_HEIGHT, Math.min(maxHeight, next));
	}

	function stopResize(): void {
		isResizing = false;
		window.removeEventListener('pointermove', handleResizeMove);
		window.removeEventListener('pointerup', stopResize);
		window.removeEventListener('pointercancel', stopResize);
	}

	function handleSeparatorKeydown(event: KeyboardEvent): void {
		const step = event.shiftKey ? TRAY_STEP_LARGE : TRAY_STEP;
		let next: number | null = null;
		if (event.key === 'ArrowUp') next = shownHeight + step;
		else if (event.key === 'ArrowDown') next = shownHeight - step;
		else if (event.key === 'Home') next = TRAY_MIN_HEIGHT;
		else if (event.key === 'End') next = maxHeight;
		else if (event.key === 'Enter') {
			event.preventDefault();
			collapse();
			return;
		}
		if (next === null) return;
		event.preventDefault();
		trayHeight = Math.max(TRAY_MIN_HEIGHT, Math.min(maxHeight, next));
	}

	function resetHeight(): void {
		trayHeight = TRAY_DEFAULT_HEIGHT;
	}

	function collapse(): void {
		collapsed = true;
	}

	function expand(): void {
		collapsed = false;
		if (trayHeight < TRAY_MIN_HEIGHT) trayHeight = TRAY_DEFAULT_HEIGHT;
	}

	function toggle(): void {
		if (collapsed) expand();
		else collapse();
	}

	function formatTime(ts: number | undefined): string {
		if (!ts) return '';
		try {
			return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		} catch {
			return '';
		}
	}

	function isOwnMessage(msg: Message): boolean {
		return msg.userId === $currentUser?.id || msg.senderStableId === $currentUser?.id || msg.user === $currentUser?.username;
	}
</script>

<section
	class="scratch-tray"
	class:is-collapsed={collapsed}
	class:is-resizing={isResizing}
	style={collapsed ? undefined : `height: ${shownHeight}px;`}
	aria-label="Scratchpad tray"
>
	{#if !collapsed}
		<!-- A focusable window splitter (WAI-ARIA separator with a value): ↑/↓ resize, Enter collapses. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
		<div
			class="scratch-edge"
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize Scratchpad"
			aria-controls={`${trayId}-body`}
			aria-valuemin={TRAY_MIN_HEIGHT}
			aria-valuemax={maxHeight}
			aria-valuenow={shownHeight}
			tabindex="0"
			on:pointerdown={startResize}
			on:keydown={handleSeparatorKeydown}
			on:dblclick={resetHeight}
		></div>
	{/if}

	<div class="scratch-body" id={`${trayId}-body`} hidden={collapsed}>
		{#if hasDm}
			<div class="scratch-views">
				<Segmented mode="pressed" label="Tray view" options={viewOptions} bind:value={activeView} />
				{#if showingDm && $pinnedDmChannelId === microDmChannelId}
					<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={unpinMicroDm}>Unpin</button>
				{/if}
			</div>
		{/if}
		<!-- The scratchpad stays mounted while collapsed so the band reports its real save state. -->
		<div class="scratch-pane" hidden={showingDm}>
			<QuickScratchpad bind:this={scratchpad} bind:status={scratchStatus} showFull={false} showStatus={false} embedded />
		</div>
		{#if showingDm && microDmOther}
			<section class="micro-dm" aria-label={`Conversation with ${microDmOther.username}`}>
				<div class="micro-dm-list" bind:this={dmListEl}>
					{#if recentDmMessages.length === 0}
						<p class="micro-dm-empty">No messages yet.</p>
					{:else}
						{#each recentDmMessages as msg (msg.id || msg.clientMessageId)}
							<div class="micro-dm-row" class:own={isOwnMessage(msg)}>
								<span class="micro-dm-meta">{formatTime(msg.timestamp)}</span>
								<span class="micro-dm-text">{msg.text}</span>
							</div>
						{/each}
					{/if}
				</div>
				<div class="micro-dm-compose">
					<label class="w-field w-field--chrome micro-dm-field">
						<input
							type="text"
							bind:value={dmDraft}
							placeholder={`Message ${microDmOther.username}`}
							aria-label={`Message ${microDmOther.username}`}
							on:keydown={handleDmKeydown}
						/>
					</label>
					<button
						type="button"
						class="w-ibtn w-ibtn--sm w-ibtn--edge micro-dm-send"
						aria-label="Send"
						aria-disabled={!dmDraft.trim()}
						on:click={sendMicroDm}
					>
						<Icon name="send" size={16} />
					</button>
				</div>
			</section>
		{/if}
	</div>

	<!-- The footer band: on the same 80px rule as the sidebar foot and the composer. -->
	<div class="scratch-band">
		<label class="scratch-label" for={`${trayId}-toggle`}>
			<span class="scratch-glyph" aria-hidden="true"><Icon name={showingDm ? 'dm' : 'note'} size={18} /></span>
			<span class="scratch-words">
				<span class="scratch-title">{showingDm ? dmLabel : 'Scratchpad'}</span>
				{#if showingDm}
					<span class="scratch-status">{$pinnedDmChannelId === microDmChannelId ? 'Pinned conversation' : 'Open in DMs'}</span>
				{:else}
					<span class="scratch-status" role="status">{scratchStatus || 'Saved on this device'}</span>
				{/if}
			</span>
		</label>
		{#if !collapsed}
			<button
				type="button"
				class="w-ibtn w-ibtn--sm"
				aria-label={showingDm ? 'Open conversation in DMs' : 'Open in Notes'}
				title={showingDm ? 'Open conversation in DMs' : 'Open in Notes'}
				on:click={showingDm ? openFullDms : openFullNotes}
			>
				<Icon name="expand" size={16} />
			</button>
		{/if}
		<button
			type="button"
			id={`${trayId}-toggle`}
			class="w-ibtn w-ibtn--sm scratch-toggle"
			aria-expanded={!collapsed}
			aria-controls={`${trayId}-body`}
			aria-label={collapsed ? 'Expand Scratchpad' : 'Collapse Scratchpad'}
			on:click={toggle}
		>
			<Icon name={collapsed ? 'chevUp' : 'chevDown'} size={16} />
		</button>
	</div>
</section>

<style>
	/* The tray paints no surface of its own: it sits on the companion's flat --w-bg2 body. */
	.scratch-tray {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: none;
		box-sizing: border-box;
		min-height: 0;
		border-top: var(--w-bw) solid var(--w-line);
		color: var(--w-text);
		font: var(--w-t-ui);
	}
	.scratch-tray.is-collapsed {
		height: var(--w-foot);
	}
	.scratch-tray.is-resizing {
		user-select: none;
	}

	:global(.mobile-workspace) .scratch-tray {
		display: none;
	}

	/* Resize edge: invisible at rest, a 2px accent line on hover, focus or drag. */
	.scratch-edge {
		position: absolute;
		top: -4px;
		left: 0;
		right: 0;
		z-index: 2;
		height: 8px;
		cursor: ns-resize;
		touch-action: none;
	}
	.scratch-edge::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		top: 3px;
		height: 2px;
		background: transparent;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.scratch-edge:hover::after,
	.scratch-edge:focus-visible::after,
	.scratch-tray.is-resizing .scratch-edge::after {
		background: var(--w-accent);
	}
	.scratch-edge:focus-visible {
		outline: none;
	}

	.scratch-body {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
	}
	.scratch-body[hidden],
	.scratch-pane[hidden] {
		display: none;
	}
	.scratch-pane {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
	}
	.scratch-views {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px 2px 16px;
	}
	.scratch-views :global(.w-seg) {
		min-width: 0;
		max-width: 100%;
	}

	/* ---------- the band ---------- */
	.scratch-band {
		display: flex;
		flex: none;
		align-items: center;
		gap: 4px;
		box-sizing: border-box;
		height: calc(var(--w-foot) - var(--w-bw));
		padding: 0 12px 0 20px;
	}
	.scratch-tray:not(.is-collapsed) .scratch-band {
		border-top: var(--w-bw) solid var(--w-line);
		height: var(--w-foot);
	}
	.scratch-label {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 12px;
		min-width: 0;
		cursor: pointer;
	}
	.scratch-glyph {
		display: grid;
		flex: none;
		place-items: center;
		color: var(--w-mute);
	}
	.scratch-words {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.scratch-title {
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-label);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.scratch-status {
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-micro);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.scratch-band .w-ibtn:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}

	/* ---------- the conversation view ---------- */
	.micro-dm {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
	}
	.micro-dm-list {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 6px;
		min-height: 0;
		overflow-y: auto;
		padding: 8px 16px;
	}
	.micro-dm-empty {
		margin: 0;
		padding: 8px 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.micro-dm-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
		align-self: flex-start;
		max-width: 92%;
	}
	.micro-dm-row.own {
		align-self: flex-end;
		text-align: end;
	}
	.micro-dm-meta {
		color: var(--w-faint);
		font: var(--w-t-micro);
	}
	.micro-dm-text {
		color: var(--w-text);
		font: var(--w-t-small);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.micro-dm-compose {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		padding: 6px 12px 10px 16px;
	}
	.micro-dm-field {
		flex: 1 1 auto;
	}
	:global(:root) .micro-dm-field > input[type='text'] {
		min-height: 0;
		height: 100%;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		color: var(--w-text);
		font: inherit;
		outline: none;
	}
	.micro-dm-send[aria-disabled='true'] {
		opacity: 0.45;
		cursor: not-allowed;
	}

	@media (pointer: coarse) {
		.scratch-band .w-ibtn {
			width: 44px;
			height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.scratch-edge::after {
			transition: none;
		}
	}
</style>
