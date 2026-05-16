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
