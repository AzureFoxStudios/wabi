<script lang="ts">
	import type { Message, Emoji, User } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import { reactionPresentation } from './reactionPresentation';

	export let message: Message;
	export let currentUser: User | undefined;
	export let users: User[];
	export let emojis: Emoji[];
	export let onToggleReaction: (messageId: string, emojiId: string) => void;

	$: reactions = Object.entries(message.reactions || {}).map(([emojiId, userIds]) => ({
		emojiId,
		userIds,
		emoji: emojis.find((emoji) => emoji.id === emojiId),
		...reactionPresentation(userIds, users, currentUser, $_('messages.unknown_user'))
	}));
</script>

{#if message.reactions && Object.keys(message.reactions).length > 0}
	<div class="reactions">
		{#each reactions as reaction (reaction.emojiId)}
			{#if reaction.emoji && reaction.userIds.length > 0}
				<button
					class="reaction-btn"
					class:user-reacted={reaction.userReacted}
					aria-pressed={reaction.userReacted}
					on:click={() => onToggleReaction(message.id, reaction.emojiId)}
					title={reaction.tooltip}
				>
					<img src={reaction.emoji.url} alt={reaction.emoji.name} class="reaction-emoji" loading="lazy" decoding="async" />
					<span class="reaction-count">{reaction.userIds.length}</span>
				</button>
			{/if}
		{/each}
	</div>
{/if}
