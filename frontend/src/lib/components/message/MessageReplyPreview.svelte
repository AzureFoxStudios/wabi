<script lang="ts">
	import type { Message } from '$lib/socket';
	import { _ } from '$lib/i18n';

	export let replyToMsg: Message;
	export let onJumpToMessage: (messageId: string) => void;

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onJumpToMessage(replyToMsg.id);
		}
	}
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
	class="reply-preview"
	role="button"
	tabindex="0"
	on:click={() => onJumpToMessage(replyToMsg.id)}
	on:keydown={handleKeydown}
>
	<div class="reply-line"></div>
	<div class="reply-content">
		<span class="reply-username">
			{replyToMsg.user || $_('messages.unknown_user')}
		</span>
		<span class="reply-text">
			{#if replyToMsg.text}
				{replyToMsg.text.substring(0, 100)}{replyToMsg.text.length > 100 ? '...' : ''}
			{:else if replyToMsg.type === 'gif'}
				GIF
			{:else if replyToMsg.type === 'emoji'}
				:{replyToMsg.emojiName || 'sticker'}:
			{:else if replyToMsg.fileUrl}
				{replyToMsg.fileName || $_('messages.file')}
			{:else}
				{$_('messages.message')}
			{/if}
		</span>
	</div>
</div>

<style>
	/* In-component forced slim Discord-style reply (beats cached globals, ml-mobile, density rules) */
	:global(.reply-preview) {
		display: flex !important;
		align-items: center !important;
		gap: 6px !important;
		margin-bottom: 2px !important;
		padding: 1px 0 1px 8px !important;
		font-size: 12px !important;
		line-height: 1.15 !important;
		cursor: pointer !important;
		opacity: 0.9 !important;
		background: transparent !important;
		border-radius: 0 !important;
	}
	:global(.reply-preview:hover) { opacity: 1 !important; }
	:global(.reply-line) {
		width: 2px !important; height: 12px !important;
		background: var(--accent-primary-color) !important; border-radius: 999px !important; flex-shrink: 0 !important; align-self: center !important;
	}
	:global(.reply-content) { display: flex !important; align-items: baseline !important; gap: 5px !important; min-width: 0 !important; flex: 1 !important; }
	:global(.reply-username) { font-weight: 600 !important; font-size: 12px !important; white-space: nowrap !important; color: inherit !important; }
	:global(.reply-text) { color: #b9bbbe !important; font-size: 12px !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; max-width: 100% !important; }
</style>
