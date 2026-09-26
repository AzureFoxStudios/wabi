<script lang="ts">
	import { afterUpdate, createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { pushLocalDirectionsCard } from '$lib/directionsAssist';
	import { cachedE2eeStatus, chooseServerReadable, prepareNewConversationEncryption, rekeyE2ee, turnOnE2ee } from '$lib/dm/dmE2eeState';
	import type { E2eeRoomStatus } from '$lib/e2ee';
	import { getLineDmResolvedProfile, lineDmAddonStore } from '$lib/lineDmAddon';
	import { openPreferredMapSurface } from '$lib/mapWorkspace';
	import { paymentAccessStore } from '$lib/payments/paymentAccessStore';
	import { channelMessagesStore, channelHasMoreHistory, channelHistoryLoading, channels, currentUser, users, serverMembers, getSocket, joinChannel, loadHistory, loadOlderHistory, markChannelAsRead, sendMessage, syncNewerMessages, updateChannelSettings, type Channel, type Message, type User } from '$lib/socket';
	import { missingDeviceParticipantLabel } from '$lib/dmPresentation';
	import { showToast } from '$lib/toast';
	import {
		DEFAULT_DM_RETENTION,
		normalizeMessageRetentionDuration
	} from '../../../../shared/messageRetention.js';
	import ChatComposer from './chat/ChatComposer.svelte';
	import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
	import DmRetentionControl from './DmRetentionControl.svelte';
	import { filterMessages } from './chat/search';
	import { formatTypingUsers } from './chat/typing';
	import { channelPaneInTransition, channelPaneOutTransition } from './chat/transitions';
	import SharedConversationNotes from './SharedConversationNotes.svelte';
	import PaymentSheet from '$lib/payments/PaymentSheet.svelte';

	export let channelId: string;
	export let otherUser: User;
	export let channel: Channel | undefined = undefined;

	const dispatch = createEventDispatcher<{ openSettings: { paymentSurface: 'connections' } }>();
	let chatComposer: ChatComposer;
	let messagesContainer: HTMLDivElement;
	let replyingTo: Message | null = null;
	let composerVisible = true;
	let isTextareaFocused = false;
	let showNotes = false;
	let notesMounted = false;
	let paymentSheetOpen = false;
	let paymentSheetOpenSeed = 0;
	let paymentPrefill: { amountInput?: string | null; description?: string | null; customerRef?: string | null } = {};
	let joinedChannelId = '';
	let statusChannelId = '';
	let e2eeStatus: E2eeRoomStatus | null = null;
	let e2eeBusy = false;
	let e2eeChecking = false;
	let e2eeError = '';
	let mounted = true;
	let followLatest = true;
	let showJumpToLatest = false;
	let lastMessageKey = '';
	let olderAnchor: { channelId: string; firstId: string; height: number; top: number } | null = null;

	$: activeChannel = $channels.find((entry) => entry.id === channelId) || channel;
	$: isGroup = activeChannel?.type === 'group';
	$: displayName = isGroup ? activeChannel?.name || 'Group message' : otherUser?.username || 'Direct message';
	$: messagesForChannel = channelMessagesStore(channelId);
	$: messages = $messagesForChannel || [];
	$: filteredMessages = filterMessages(messages, '', Number.POSITIVE_INFINITY);
	$: pinnedMessages = messages.filter((message: Message) => message.isPinned);
	$: selectedRetention = activeChannel?.autoDeleteAfter === null || String(activeChannel?.autoDeleteAfter) === 'forever'
		? ''
		: activeChannel?.autoDeleteAfter || DEFAULT_DM_RETENTION;
	$: paymentButtonEnabled = Boolean($currentUser?.dbUserId) && Boolean(getAuthToken()) && $paymentAccessStore.loaded && $paymentAccessStore.canCreate;
	$: lineDmProfile = getLineDmResolvedProfile(channelId, $lineDmAddonStore);
	$: missingDeviceLabel = missingDeviceParticipantLabel(e2eeStatus?.missingUserIds || [], [...$serverMembers, ...$users]);
	$: wallpaperUrl = $lineDmAddonStore.enabled && lineDmProfile.wallpaperUrl ? `url("${lineDmProfile.wallpaperUrl}")` : 'none';
	$: if (channelId && channelId !== joinedChannelId) {
		joinedChannelId = channelId;
		showNotes = false;
		notesMounted = false;
		olderAnchor = null;
		joinChannel(channelId);
		loadHistory(channelId, { limit: 50 });
		void syncNewerMessages(channelId);
		followLatest = true;
		showJumpToLatest = false;
	}
	$: if (channelId && channelId !== statusChannelId) {
		const requestedChannelId = channelId;
		statusChannelId = requestedChannelId;
		e2eeStatus = cachedE2eeStatus(requestedChannelId);
		e2eeError = '';
		void loadE2eeStatus(requestedChannelId);
	}

	async function loadE2eeStatus(targetChannelId: string): Promise<void> {
		e2eeChecking = true;
		try {
			const status = await prepareNewConversationEncryption(targetChannelId);
			if (mounted && channelId === targetChannelId) { e2eeStatus = status; e2eeError = ''; }
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = error instanceof Error ? error.message : 'Could not check encryption. Try again.';
		} finally {
			if (mounted && channelId === targetChannelId) e2eeChecking = false;
		}
	}

	async function useServerReadable(): Promise<void> {
		if (!channelId || e2eeBusy) return;
		const targetChannelId = channelId;
		e2eeBusy = true;
		e2eeError = '';
		try {
			const status = await chooseServerReadable(targetChannelId);
			if (mounted && channelId === targetChannelId) e2eeStatus = status;
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = error instanceof Error ? error.message : 'Could not change conversation mode.';
		} finally {
			if (mounted) e2eeBusy = false;
		}
	}

	async function updateEncryptionKeys(): Promise<void> {
		if (!channelId || e2eeBusy) return;
		const targetChannelId = channelId;
		e2eeBusy = true;
		e2eeError = '';
		try {
			const status = await rekeyE2ee(targetChannelId);
			if (mounted && channelId === targetChannelId) {
				if (status) e2eeStatus = status;
				else e2eeError = 'Could not update encryption keys. Check participant devices and try again.';
			}
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = error instanceof Error ? error.message : 'Could not update encryption keys. Try again.';
		} finally {
			if (mounted) e2eeBusy = false;
		}
	}

	function handleRetentionChange(event: Event): void {
		const select = event.currentTarget as HTMLSelectElement;
		if (!activeChannel) return;
		const next = normalizeMessageRetentionDuration(select.value);
		// The control reflects the server-confirmed policy, not a speculative
		// selection that might fail to persist while this device is offline.
		select.value = selectedRetention;
		void updateChannelSettings(activeChannel.id, { autoDeleteAfter: next });
	}

	function openPaymentSheet(prefill: { amountInput?: string | null; description?: string | null; customerRef?: string | null } = {}): void {
		if (!paymentButtonEnabled) {
			showToast('Sign in with a registered account to create payments.', 'warning');
			return;
		}
		paymentPrefill = prefill;
		paymentSheetOpenSeed += 1;
		paymentSheetOpen = true;
	}

	async function enableE2ee(): Promise<void> {
		if (e2eeBusy || !channelId) return;
		const targetChannelId = channelId;
		e2eeBusy = true;
		e2eeError = '';
		try {
			const status = await turnOnE2ee(targetChannelId);
			if (!mounted || targetChannelId !== channelId) return;
			if (status) e2eeStatus = status;
			else e2eeError = 'Could not enable encryption on this device. Try again after reconnecting.';
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = error instanceof Error ? error.message : 'Could not enable encryption. Try again.';
		} finally {
			if (mounted) e2eeBusy = false;
		}
	}

	async function executeCommand(command: string): Promise<void> {
		const [name, ...args] = command.slice(1).trim().split(/\s+/);
		if (name === 'pay' || name === 'payment') {
			if (!paymentButtonEnabled) throw new Error('Sign in with a registered account to create payments.');
			openPaymentSheet({ amountInput: args[0] || '', description: args.slice(1).join(' ') });
			return;
		}
		if (name === 'directions' || name === 'dir' || name === 'where') {
			const target = args.join(' ').trim();
			if (!target) throw new Error('Enter a place after /directions.');
			if (!(await pushLocalDirectionsCard(channelId, target))) throw new Error(`Place "${target}" was not found.`);
			return;
		}
		const result = await sendMessage(channelId, command, 'text');
		if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
			throw new Error('Command was not sent. Try again.');
		}
	}

	function handleReply(message: Message): void {
		replyingTo = message;
		chatComposer?.focus();
	}

	function handleQuickMention(message: Message): void {
		chatComposer?.insertQuickMention(message.user);
	}

	function toggleSharedNotes(): void {
		showNotes = !showNotes;
		if (showNotes) notesMounted = true;
	}

	function handleScroll(): void {
		if (!messagesContainer) return;
		followLatest = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;
		showJumpToLatest = !followLatest && messages.length > 0;
		if (messagesContainer.scrollTop < 72) loadEarlier();
	}

	function loadEarlier(): void {
		if (!channelId || !messagesContainer || olderAnchor || !$channelHasMoreHistory[channelId] || $channelHistoryLoading[channelId]) return;
		const firstId = messages.find((message: Message) => message.id && !message.id.startsWith('optimistic:'))?.id;
		if (!firstId) return;
		olderAnchor = { channelId, firstId, height: messagesContainer.scrollHeight, top: messagesContainer.scrollTop };
		followLatest = false;
		loadOlderHistory(channelId);
	}

	function markVisibleMessagesRead(): void {
		if (channelId && document.visibilityState === 'visible' && messagesContainer?.getClientRects().length) {
			markChannelAsRead(channelId);
		}
	}

	async function scrollToLatest(): Promise<void> {
		followLatest = true;
		showJumpToLatest = false;
		await tick();
		messagesContainer?.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
		markVisibleMessagesRead();
	}

	afterUpdate(() => {
		if (olderAnchor && olderAnchor.channelId !== channelId) olderAnchor = null;
		if (olderAnchor && messagesContainer) {
			const firstId = messages.find((message: Message) => message.id && !message.id.startsWith('optimistic:'))?.id;
			if (firstId && firstId !== olderAnchor.firstId) {
				messagesContainer.scrollTop = olderAnchor.top + messagesContainer.scrollHeight - olderAnchor.height;
				olderAnchor = null;
			} else if (!$channelHistoryLoading[channelId]) {
				olderAnchor = null;
			}
		}
		const newest = messages.at(-1);
		const nextKey = `${channelId}:${messages.length}:${newest?.id || ''}`;
		if (nextKey !== lastMessageKey) {
			lastMessageKey = nextKey;
			if (followLatest && messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
			markVisibleMessagesRead();
		}
	});

	onMount(() => {
		document.addEventListener('visibilitychange', markVisibleMessagesRead);
		void tick().then(markVisibleMessagesRead);
		let observedSocket: ReturnType<typeof getSocket> = null;
		const onEncryptionUpdate = (payload: { channelId?: string }) => {
			if (payload?.channelId === channelId) void loadE2eeStatus(channelId);
		};
		const bindSocket = () => {
			const next = getSocket();
			if (next === observedSocket) return;
			observedSocket?.off('e2ee-room-updated', onEncryptionUpdate);
			observedSocket = next;
			observedSocket?.on('e2ee-room-updated', onEncryptionUpdate);
			if (next && channelId) void loadE2eeStatus(channelId);
		};
		const onFocus = () => { if (channelId) void loadE2eeStatus(channelId); };
		window.addEventListener('focus', onFocus);
		bindSocket();
		const poll = window.setInterval(() => {
			bindSocket();
			if (channelId && e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.serverReadableSelected && !e2eeChecking && !e2eeBusy) void loadE2eeStatus(channelId);
		}, 5000);
		return () => {
			document.removeEventListener('visibilitychange', markVisibleMessagesRead);
			window.removeEventListener('focus', onFocus);
			observedSocket?.off('e2ee-room-updated', onEncryptionUpdate);
			window.clearInterval(poll);
		};
	});

	onDestroy(() => { mounted = false; });
</script>

<div
	class="dm-message-view"
	class:wallpaper-enabled={$lineDmAddonStore.enabled && Boolean(lineDmProfile.wallpaperUrl)}
	style:--dm-wallpaper-url={wallpaperUrl}
	style:--dm-wallpaper-opacity={String(lineDmProfile.wallpaperOpacity)}
	style:--dm-wallpaper-blur={`${lineDmProfile.wallpaperBlur}px`}
	style:--dm-wallpaper-size={lineDmProfile.wallpaperSize}
	style:--dm-wallpaper-position={lineDmProfile.wallpaperPosition}
	style:--dm-wallpaper-repeat={lineDmProfile.wallpaperRepeat}
>
	<div class="dm-conversation-tools">
		<DmRetentionControl value={selectedRetention} onChange={handleRetentionChange} compact />
		<div class="dm-tool-actions">
			{#if e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.pendingDefault && e2eeStatus.missingUserIds.length === 0}
				<button type="button" class="dm-tool-button" on:click={() => void enableE2ee()} disabled={e2eeBusy} title="Turn on experimental encryption for new messages. Device identities and the complete client are not independently verified.">
					{e2eeBusy ? 'Enabling…' : 'Encrypt new messages'}
				</button>
			{/if}
			{#if e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.pendingDefault && !e2eeStatus.serverReadableSelected && e2eeStatus.missingUserIds.length > 0}<span class="dm-tool-wait" role="status">Waiting for participant devices: {missingDeviceLabel}. New messages remain server-readable until encryption starts.</span>{/if}
			{#if e2eeStatus?.serverReadableSelected && e2eeStatus.serverReadableAllowedByMe}<span class="dm-tool-encryption-status">Server-readable by choice</span>{/if}
			{#if e2eeStatus?.enabled}<span class="dm-tool-encryption-status" title="New messages are encrypted. Earlier messages keep their previous protection. Device identities and the complete client have not been independently verified.">New messages encrypted · experimental</span>{/if}
			{#if e2eeStatus?.pendingDefault}<span class="dm-tool-encryption-status">Encryption pending</span>{/if}
			{#if e2eeStatus?.serverReadableSelected && !e2eeStatus.serverReadableAllowedByMe}<span class="dm-tool-encryption-status">Your confirmation needed</span>{/if}
			<button type="button" class="dm-tool-button" on:click={() => void openPreferredMapSurface()} title="Open map">Map</button>
			<button type="button" class="dm-tool-button" on:click={() => openPaymentSheet()} disabled={!paymentButtonEnabled} title="Create payment request">Pay</button>
			<button type="button" class="dm-tool-button" class:active={showNotes} aria-pressed={showNotes} on:click={toggleSharedNotes}>Shared notes</button>
		</div>
	</div>
	{#if e2eeError}<div class="dm-tool-error" role="alert">{e2eeError}</div>{/if}

	<div class="dm-conversation-content" class:with-notes={showNotes}>
		<div class="dm-conversation-main">
			<div class="dm-conversation-messages" bind:this={messagesContainer} on:scroll={handleScroll}>
				{#if $channelHasMoreHistory[channelId]}
					<button type="button" class="dm-load-earlier" disabled={$channelHistoryLoading[channelId]} on:click={loadEarlier}>
						{$channelHistoryLoading[channelId] ? 'Loading earlier messages…' : 'Load earlier messages'}
					</button>
				{/if}
				<ChatMessagesPane
					currentChannel={channelId}
					messageDomScope="dm-right"
					searchInput=""
					channelDisplayName={displayName}
					{filteredMessages}
					{pinnedMessages}
					firstUnreadMessageId={null}
					channelPaneAnimation={{ enabled: false, preset: 'slip', duration: 120, distance: 18 }}
					searchBackfillBusy={false}
					currentChannelPersistMessages={false}
					isFullHistorySearchRunning={false}
					fullHistorySearchPagesLoaded={0}
					fullHistorySearchStatus=""
					visibleTypingUsers={[]}
					emptyStateIcon={isGroup ? '◎' : '@'}
					emptyStateSubtitle={isGroup ? 'Start the conversation with your group.' : `Start a conversation with ${displayName}.`}
					emptyStateActionLabel="Write a message"
					{channelPaneInTransition}
					{channelPaneOutTransition}
					formatTypingUsers={(names: string[]) => formatTypingUsers(names)}
					onSearchCurrentQueryInBrowser={() => {}}
					onToggleFullHistorySearchBackfill={() => {}}
					onReply={handleReply}
					onQuickMention={handleQuickMention}
					onOpenSettings={() => {}}
					onFocusComposer={() => chatComposer?.focus()}
				/>
			</div>
			{#if showJumpToLatest}
				<button type="button" class="dm-jump-latest" on:click={() => void scrollToLatest()}>↓ New messages</button>
			{/if}
			<div class="dm-conversation-composer">
				{#if e2eeStatus && !e2eeStatus.pendingDefault && !e2eeStatus.needsRekey && (!e2eeStatus.serverReadableSelected || e2eeStatus.serverReadableAllowedByMe)}
				{#key `${$currentUser?.dbUserId || $currentUser?.id || ''}:${channelId}`}
					<ChatComposer
						bind:this={chatComposer}
						isDMChannel={true}
						{channelId}
						draftSurface="dm-right"
						{paymentButtonEnabled}
						encryptSend={Boolean(e2eeStatus?.enabled)}
						{e2eeStatus}
						bind:replyingTo
						bind:composerVisible
						bind:isTextareaFocused
						onExecuteCommand={executeCommand}
						onOpenPaymentSheet={openPaymentSheet}
					/>
				{/key}
				{:else}
					<div class="dm-encryption-gate" role="status">
						{#if e2eeStatus?.enabled && e2eeStatus.needsRekey}
							<strong>Encryption keys need an update.</strong>
							<span>Membership or devices changed. Review the participant devices before trusting the new key. Earlier encrypted messages may be unavailable on newly added devices.</span>
							<button type="button" on:click={() => void updateEncryptionKeys()} disabled={e2eeBusy}>Trust current devices · update keys</button>
						{:else if e2eeStatus?.pendingDefault}
							<strong>Encryption is waiting for participant devices.</strong>
							<span>{e2eeStatus.missingUserIds.length ? `Device setup is still needed for ${missingDeviceLabel}.` : 'Participant devices are ready; encryption is starting.'} Messages cannot be sent until encryption starts or someone chooses server-readable chat.</span>
							<div class="dm-encryption-actions">
								<button type="button" on:click={() => void loadE2eeStatus(channelId)} disabled={e2eeChecking}>Check again</button>
								<button type="button" on:click={() => void useServerReadable()} disabled={e2eeBusy}>Use server-readable messages</button>
							</div>
						{:else if e2eeStatus?.serverReadableSelected && !e2eeStatus.serverReadableAllowedByMe}
							<strong>This conversation is server-readable.</strong>
							<span>Another participant chose this mode. Confirm it on your own account before sending; you can enable encryption later when participant devices are ready.</span>
							<button type="button" on:click={() => void useServerReadable()} disabled={e2eeBusy}>I understand · send server-readable</button>
						{:else}
							<strong>Checking conversation encryption…</strong>
							<span>Sending is paused until this device can confirm the conversation mode.</span>
							<button type="button" on:click={() => void loadE2eeStatus(channelId)} disabled={e2eeChecking}>Retry</button>
						{/if}
					</div>
				{/if}
			</div>
		</div>
		{#if notesMounted}
			<div class="dm-conversation-notes" class:hidden={!showNotes}>
				<SharedConversationNotes {channelId} surface="right" />
			</div>
		{/if}
	</div>
</div>

<PaymentSheet
	isOpen={paymentSheetOpen}
	openSeed={paymentSheetOpenSeed}
	initialAmountInput={paymentPrefill.amountInput}
	initialDescription={paymentPrefill.description}
	initialCustomerRef={paymentPrefill.customerRef}
	defaultChannelId={channelId}
	defaultTargetLabel={isGroup ? displayName : `DM with ${displayName}`}
	defaultTargetKind={isGroup ? 'group' : 'dm'}
	onClose={() => { paymentSheetOpen = false; }}
	onManageConnections={() => {
		paymentSheetOpen = false;
		dispatch('openSettings', { paymentSurface: 'connections' });
	}}
/>

<style>
	.dm-encryption-gate { display: grid; gap: 0.35rem; padding: 0.75rem 1rem; color: var(--text-secondary); font-size: var(--text-sm); }
	.dm-encryption-gate strong { color: var(--text-primary); font-weight: 600; }
	.dm-encryption-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.25rem; }
	.dm-encryption-gate button { width: fit-content; padding: 0.35rem 0.65rem; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--surface-hover); color: var(--text-primary); cursor: pointer; }
	.dm-encryption-gate button:disabled { opacity: 0.55; cursor: default; }
	.dm-tool-encryption-status { color: var(--text-secondary); font-size: var(--text-xs); }
	.dm-message-view {
		position: relative;
		display: flex;
		flex-direction: column;
		container: dm-conversation / inline-size;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: var(--surface-base);
	}
	.dm-message-view::before {
		content: '';
		position: absolute;
		inset: 0;
		background-image: var(--dm-wallpaper-url);
		background-size: var(--dm-wallpaper-size);
		background-position: var(--dm-wallpaper-position);
		background-repeat: var(--dm-wallpaper-repeat);
		filter: blur(var(--dm-wallpaper-blur));
		opacity: 0;
		pointer-events: none;
	}
	.dm-message-view.wallpaper-enabled::before { opacity: var(--dm-wallpaper-opacity); }
	.dm-conversation-tools,
	.dm-conversation-content,
	.dm-tool-error { position: relative; }
	.dm-conversation-tools {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		flex-wrap: wrap;
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--surface-base) 94%, transparent);
	}
	.dm-tool-actions { display: flex; align-items: center; gap: var(--space-2); }
	.dm-tool-actions { flex-wrap: wrap; }
	.dm-tool-wait { flex: 1 1 100%; color: var(--text-secondary); font-size: var(--font-size-xs, 11px); line-height: 1.35; }
	.dm-tool-button {
		min-height: 32px;
		padding: 0 var(--space-2);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--surface-base);
		color: var(--text-secondary);
		font: inherit;
		font-size: var(--text-xs);
		cursor: pointer;
	}
	.dm-tool-button:hover:not(:disabled),
	.dm-tool-button.active { border-color: var(--accent-primary); color: var(--text-heading); background: var(--surface-hover); }
	.dm-tool-button:disabled { opacity: 0.5; cursor: default; }
	.dm-tool-error { padding: var(--space-2) var(--space-3); color: var(--text-danger); font-size: var(--text-xs); }
	.dm-conversation-content {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}
	.dm-conversation-content.with-notes { grid-template-columns: minmax(0, 1fr) minmax(260px, 38%); }
	.dm-conversation-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative; }
	.dm-conversation-messages {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: var(--space-2);
		background: color-mix(in srgb, var(--surface-base) 84%, transparent);
	}
	.dm-load-earlier {
		display: block; min-height: 36px; margin: var(--space-1) auto var(--space-3); padding: 0 var(--space-3);
		border: 1px solid var(--border-subtle); border-radius: var(--radius-full);
		background: var(--surface-raised); color: var(--text-secondary); font: inherit; cursor: pointer;
	}
	.dm-load-earlier:hover:not(:disabled) { color: var(--text-heading); background: var(--surface-hover); }
	.dm-load-earlier:disabled { opacity: .65; cursor: wait; }
	.dm-conversation-composer { flex-shrink: 0; min-width: 0; }
	.dm-conversation-notes { min-width: 0; min-height: 0; border-left: 1px solid var(--border-subtle); }
	.dm-conversation-notes.hidden { display: none; }
	.dm-jump-latest {
		position: absolute;
		bottom: calc(var(--app-chrome-height) + var(--space-3));
		left: 50%;
		transform: translateX(-50%);
		min-height: 36px;
		padding: 0 var(--space-3);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-full);
		background: var(--surface-raised);
		color: var(--text-heading);
		box-shadow: var(--shadow-md);
		cursor: pointer;
	}
	@container dm-conversation (max-width: 600px) {
		.dm-conversation-content.with-notes { display: flex; flex-direction: column; }
		.dm-conversation-content.with-notes .dm-conversation-main { display: none; }
		.dm-conversation-content.with-notes .dm-conversation-notes { flex: 1; height: 100%; border-left: 0; }
	}
	@container dm-conversation (max-width: 420px) {
		.dm-conversation-tools { align-items: stretch; }
		.dm-tool-actions { width: 100%; }
		.dm-tool-button { min-height: 40px; }
		.dm-conversation-messages { padding: var(--space-1); }
		.dm-conversation-composer :global(.input-container) { flex-wrap: wrap; justify-content: flex-end; }
		.dm-conversation-composer :global(.input-container textarea) { flex: 1 0 100%; width: 100%; }
	}
</style>
