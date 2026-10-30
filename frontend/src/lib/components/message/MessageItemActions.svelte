<script lang="ts">
	import type { Message, Emoji } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import Icon from '$lib/components/ui/Icon.svelte';

	export let message: Message;
	export let ownMessage: boolean;
	export let quickReactionEmojis: Emoji[];
	export let mobileActionsMessageId: string | null;
	export let displayEnhancementSettingsStore: any;
	export let onReply: (message: Message) => void;
	export let onQuickMention: (message: Message) => void;
	export let onForward: (message: Message) => void = () => {};
	export let onContextMenu: (event: MouseEvent, message: Message) => void;
	export let onOpenReactionPicker: (event: MouseEvent, messageId: string) => void;
	export let onQuickReact: (messageId: string, emojiId: string) => void;
	export let onHandleUtilityPinToggle: (message: Message) => void;
	export let onHandleUtilityEdit: (message: Message) => void;

	/** Hover toolbar order (§7.15): 3 quick reactions | Add reaction, Reply, Forward | More. */
	const QUICK_LIMIT = 3;
	$: quick = quickReactionEmojis.slice(0, QUICK_LIMIT);

	// An emoji whose image cannot load (no bundled art, a deleted server emoji, a CDN hiccup)
	// shows the character it stands for, or its :shortcode:, so the key keeps working.
	let broken: Record<string, true> = {};
	function emojiText(emoji: Emoji): string {
		const sequence = /^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*$/i.test(emoji.id)
			? emoji.id
			: (emoji.url.match(/\/([0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*)\.(?:png|svg|webp|gif)(?:[?#].*)?$/i)?.[1] ?? '');
		if (sequence && !emoji.isCustom) {
			try {
				return String.fromCodePoint(...sequence.split('-').map((part) => Number.parseInt(part, 16)));
			} catch {
				// fall through to the shortcode
			}
		}
		if (/\p{Extended_Pictographic}/u.test(emoji.id)) return emoji.id;
		return `:${emoji.displayName || emoji.name}:`;
	}
	function quickLabel(emoji: Emoji): string {
		return `Quick react: ${emoji.displayName || emoji.name}`;
	}
</script>

<div class="message-actions w-tool" class:mobile-visible={mobileActionsMessageId === message.id}>
	{#if quick.length > 0}
		<div class="quick-reactions-strip">
			{#each quick as quickEmoji (quickEmoji.id)}
				<button
					type="button"
					class="quick-reaction-btn w-tool__quick"
					title={quickLabel(quickEmoji)}
					aria-label={quickLabel(quickEmoji)}
					on:click|stopPropagation={() => onQuickReact(message.id, quickEmoji.id)}
				>
					{#if broken[quickEmoji.id]}
						<span class="quick-reaction-fallback" aria-hidden="true">{emojiText(quickEmoji)}</span>
					{:else}
						<img
							src={quickEmoji.url}
							alt=""
							class="quick-reaction-emoji"
							loading="lazy"
							decoding="async"
							on:error={() => (broken = { ...broken, [quickEmoji.id]: true })}
						/>
					{/if}
				</button>
			{/each}
		</div>
		<span class="w-tool__sep" aria-hidden="true"></span>
	{/if}

	<button type="button" class="action-btn w-ibtn" title={$_('messages.add_reaction')} aria-label={$_('messages.add_reaction')} on:click={(event) => onOpenReactionPicker(event, message.id)}>
		<Icon name="smilePlus" size={16} />
	</button>

	<button type="button" class="action-btn w-ibtn" title={$_('messages.actions.reply')} aria-label={$_('messages.actions.reply')} on:click={() => onReply(message)}>
		<Icon name="reply" size={16} />
	</button>

	<button type="button" class="action-btn w-ibtn" title={$_('context_menu.forward')} aria-label={$_('context_menu.forward')} on:click={() => onForward(message)}>
		<Icon name="forward" size={16} />
	</button>

	{#if displayEnhancementSettingsStore.messageUtilitiesEnabled}
		{#if displayEnhancementSettingsStore.quickMentionEnabled && !ownMessage}
			<button type="button" class="action-btn utility-btn w-ibtn" title={$_('context_menu.quick_mention')} aria-label={$_('context_menu.quick_mention')} on:click={() => onQuickMention(message)}>
				<Icon name="at" size={16} />
			</button>
		{/if}
		<button
			type="button"
			class="action-btn utility-btn w-ibtn"
			title={message.isPinned ? $_('context_menu.unpin_message') : $_('context_menu.pin_message')}
			aria-label={message.isPinned ? $_('context_menu.unpin_message') : $_('context_menu.pin_message')}
			aria-pressed={Boolean(message.isPinned)}
			on:click={() => onHandleUtilityPinToggle(message)}
		>
			<Icon name="pin" size={16} />
		</button>
		{#if ownMessage}
			<button type="button" class="action-btn utility-btn w-ibtn" title={$_('context_menu.edit_message')} aria-label={$_('context_menu.edit_message')} on:click={() => onHandleUtilityEdit(message)}>
				<Icon name="pencil" size={16} />
			</button>
		{/if}
	{/if}

	<span class="w-tool__sep" aria-hidden="true"></span>
	<button type="button" class="action-btn w-ibtn" title={$_('messages.actions.more')} aria-label={$_('messages.actions.more')} aria-haspopup="menu" on:click={(event) => onContextMenu(event, message)}>
		<Icon name="more" size={16} />
	</button>
</div>
