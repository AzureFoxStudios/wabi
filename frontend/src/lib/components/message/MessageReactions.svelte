<script lang="ts">
	import type { Message, Emoji, User } from '$lib/socket';
	import { _ } from '$lib/i18n';

	export let message: Message;
	export let currentUser: User | undefined;
	export let users: User[];
	export let emojis: Emoji[];
	export let onToggleReaction: (messageId: string, emojiId: string) => void;

	$: ownIdentityIds = (() => {
		const ids = new Set<string>();
		if (currentUser?.id) ids.add(currentUser.id);
		if (currentUser?.dbUserId) ids.add(`user-${currentUser.dbUserId}`);
		return ids;
	})();

	function getEmojiById(emojiId: string): Emoji | undefined {
		return emojis.find((emoji) => emoji.id === emojiId);
	}

	function hasCurrentUserReaction(userIds?: string[]): boolean {
		if (!userIds || userIds.length === 0) return false;
		return Array.from(ownIdentityIds).some((id) => userIds.includes(id));
	}

	function getReactionUsername(userId: string): string {
		if (userId.startsWith('user-')) {
			const dbUserId = Number(userId.substring(5));
			if (!Number.isNaN(dbUserId)) {
				const userRecord = users.find((user) => user.dbUserId === dbUserId);
				if (userRecord?.username) return userRecord.username;
			}
		}
		return currentUser?.username || $_('messages.unknown_user');
	}

	function getReactionTooltip(userIds: string[]): string {
		return userIds.map(getReactionUsername).filter(Boolean).join(', ');
	}
</script>

{#if message.reactions && Object.keys(message.reactions).length > 0}
	<div class="reactions">
		{#each Object.entries(message.reactions) as [emojiId, userIds] (emojiId)}
			{@const emoji = getEmojiById(emojiId)}
			{#if emoji && userIds.length > 0}
				{@const userReacted = hasCurrentUserReaction(userIds)}
				<button
					class="reaction-btn"
					class:user-reacted={userReacted}
					on:click={() => onToggleReaction(message.id, emojiId)}
					title={getReactionTooltip(userIds)}
				>
					<img src={emoji.url} alt={emoji.name} class="reaction-emoji" loading="lazy" decoding="async" />
					<span class="reaction-count">{userIds.length}</span>
				</button>
			{/if}
		{/each}
	</div>
{/if}
