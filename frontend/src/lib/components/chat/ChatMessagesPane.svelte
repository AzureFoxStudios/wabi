<script lang="ts">
	import { onDestroy } from 'svelte';
	import { _ } from '$lib/i18n';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { channels, serverMembers, users, type Message, type User } from '$lib/socket';
	import { inkFor } from '$lib/theme/identity';
	import { isPrivateConversationType } from '$lib/privacy/privacyState';
	import MessageList from '../MessageList.svelte';
	import PinnedMessages from '../PinnedMessages.svelte';
	import Icon from '../ui/Icon.svelte';
	import type { ChannelPaneAnimation } from './types';
	import { createTypingAnnouncer, typingSegments } from './typingRow';

	type PaneTransition = (node: Element, params: ChannelPaneAnimation) => unknown;

	export let currentChannel = '';
	export let messageDomScope = '';
	export let searchInput = '';
	export let channelDisplayName = '';
	export let filteredMessages: Message[] = [];
	export let pinnedMessages: Message[] = [];
	export let firstUnreadMessageId: string | null = null;
	export let channelPaneAnimation: ChannelPaneAnimation;
	export let searchBackfillBusy = false;
	export let currentChannelPersistMessages = false;
	export let isFullHistorySearchRunning = false;
	export let fullHistorySearchPagesLoaded = 0;
	export let fullHistorySearchStatus = '';
	export let visibleTypingUsers: string[] = [];
	/** '#' for a channel; DM hosts pass another mark. Only read to tell a conversation from a
	 *  channel: the empty room is named in words, never by a glyph (§2.6). */
	export let emptyStateIcon = '#';
	export let emptyStateSubtitle = 'No messages yet. The first one you send starts the conversation here.';
	export let emptyStateActionLabel = 'Write the first message';
	export let channelPaneInTransition: PaneTransition;
	export let channelPaneOutTransition: PaneTransition;
	export let formatTypingUsers: (users: string[]) => string;
	export let onSearchCurrentQueryInBrowser: () => void;
	export let onToggleFullHistorySearchBackfill: () => void;
	export let onReply: (message: Message) => void;
	export let onQuickMention: (message: Message) => void;
	export let onOpenSettings: () => void;
	export let onFocusComposer: (() => void) | undefined = undefined;

	function focusComposer(): void {
		if (onFocusComposer) {
			onFocusComposer();
			return;
		}
		if (typeof document === 'undefined') return;
		const composer = document.querySelector<HTMLTextAreaElement>('.composer__field textarea');
		composer?.focus();
	}

	// ---- an empty room says what is missing and what happens next (§7.16, §8.3)
	$: roomChannel = $channels.find((channel) => channel.id === currentChannel) ?? null;
	$: roomIsConversation = isPrivateConversationType(roomChannel?.type ?? null) || emptyStateIcon !== '#';
	$: roomName = channelDisplayName || roomChannel?.name || currentChannel;
	$: roomTopic = roomIsConversation ? '' : (roomChannel?.description || '').trim();

	// ---- typing row (§7.17): a 20px stamp, "Iris is writing", three dots; one polite
	// announcement per 10 seconds, read from words the row does not repeat to assistive tech.
	function findPerson(name: string): User | undefined {
		const key = name.toLowerCase();
		return ($serverMembers as User[]).find((user) => user.username?.toLowerCase() === key)
			|| ($users as User[]).find((user) => user.username?.toLowerCase() === key);
	}
	$: typingParts = typingSegments(visibleTypingUsers, (key, options) => $_(key, options));
	$: typingLead = visibleTypingUsers[0] ? findPerson(visibleTypingUsers[0]) : undefined;
	$: typingInitial = (visibleTypingUsers[0] || '').trim().charAt(0).toUpperCase();
	let typingAnnouncement = '';
	const typingAnnouncer = createTypingAnnouncer({ announce: (text) => (typingAnnouncement = text) });
	$: typingAnnouncer.update(visibleTypingUsers.length ? formatTypingUsers(visibleTypingUsers) : '');
	onDestroy(() => typingAnnouncer.dispose());
</script>

