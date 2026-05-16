<script lang="ts">
	import type { Message } from '$lib/socket';
	import { channels, currentChannel, socket } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import { getChannelTypeIcon } from '$lib/channelTypes';

	export let visible: boolean = false;
	export let message: Message | null = null;

	function forwardToChannel(channelId: string) {
		if (!message || !$socket) return;

		$socket.emit('message', {
			channelId,
			text: message.text,
			type: message.type,
			gifUrl: message.gifUrl,
			fileUrl: message.fileUrl,
			fileName: message.fileName,
			fileSize: message.fileSize,
			files: message.files
		});

		visible = false;
	}

	function closeDialog() {
		visible = false;
	}
</script>

{#if visible && message}
	<div
		class="dialog-overlay"
		role="button"
		tabindex="0"
		on:click={closeDialog}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeDialog();
			}
		}}
	>
		<div
			class="dialog"
			role="button"
			tabindex="0"
			on:click|stopPropagation
			on:keydown|stopPropagation={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
				}
			}}
		>
			<div class="dialog-header">
				<h3>{$_('forward_dialog.title')}</h3>
				<button class="close-button" on:click={closeDialog} aria-label={$_('forward_dialog.close')}>x</button>
			</div>

			<div class="dialog-content">
				<p class="dialog-description">{$_('forward_dialog.description')}</p>

				<div class="channel-list">
					{#each $channels as channel}
						{#if channel.id !== $currentChannel}
							<button
								class="channel-item"
								on:click={() => forwardToChannel(channel.id)}
							>
								<span class="channel-icon">
									{getChannelTypeIcon(channel.type)}
								</span>
								<span class="channel-name">{channel.name}</span>
							</button>
						{/if}
					{/each}
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.dialog-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: var(--surface-overlay, var(--surface-modal-overlay, rgba(0, 0, 0, 0.5)));
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal);
	}

	.dialog {
		background: white;
		border-radius: 8px;
		box-shadow: none;
		max-width: 500px;
		width: 90%;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
	}

	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.25rem;
		border-bottom: 1px solid var(--modal-border);
	}

	.dialog-header h3 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--modal-text);
	}

	.close-button {
		background: none;
		border: none;
		font-size: 1.2rem;
		color: var(--modal-text-secondary);
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: background-color 0.2s;
		text-transform: uppercase;
	}

	.close-button:hover {
		background: var(--ui-bg-light);
	}

	.dialog-content {
		padding: 1.25rem;
		overflow-y: auto;
	}

	.dialog-description {
		margin: 0 0 1rem 0;
		color: var(--modal-text-secondary);
		font-size: 0.875rem;
	}

	.channel-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.channel-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		background: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.2s;
		width: 100%;
		text-align: left;
	}

	.channel-item:hover {
		background: var(--modal-header-bg);
		border-color: var(--color-info);
	}

	.channel-icon {
		font-size: 0.95rem;
		width: 24px;
		display: inline-block;
		text-align: center;
		font-weight: 700;
	}

	.channel-name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--modal-text);
	}
</style>
