<script lang="ts">
	import type { Message, Emoji } from '$lib/socket';
	import { _ } from '$lib/i18n';

	export let message: Message;
	export let ownMessage: boolean;
	export let quickReactionEmojis: Emoji[];
	export let mobileActionsMessageId: string | null;
	export let displayEnhancementSettingsStore: any;
	export let onReply: (message: Message) => void;
	export let onQuickMention: (message: Message) => void;
	export let onContextMenu: (event: MouseEvent, message: Message) => void;
	export let onOpenReactionPicker: (event: MouseEvent, messageId: string) => void;
	export let onQuickReact: (messageId: string, emojiId: string) => void;
	export let onHandleUtilityPinToggle: (message: Message) => void;
	export let onHandleUtilityEdit: (message: Message) => void;
</script>

<div class="message-actions" class:mobile-visible={mobileActionsMessageId === message.id}>
	{#if quickReactionEmojis.length > 0}
		<div class="quick-reactions-strip">
			{#each quickReactionEmojis as quickEmoji (quickEmoji.id)}
				<button
					class="quick-reaction-btn"
					title={`Quick react: ${quickEmoji.displayName || quickEmoji.name}`}
					on:click|stopPropagation={() => onQuickReact(message.id, quickEmoji.id)}
				>
					<img
						src={quickEmoji.url}
						alt={quickEmoji.displayName || quickEmoji.name}
						class="quick-reaction-emoji"
						loading="lazy"
						decoding="async"
					/>
				</button>
			{/each}
		</div>
	{/if}
	<button class="action-btn" title={$_('messages.add_reaction')} on:click={(event) => onOpenReactionPicker(event, message.id)}>
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
	</button>
	<button class="action-btn" title={$_('messages.actions.reply')} on:click={() => onReply(message)}>
		<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
	</button>
	{#if displayEnhancementSettingsStore.messageUtilitiesEnabled}
		{#if displayEnhancementSettingsStore.quickMentionEnabled && !ownMessage}
			<button class="action-btn utility-btn" title={$_('context_menu.quick_mention')} on:click={() => onQuickMention(message)}>
				@
			</button>
		{/if}
		<button class="action-btn utility-btn" title={message.isPinned ? $_('context_menu.unpin_message') : $_('context_menu.pin_message')} on:click={() => onHandleUtilityPinToggle(message)}>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
		</button>
		{#if ownMessage}
			<button class="action-btn utility-btn" title={$_('context_menu.edit_message')} on:click={() => onHandleUtilityEdit(message)}>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
			</button>
		{/if}
	{/if}
	<button class="action-btn" title={$_('messages.actions.more')} on:click={(event) => onContextMenu(event, message)}>
		<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
	</button>
</div>
