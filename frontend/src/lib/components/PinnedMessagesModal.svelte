<!--
	Pinned messages for one channel (design contract §7.13): a BaseModal md opened from the
	channel menu. Each pin shows its author in identity ink, the time in mono, the text, and two
	actions: "Jump to" (closes the dialog and highlights the message) and "Unpin". An empty channel
	gets a real empty state.
-->
<script lang="ts">
	import type { User } from '$lib/socket';
	import { users, channels, channelMessages, togglePinMessage } from '$lib/socket';
	import { inkFor } from '$lib/theme/identity';
	import { _ } from '$lib/i18n';
	import BaseModal from './BaseModal.svelte';
	import Icon from './ui/Icon.svelte';

	export let isOpen = false;
	export let channelId = '';

	$: pinnedMessages = ($channelMessages[channelId] || []).filter((m) => m.isPinned);
	$: channelName = $channels.find((c) => c.id === channelId)?.name || channelId;

	function closeModal() {
		isOpen = false;
	}

	function handleUnpin(messageId: string) {
		togglePinMessage(channelId, messageId);
	}

	function jumpToMessage(messageId: string) {
		closeModal();
		// Wait for the dialog to close (focus returns to the opener) before scrolling.
		setTimeout(() => {
			const messageElement = document.getElementById(`message-${messageId}`)
				|| Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'))
					.find((element) => element.dataset.messageId === messageId);
			if (messageElement) {
				messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
				messageElement.classList.add('highlighted');
				setTimeout(() => {
					messageElement.classList.remove('highlighted');
				}, 2000);
			}
		}, 100);
	}

	function getUserByUsername(username: string): User | undefined {
		return $users.find((u) => u.username === username);
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<BaseModal {isOpen} onClose={closeModal} size="md" padded title={$_('pinned.summary.title')} note="#{channelName}" panelClass="pins">
	{#if pinnedMessages.length === 0}
		<div class="w-empty pins-empty">
			<Icon name="pin" size={28} />
			<p class="w-empty__title">{$_('pinned.modal.empty')}</p>
			<p class="w-empty__text">{$_('pinned.modal.hint')}</p>
		</div>
	{:else}
		<ul class="pins-list" aria-label={$_('pinned.modal.title', { values: { channel: channelName } })}>
			{#each pinnedMessages as message (message.id)}
				<li class="pins-item" style={$inkFor(getUserByUsername(message.user)?.color)}>
					<p class="pins-head">
						<span class="pins-author">{message.user}</span>
						<time class="pins-time" datetime={new Date(message.timestamp).toISOString()}>{formatTime(message.timestamp)}</time>
					</p>
					{#if message.text?.trim()}
						<p class="pins-text">{message.text}</p>
					{:else}
						<p class="pins-text pins-text--empty">An attachment</p>
					{/if}
					<div class="pins-actions">
						<button type="button" class="w-btn w-btn--sm" title={$_('pinned.actions.jump_title')} on:click={() => jumpToMessage(message.id)}>
							<Icon name="arrowUpRight" size={14} />{$_('pinned.actions.jump')}
						</button>
						<button type="button" class="w-btn w-btn--quiet w-btn--sm" aria-label="{$_('pinned.actions.unpin_title')} from {message.user}" on:click={() => handleUnpin(message.id)}>
							<Icon name="pin" size={14} />{$_('pinned.actions.unpin')}
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</BaseModal>

<style>
	.pins-empty {
		padding: 16px 0 8px;
	}
	/* Pins are rows divided by rules, not cards (§2). */
	.pins-list {
		margin: 0;
		padding: 0;
		border-top: var(--w-bw) solid var(--w-line);
		list-style: none;
	}
	.pins-item {
		padding: 14px 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.pins-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin: 0;
	}
	.pins-author {
		min-width: 0;
		overflow: hidden;
		color: var(--ink, var(--w-text));
		font: var(--w-t-label);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pins-time {
		flex: none;
		color: var(--w-faint);
		font: var(--w-t-micro);
	}
	.pins-text {
		display: -webkit-box;
		margin: 4px 0 0;
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-chat);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 4;
		line-clamp: 4;
	}
	.pins-text--empty {
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.pins-actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
</style>
