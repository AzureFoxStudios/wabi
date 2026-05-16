<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { Message } from '$lib/socket';

	export let editingMessage: Message | null = null;
	export let replyingTo: Message | null = null;
	export let onCancelEdit: () => void;
	export let onCancelReply: () => void;
</script>

{#if editingMessage}
	<div class="edit-bar">
		<div class="edit-info">
			<span class="edit-label">{$_('chat.compose.editing')}</span>
			<span class="edit-hint">{$_('chat.compose.escape_to_cancel')}</span>
		</div>
		<button type="button" class="cancel-edit" on:click={onCancelEdit}>✕</button>
	</div>
{:else if replyingTo}
	<div class="reply-bar">
		<div class="reply-info">
			<span class="reply-label">{$_('chat.compose.replying_to', { values: { user: replyingTo.user } })}</span>
			<span class="reply-preview">
				{#if replyingTo.text}
					{replyingTo.text.substring(0, 50)}{replyingTo.text.length > 50 ? '...' : ''}
				{:else if replyingTo.type === 'gif'}
					GIF
				{:else if replyingTo.type === 'emoji'}
					:{replyingTo.emojiName || 'sticker'}:
				{:else}
					{$_('chat.compose.attachment')}
				{/if}
			</span>
		</div>
		<button type="button" class="cancel-reply" on:click={onCancelReply}>✕</button>
	</div>
{/if}
