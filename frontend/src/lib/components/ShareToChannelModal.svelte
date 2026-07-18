<script lang="ts">
	import BaseModal from './BaseModal.svelte';
	import { channels, sendMessage } from '$lib/socket';
	import { buildSharePayload, buildShareLink, buildShareRefText, copyToClipboard } from '$lib/shareToChannel';
	import type { ObjectRefRecord } from '$lib/objectRefRegistry';

	export let record: ObjectRefRecord;
	export let onClose: () => void;

	function shareToChannel(channelId: string): void {
		const { text, entities } = buildSharePayload(record);
		sendMessage(channelId, text, 'text', { entities });
		console.info(`[share] Shared ${record.kind} ${record.id} to channel ${channelId}`);
		onClose();
	}

	let copyingLink = false;
	let copyingRef = false;

	async function handleCopyLink(): Promise<void> {
		copyingLink = true;
		await copyToClipboard(buildShareLink(record));
		setTimeout(() => { copyingLink = false; }, 1500);
	}

	async function handleCopyRef(): Promise<void> {
		copyingRef = true;
		await copyToClipboard(buildShareRefText(record));
		setTimeout(() => { copyingRef = false; }, 1500);
	}

	function typeLabel(t: string | undefined): string {
		if (!t) return 'text';
		return t.replace(/^thread_/, 'thread ');
	}
</script>

<BaseModal isOpen={true} {onClose} variant="center" width="480px">
	<div slot="header" class="share-header">
		<h2>Share to channel</h2>
	</div>

	<div class="share-body">
		<div class="channel-list">
			{#each $channels as channel}
				<button
					class="channel-item"
					on:click={() => shareToChannel(channel.id)}
				>
					<span class="channel-name">{channel.name}</span>
					<span class="channel-type">{typeLabel(channel.type)}</span>
				</button>
			{/each}
		</div>

		<div class="share-actions">
			<button
				class="action-btn"
				on:click={handleCopyLink}
				disabled={copyingLink}
			>
				{copyingLink ? 'Copied!' : 'Copy link'}
			</button>
			<button
				class="action-btn"
				on:click={handleCopyRef}
				disabled={copyingRef}
			>
				{copyingRef ? 'Copied!' : 'Copy ref'}
			</button>
		</div>
	</div>
</BaseModal>

<style>
	.share-header {
		padding: 1.25rem;
		border-bottom: 1px solid var(--modal-border, rgba(179, 179, 255, 0.15));
	}

	.share-header h2 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
	}

	.share-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
	}

	.channel-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 50vh;
		overflow-y: auto;
	}

	.channel-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 0.75rem;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.15s;
		background: transparent;
		border: none;
		color: inherit;
		width: 100%;
		text-align: left;
		font-size: 0.875rem;
	}

	.channel-item:hover {
		background: var(--surface-hover, rgba(255, 0, 255, 0.1));
	}

	.channel-name {
		font-weight: 500;
	}

	.channel-type {
		font-size: 0.75rem;
		opacity: 0.6;
		text-transform: lowercase;
	}

	.share-actions {
		display: flex;
		gap: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--modal-border, rgba(179, 179, 255, 0.15));
	}

	.action-btn {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		border: 1px solid var(--modal-border, rgba(179, 179, 255, 0.2));
		background: var(--surface-raised, rgba(48, 43, 99, 0.5));
		color: inherit;
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s;
	}

	.action-btn:hover:not(:disabled) {
		background: var(--surface-hover, rgba(255, 0, 255, 0.2));
	}

	.action-btn:disabled {
		opacity: 0.7;
		cursor: default;
	}
</style>
