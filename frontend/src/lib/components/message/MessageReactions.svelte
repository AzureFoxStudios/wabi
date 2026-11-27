<script lang="ts">
	import type { Message, Emoji, User } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import { reactionPresentation } from './reactionPresentation';
	import { reactionEntries } from '$lib/reactionRoles';
	import { reactionRoleMessages } from '$lib/reactionRoles';
	import { listedRoles } from '$lib/serverRoles';

	export let message: Message;
	export let currentUser: User | undefined;
	export let users: User[];
	export let emojis: Emoji[];
	export let onToggleReaction: (messageId: string, emojiId: string) => void;

	// Images that failed to load fall back to text, like unknown emoji.
	let broken: Record<string, true> = {};

	/**
	 * What to draw when there is no usable image (spec §7.9): the emoji character itself when the
	 * id is one (a literal emoji or a codepoint sequence such as 1F44D-1F3FB), otherwise its
	 * :shortcode:. A reaction never disappears because the client lacks its art.
	 */
	function reactionText(emojiId: string, emoji: Emoji | undefined): { glyph: string; code: boolean } {
		if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emojiId)) return { glyph: emojiId, code: false };
		if (/^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*$/i.test(emojiId) && !emoji?.isCustom) {
			try {
				return { glyph: String.fromCodePoint(...emojiId.split('-').map((part) => Number.parseInt(part, 16))), code: false };
			} catch {
				// not a codepoint sequence after all
			}
		}
		const name = emoji?.displayName || emoji?.name || emojiId;
		return { glyph: `:${name.replace(/^openmoji_/, '')}:`, code: true };
	}

	// An emoji staff linked to a role on this message is drawn even with nobody on it yet.
	$: reactions = reactionEntries(message.reactions, $reactionRoleMessages[message.id]?.rules, $listedRoles)
		.map(({ emojiId, userIds, roleName }) => {
			const emoji = emojis.find((candidate) => candidate.id === emojiId);
			const presentation = reactionPresentation(userIds, users, currentUser, $_('messages.unknown_user'));
			const name = emoji?.displayName || emoji?.name || emojiId;
			const roleHint = roleName
				? $_(presentation.userReacted ? 'reaction_roles.chip_leave' : 'reaction_roles.chip_get', { values: { role: roleName } })
				: '';
			return {
				emojiId,
				userIds,
				emoji,
				roleName,
				text: reactionText(emojiId, emoji),
				label: roleName
					? `${roleHint} (${name}, ${userIds.length})`
					: `${name}, ${userIds.length}: ${presentation.tooltip}`,
				...presentation,
				tooltip: roleName ? roleHint : presentation.tooltip
			};
		});
</script>

{#if reactions.length > 0}
	<div class="reactions">
		{#each reactions as reaction (reaction.emojiId)}
			<button
				type="button"
				class="w-react reaction-btn"
				class:user-reacted={reaction.userReacted}
				aria-pressed={reaction.userReacted}
				aria-label={reaction.label}
				title={reaction.tooltip}
				on:click={() => onToggleReaction(message.id, reaction.emojiId)}
			>
				{#if reaction.emoji?.url && !broken[reaction.emojiId]}
					<img
						src={reaction.emoji.url}
						alt={reaction.emoji.displayName || reaction.emoji.name}
						class="reaction-emoji"
						loading="lazy"
						decoding="async"
						on:error={() => (broken = { ...broken, [reaction.emojiId]: true })}
					/>
				{:else if reaction.text.code}
					<span class="w-react__code" aria-hidden="true">{reaction.text.glyph}</span>
				{:else}
					<span class="w-react__emoji" aria-hidden="true">{reaction.text.glyph}</span>
				{/if}
				{#if reaction.roleName}<span class="reaction-role" aria-hidden="true">{reaction.roleName}</span>{/if}
				<span class="reaction-count" aria-hidden="true">{reaction.userIds.length}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	/* The role an emoji gives on this message, beside the emoji. */
	.reaction-role {
		font-size: 12px;
		font-weight: 600;
		max-width: 16ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
