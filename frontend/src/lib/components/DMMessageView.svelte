<!--
	A DM or group conversation in the DMs companion panel (design contract §7.21, §8.10). DMTab's
	row B names it; this view is the stream, one quiet tools row and the composer.
	- Tools row: the message lifetime select ("Kept 24 hours"), Shared notes, and ⋯ for the map,
	  a payment request and "Encrypt new messages" when encryption can start. Its top 4px stay
	  padding: DMTab's row B touch targets reach over them under coarse pointers.
	- The privacy state is said once: by the composer's colophon, or, while sending is paused, by
	  the row that replaces the composer (lib/dm/dmConversationCopy.ts). No privacy pills here,
	  and a failed request is a notice in plain words, never the raw error and never "E2EE".
-->
<script lang="ts">
	import { afterUpdate, createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
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
	import { normalizeMessageRetentionDuration } from '../../../../shared/messageRetention.js';
	import { dmEncryptionError, dmRetentionChoice, dmRetentionOptions, dmSendGate, type DmActionError, type DmEncryptionAction, type DmSendGateActionId } from '$lib/dm/dmConversationCopy';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import ChatComposer from './chat/ChatComposer.svelte';
	import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
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
	let e2eeError: DmActionError | null = null;
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
	$: selectedRetention = dmRetentionChoice(activeChannel);
	// The select shows the server-confirmed lifetime: a choice that fails to save snaps back.
	let retentionValue = '';
	$: retentionValue = selectedRetention;
	const retentionOptions = dmRetentionOptions();
	$: sendGate = dmSendGate(e2eeStatus, missingDeviceLabel);
	$: canEncrypt = Boolean(e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.pendingDefault && e2eeStatus.missingUserIds.length === 0 && (!e2eeStatus.serverReadableSelected || e2eeStatus.serverReadableAllowedByMe));
	$: waitingForDevices = Boolean(e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.pendingDefault && !e2eeStatus.serverReadableSelected && e2eeStatus.missingUserIds.length > 0);
	let toolItems: MenuEntry[] = [];
	$: toolItems = [
		{ id: 'map', label: 'Open map', icon: 'map', onSelect: () => void openPreferredMapSurface() },
		{ id: 'pay', label: 'Request a payment', icon: 'send', disabled: !paymentButtonEnabled, hint: paymentButtonEnabled ? undefined : 'Registered accounts only', onSelect: () => openPaymentSheet() },
		...(canEncrypt
			? [{ id: 'encrypt', label: e2eeBusy ? 'Turning on…' : 'Encrypt new messages', icon: 'lock', seal: true, disabled: e2eeBusy, hint: 'Experimental', onSelect: () => void enableE2ee() } as MenuEntry]
			: [])
	];

	/** Plain words on screen; the raw cause goes to the log only. */
	function failed(action: DmEncryptionAction, error: unknown): DmActionError {
		if (error) console.warn(`[DM] ${action} failed:`, error);
		return dmEncryptionError(action, error);
	}

	function runGateAction(id: DmSendGateActionId): void {
		if (id === 'rekey') void updateEncryptionKeys();
		else if (id === 'server-readable') void useServerReadable();
		else void loadE2eeStatus(channelId);
	}

	function gateActionBusy(id: DmSendGateActionId): boolean {
		return id === 'check' ? e2eeChecking : e2eeBusy;
	}
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
		e2eeError = null;
		void loadE2eeStatus(requestedChannelId);
	}

	async function loadE2eeStatus(targetChannelId: string): Promise<void> {
		e2eeChecking = true;
		try {
			const status = await prepareNewConversationEncryption(targetChannelId);
			if (mounted && channelId === targetChannelId) { e2eeStatus = status; e2eeError = null; }
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = failed('check', error);
		} finally {
			if (mounted && channelId === targetChannelId) e2eeChecking = false;
		}
	}

	async function useServerReadable(): Promise<void> {
		if (!channelId || e2eeBusy) return;
		const targetChannelId = channelId;
		e2eeBusy = true;
		e2eeError = null;
		try {
			const status = await chooseServerReadable(targetChannelId);
			if (mounted && channelId === targetChannelId) e2eeStatus = status;
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = failed('server-readable', error);
		} finally {
			if (mounted) e2eeBusy = false;
		}
	}

	async function updateEncryptionKeys(): Promise<void> {
		if (!channelId || e2eeBusy) return;
		const targetChannelId = channelId;
		e2eeBusy = true;
		e2eeError = null;
		try {
			const status = await rekeyE2ee(targetChannelId);
			if (mounted && channelId === targetChannelId) {
				if (status) e2eeStatus = status;
				else e2eeError = failed('rekey', null);
			}
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = failed('rekey', error);
		} finally {
			if (mounted) e2eeBusy = false;
		}
	}

	async function setRetention(value: string): Promise<void> {
		if (!activeChannel) return;
		const id = activeChannel.id;
		await updateChannelSettings(id, { autoDeleteAfter: normalizeMessageRetentionDuration(value) });
		// The control reflects the server-confirmed policy, not a speculative selection that
		// might fail to persist while this device is offline.
		await tick();
		if (mounted) retentionValue = dmRetentionChoice(get(channels).find((entry) => entry.id === id) ?? activeChannel);
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
		e2eeError = null;
		try {
			const status = await turnOnE2ee(targetChannelId);
			if (!mounted || targetChannelId !== channelId) return;
			if (status) e2eeStatus = status;
			else e2eeError = failed('enable', null);
		} catch (error) {
			if (mounted && channelId === targetChannelId) e2eeError = failed('enable', error);
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
		<div class="dm-tool-row">
			{#if activeChannel}
				<Tooltip text="Applies to new messages. Earlier messages keep their own lifetime." placement="bottom">
					<Select class="dm-tool-kept" label="Kept" heading="Keep new messages for" options={retentionOptions} bind:value={retentionValue} onchange={(value) => void setRetention(value)} />
				</Tooltip>
			{/if}
			<span class="dm-tool-spacer"></span>
			<button type="button" class="w-btn w-btn--quiet w-btn--sm dm-tool-notes" aria-pressed={showNotes} on:click={toggleSharedNotes}>
				<Icon name="note" size={14} />Shared notes
			</button>
			<Menu items={toolItems} label="Conversation tools" triggerLabel="More tools" class="w-ibtn w-ibtn--sm" align="end" heading={displayName}>
				<Icon name="more" size={16} />
			</Menu>
		</div>
		{#if waitingForDevices}
			<p class="dm-tool-wait" role="status">Encryption starts when {missingDeviceLabel || 'every participant'} {missingDeviceLabel.includes(',') ? 'have' : 'has'} an updated device. Until then new messages stay server-readable.</p>
		{/if}
	</div>

	<div class="dm-conversation-content" class:with-notes={showNotes}>
		<div class="dm-conversation-main">
			<div class="dm-conversation-messages" bind:this={messagesContainer} on:scroll={handleScroll}>
				{#if $channelHasMoreHistory[channelId]}
					<button type="button" class="w-btn w-btn--quiet w-btn--sm dm-load-earlier" aria-busy={$channelHistoryLoading[channelId]} disabled={$channelHistoryLoading[channelId]} on:click={loadEarlier}>
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
				<button type="button" class="dm-jump-latest" aria-label="Jump to the latest messages" on:click={() => void scrollToLatest()}>
					Latest<Icon name="chevDown" size={16} />
				</button>
			{/if}
			<div class="dm-conversation-composer">
				{#if e2eeError && !(sendGate?.kind === 'checking' && e2eeError.action === 'check')}
					<div class="w-notice dm-notice" role="alert">
						<Icon name="alert" size={16} />
						<p class="w-notice__title">{e2eeError.title}</p>
						<p class="w-notice__text">{e2eeError.text}</p>
						<div class="w-notice__actions">
							<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Dismiss" on:click={() => (e2eeError = null)}><Icon name="x" size={16} /></button>
						</div>
					</div>
				{/if}
				{#if !sendGate}
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
					{@const failedCheck = sendGate.kind === 'checking' && e2eeError?.action === 'check' ? e2eeError : null}
					<div class="w-notice dm-gate" class:w-notice--info={!failedCheck} class:dm-gate--failed={failedCheck} role={failedCheck ? 'alert' : 'status'} data-gate={sendGate.kind}>
						<Icon name={failedCheck ? 'alert' : sendGate.glyph} size={16} />
						<p class="w-notice__title">{failedCheck ? failedCheck.title : sendGate.title}</p>
						<p class="w-notice__text">{#if failedCheck}{failedCheck.text}{:else}{sendGate.text}{#if sendGate.detail} <span class="dm-gate-detail">{sendGate.detail}</span>{/if}{/if}</p>
						<div class="w-notice__actions">
							{#each sendGate.actions as action (action.id)}
								<button
									type="button"
									class="w-btn w-btn--sm"
									aria-busy={gateActionBusy(action.id)}
									disabled={gateActionBusy(action.id)}
									on:click={() => runGateAction(action.id)}
								>{gateActionBusy(action.id) ? action.busyLabel : action.label}</button>
							{/each}
						</div>
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
	/* DMs companion conversation (§7.21, §8.10). Roles, type tokens and kit classes only. */
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
		background: var(--w-bg2);
		color: var(--w-text);
	}
	/* The LINE-style DM add-on's wallpaper, when it is on. */
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
	.dm-message-view.wallpaper-enabled::before {
		opacity: var(--dm-wallpaper-opacity);
	}
	.dm-conversation-tools,
	.dm-conversation-content {
		position: relative;
	}

	/* One quiet tools row under DMTab's row B. The top 4px stay padding (DMTab's coarse-pointer
	   row B targets reach over them). */
	.dm-conversation-tools {
		flex: none;
		padding: 4px 12px 4px 16px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.dm-tool-row {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 36px;
		min-width: 0;
	}
	.dm-tool-row :global(.dm-tool-kept) {
		height: 28px;
		min-width: 0;
		font: var(--w-t-caption);
	}
	.dm-tool-spacer {
		flex: 1 1 auto;
	}
	.dm-tool-notes[aria-pressed='true'] {
		background: var(--w-raise);
		color: var(--w-text);
	}
	.dm-tool-wait {
		margin: 2px 0 6px;
		color: var(--w-mute);
		font: var(--w-t-small);
		text-wrap: pretty;
	}

	.dm-conversation-content {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}
	.dm-conversation-content.with-notes {
		grid-template-columns: minmax(0, 1fr) minmax(260px, 38%);
	}
	.dm-conversation-main {
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.dm-conversation-messages {
		flex: 1;
		min-height: 0;
		overflow-x: hidden;
		overflow-y: auto;
	}
	.dm-load-earlier {
		display: flex;
		margin: 8px auto 12px;
	}
	.dm-conversation-composer {
		flex-shrink: 0;
		min-width: 0;
	}
	.dm-conversation-notes {
		min-width: 0;
		min-height: 0;
		border-left: var(--w-bw) solid var(--w-line);
	}
	.dm-conversation-notes.hidden {
		display: none;
	}
	.dm-jump-latest {
		position: absolute;
		right: 16px;
		bottom: calc(var(--w-foot, 80px) + 12px);
		z-index: 1;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		box-sizing: border-box;
		height: 32px;
		padding: 0 10px 0 14px;
		border: var(--w-bw) solid var(--w-line-strong);
		border-radius: var(--w-pill);
		background: var(--w-bg2);
		box-shadow: var(--w-shadow);
		color: var(--w-text);
		font: var(--w-t-label-sm);
		cursor: pointer;
	}
	.dm-jump-latest:hover {
		background: var(--w-raise);
	}
	.dm-jump-latest:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}

	/* The row that replaces the composer while sending is paused; the glyph is the seal. */
	.dm-gate,
	.dm-notice {
		margin: 0 12px 12px;
	}
	.dm-notice {
		margin-top: 8px;
	}
	.dm-gate {
		min-height: 52px;
	}
	.dm-gate > :global(svg:first-child) {
		color: var(--w-seal);
	}
	.dm-gate--failed > :global(svg:first-child) {
		color: var(--w-danger);
	}
	.dm-gate-detail {
		color: var(--w-faint);
	}
	/* The panel is narrow: the actions go under the words. */
	.dm-gate :global(.w-notice__actions) {
		grid-column: 2 / span 2;
		grid-row: auto;
		flex-wrap: wrap;
		justify-self: start;
		margin-top: 8px;
	}

	@container dm-conversation (max-width: 600px) {
		.dm-conversation-content.with-notes { display: flex; flex-direction: column; }
		.dm-conversation-content.with-notes .dm-conversation-main { display: none; }
		.dm-conversation-content.with-notes .dm-conversation-notes { flex: 1; height: 100%; border-left: 0; }
	}
	/* Touch and the phone shell: every target in the panel reaches 44px. */
	@media (pointer: coarse), (max-width: 768px) {
		.dm-tool-row {
			min-height: 44px;
		}
		.dm-gate :global(.w-btn),
		.dm-tool-row :global(:is(.w-btn, .w-select, .w-ibtn)) {
			min-height: 44px;
		}
		.dm-tool-row :global(.w-ibtn) {
			min-width: 44px;
		}
	}
</style>