{#if $displayEnhancementSettingsStore.betterSearchPageEnabled && searchInput}
	<div class="search-results-toolbar" role="status" aria-live="polite">
		<span class="search-toolbar-meta">
			{filteredMessages.length === 1
				? $_('chat.search.results_one', { values: { count: filteredMessages.length } })
				: $_('chat.search.results_many', { values: { count: filteredMessages.length } })}
		</span>
		{#if searchBackfillBusy}
			<span class="search-toolbar-meta">{$_('chat.search.loading_older')}</span>
		{/if}
		{#if $displayEnhancementSettingsStore.googleSearchReplaceEnabled}
			<button type="button" class="w-btn w-btn--sm w-btn--quiet" on:click={onSearchCurrentQueryInBrowser}>
				<Icon name="externalLink" />
				Search on the web
			</button>
		{/if}
		{#if currentChannelPersistMessages}
			<button
				type="button"
				class="w-btn w-btn--sm w-btn--quiet"
				aria-pressed={isFullHistorySearchRunning}
				on:click={onToggleFullHistorySearchBackfill}
			>
				{isFullHistorySearchRunning
					? $_('chat.search.stop', { values: { count: fullHistorySearchPagesLoaded } })
					: $_('chat.search.full_history')}
			</button>
		{/if}
		{#if fullHistorySearchStatus}
			<span class="search-toolbar-meta">{fullHistorySearchStatus}</span>
		{/if}
	</div>
{/if}

{#key `${currentChannel}-${channelPaneAnimation.enabled ? channelPaneAnimation.preset : 'off'}`}
	<div
		class="messages-pane"
		in:channelPaneInTransition={channelPaneAnimation}
		out:channelPaneOutTransition={channelPaneAnimation}
	>
		{#if !searchInput}
			<PinnedMessages {pinnedMessages} />
		{/if}
		{#if filteredMessages.length === 0 && pinnedMessages.length === 0 && !searchInput}
			<!-- The start-of-channel block MessageList draws above the first message, for a room
			     that has none yet: the room's name, then what happens next. -->
			<div class="stream-start stream-start--empty">
				{#if roomIsConversation}
					<p class="stream-start__kicker">{$_('messages.pagination.beginning')}</p>
					<h2 class="stream-start__title">{roomName}</h2>
				{:else}
					<p class="stream-start__kicker">{$_('messages.start_of', { values: { channel: roomName } })}</p>
					<h2 class="stream-start__title"><span class="stream-start__hash" aria-hidden="true">#</span>{roomName}</h2>
					{#if roomTopic}<p class="stream-start__desc">{roomTopic}</p>{/if}
				{/if}
				<p class="stream-start__desc stream-start__next">{emptyStateSubtitle}</p>
				<div class="stream-start__actions">
					<button class="w-btn w-btn--sm" type="button" on:click={focusComposer}>
						<Icon name="pencil" />
						{emptyStateActionLabel}
					</button>
				</div>
			</div>
		{:else if filteredMessages.length === 0 && searchInput}
			<div class="stream-start stream-start--empty stream-start--search" role="status">
				<p class="stream-start__kicker">{$_('chat.search.results_many', { values: { count: 0 } })}</p>
				<h2 class="stream-start__title stream-start__title--quiet">No messages match “{searchInput}”</h2>
				<p class="stream-start__desc">{$_('stage.search_help')}</p>
			</div>
		{/if}
		<MessageList
			messages={filteredMessages}
			channelId={currentChannel}
			{messageDomScope}
			{onReply}
			{onQuickMention}
			{firstUnreadMessageId}
			on:openSettings={onOpenSettings}
		/>

		<!-- The typing row keeps its 24px whether or not anyone is writing, so the stream never
		     jumps when it appears; the live region exists before it has anything to say. -->
		<div class="stream-typing">
			{#if visibleTypingUsers.length > 0}
				<div class="w-typing stream-typing__row" aria-hidden="true">
					<span class="stream-typing__stamp" style={$inkFor(typingLead?.color)}>{typingInitial}</span>
					<span class="stream-typing__words">{#each typingParts as part}{#if part.name}<b>{part.text}</b>{:else}{part.text}{/if}{/each}</span>
					<span class="w-typing__dots"><i></i><i></i><i></i></span>
				</div>
			{/if}
			<span class="sr-only" aria-live="polite">{typingAnnouncement}</span>
		</div>
	</div>
{/key}
