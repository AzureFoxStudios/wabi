<script lang="ts">
	import type { Message } from '$lib/socket';
	import { channels, currentChannel, socket } from '$lib/socket';

	export let visible: boolean = false;
	export let message: Message | null = null;

	function forwardToChannel(channelId: string) {
		if (!message || !$socket) return;

		// Send the message to the selected channel
		$socket.emit('message', {
			channelId,
			text: message.text,
			type: message.type,
			gifUrl: message.gifUrl,
			fileUrl: message.fileUrl,
			fileName: message.fileName,
			fileSize: message.fileSize
		});

		visible = false;
	}

	function closeDialog() {
		visible = false;
	}
</script>

{#if visible && message}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="dialog-overlay" on:click={closeDialog}>
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div class="dialog" on:click|stopPropagation>
			<div class="dialog-header">
				<h3>Forward Message</h3>
				<button class="close-button" on:click={closeDialog}>✕</button>
			</div>

			<div class="dialog-content">
				<p class="dialog-description">Choose a channel to forward this message to:</p>

				<div class="channel-list">
					{#each $channels as channel}
						{#if channel.id !== $currentChannel}
							<button
								class="channel-item"
								on:click={() => forwardToChannel(channel.id)}
							>
								<span class="channel-icon">
									{#if channel.type === 'dm'}
										💬
									{:else}
										#
									{/if}
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
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog {
		background: white;
		border-radius: 8px;
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
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
		border-bottom: 1px solid #e5e7eb;
	}

	.dialog-header h3 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
		color: #111827;
	}

	.close-button {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: #6b7280;
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: background-color 0.2s;
	}

	.close-button:hover {
		background: #f3f4f6;
	}

	.dialog-content {
		padding: 1.25rem;
		overflow-y: auto;
	}

	.dialog-description {
		margin: 0 0 1rem 0;
		color: #6b7280;
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
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.2s;
		width: 100%;
		text-align: left;
	}

	.channel-item:hover {
		background: #f9fafb;
		border-color: #3b82f6;
	}

	.channel-icon {
		font-size: 1.25rem;
		width: 24px;
		display: inline-block;
		text-align: center;
	}

	.channel-name {
		font-size: 0.875rem;
		font-weight: 500;
		color: #374151;
	}
</style>
