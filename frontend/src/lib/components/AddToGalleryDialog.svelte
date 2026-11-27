<script lang="ts">
	import BaseModal from './BaseModal.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { _ } from '$lib/i18n';
	import type { Channel } from '$lib/socket';

	/** The galleries this person can see; choosing one starts the copy. */
	export let visible = false;
	export let galleries: Channel[] = [];
	export let busy = false;
	/** Shown when the media comes from a conversation whose content otherwise stays on the device. */
	export let privateSource = false;
	export let onChoose: (gallery: Channel) => void;
	export let onClose: () => void;
</script>

<BaseModal isOpen={visible} {onClose} size="sm" title={$_('add_to_gallery.title')} padded>
	<p class="atg-note">{$_('add_to_gallery.description')}</p>
	{#if privateSource}
		<p class="atg-note atg-note--warn" role="note">{$_('add_to_gallery.private_note')}</p>
	{/if}
	{#if galleries.length === 0}
		<p class="atg-empty">{$_('add_to_gallery.none')}</p>
	{:else}
		<ul class="atg-list">
			{#each galleries as gallery (gallery.id)}
				<li>
					<button type="button" class="atg-row" disabled={busy} on:click={() => onChoose(gallery)}>
						<Icon name="image" size={16} />
						<span class="atg-name">{gallery.name}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if busy}
		<p class="atg-note" role="status">{$_('add_to_gallery.sending')}</p>
	{/if}
</BaseModal>

<style>
	.atg-note {
		margin: 0 0 12px;
		color: var(--w-dim, inherit);
		font-size: 13px;
		line-height: 1.45;
	}
	.atg-note--warn {
		color: var(--w-ink, inherit);
		border-left: 2px solid var(--w-sig, currentColor);
		padding-left: 10px;
	}
	.atg-empty {
		margin: 0;
		font-size: 13px;
	}
	.atg-list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 50vh;
		overflow-y: auto;
	}
	.atg-row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 40px;
		padding: 6px 10px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.atg-row:hover:not(:disabled),
	.atg-row:focus-visible {
		background: var(--w-raise, rgba(127, 127, 127, 0.15));
	}
	.atg-row:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.atg-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
