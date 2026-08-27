<script lang="ts">
	import { _ } from '$lib/i18n';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import type { Message } from '$lib/socket';
	import MessageList from '../MessageList.svelte';
	import PinnedMessages from '../PinnedMessages.svelte';
	import type { ChannelPaneAnimation } from './types';

	type PaneTransition = (node: Element, params: ChannelPaneAnimation) => unknown;

	export let currentChannel = '';
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
	export let emptyStateIcon = '#';
	export let emptyStateSubtitle = 'This is the start of your self-hosted space.';
	export let emptyStateActionLabel = 'Send first message';
	export let channelPaneInTransition: PaneTransition;
	export let channelPaneOutTransition: PaneTransition;
	export let formatTypingUsers: (users: string[]) => string;
	export let onSearchCurrentQueryInBrowser: () => void;
	export let onToggleFullHistorySearchBackfill: () => void;
	export let onReply: (message: Message) => void;
	export let onQuickMention: (message: Message) => void;
	export let onOpenSettings: () => void;

	function focusComposer(): void {
		if (typeof document === 'undefined') return;
		const composer = document.querySelector<HTMLTextAreaElement>('.input-container textarea');
		composer?.focus();
	}
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
			<button type="button" class="search-toolbar-btn btn-ghost btn-sm" on:click={onSearchCurrentQueryInBrowser}>
				Search on Web
			</button>
		{/if}
		{#if currentChannelPersistMessages}
			<button
				type="button"
				class="search-toolbar-btn btn-ghost btn-sm"
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
			<div class="empty-state">
				<div class="empty-state-icon">{emptyStateIcon}</div>
				<div class="empty-state-title">{channelDisplayName || currentChannel}</div>
				<div class="empty-state-subtitle">{emptyStateSubtitle}</div>
				<div class="empty-state-actions">
					<button class="empty-state-btn" type="button" on:click={focusComposer}>{emptyStateActionLabel}</button>
				</div>
			</div>
		{:else if filteredMessages.length === 0 && searchInput}
			<div class="empty-state">
				<div class="empty-state-title">No results</div>
				<div class="empty-state-subtitle">No messages match "{searchInput}"</div>
			</div>
		{/if}
		<MessageList
			messages={filteredMessages}
			channelId={currentChannel}
			{onReply}
			{onQuickMention}
			{firstUnreadMessageId}
			on:openSettings={onOpenSettings}
		/>

		{#if visibleTypingUsers.length > 0}
			<div class="typing-indicator">
				<span class="typing-dots"></span>
				<span>{formatTypingUsers(visibleTypingUsers)}</span>
			</div>
		{/if}
	</div>
{/key}
