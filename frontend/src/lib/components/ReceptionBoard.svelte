<script lang="ts">
	import { switchChannel, channels } from '$lib/socket';
	import { serverSettings, toggleServerMutedChannelId, getActiveServerUrl } from '$lib/serverSettings';

	let generalChannel: Channel | undefined;
	$: generalChannel = $channels.find((ch) => ch.type === 'text' && ch.name === 'general');

	function isHidden(channelId: string): boolean {
		const server = $serverSettings[getActiveServerUrl() || ''];
		return Array.isArray(server?.mutedChannelIds) && server.mutedChannelIds.includes(channelId);
	}

	function toggleRoom(channelId: string): void {
		toggleServerMutedChannelId(channelId);
	}

	function openGeneral() {
		if (generalChannel?.id) {
			switchChannel(generalChannel.id);
		}
	}
</script>

<div class="reception-board">
	<div class="reception-header">
		<h1>Welcome to the server</h1>
		<p class="reception-subtitle">Pick what you want to see and who you are here as.</p>
	</div>

	<div class="reception-body">
		<section class="reception-section">
			<h2>What are you here for?</h2>
			<div class="chip-row">
				<button type="button" class="chip">Artist</button>
				<button type="button" class="chip">Writer</button>
				<button type="button" class="chip">Voice</button>
				<button type="button" class="chip">Dev</button>
				<button type="button" class="chip">Lurker</button>
			</div>
		</section>

		<section class="reception-section">
			<h2>Rooms up</h2>
			<p class="reception-hint">Turn on the rooms you want in your list.</p>
			<div class="room-list">
				{#each $channels as ch (ch.id)}
					{#if ch.type !== 'dm' && ch.type !== 'group'}
						<button
							type="button"
							class="room-row"
							class:room-row-off={isHidden(ch.id)}
							on:click={() => toggleRoom(ch.id)}
						>
							<span class="room-name">#{ch.name}</span>
							<span class="room-status">{isHidden(ch.id) ? 'Off' : 'On'}</span>
						</button>
					{/if}
				{/each}
			</div>
		</section>
	</div>

	<div class="reception-footer">
		<button type="button" class="primary" onclick={openGeneral}>Show me the server</button>
	</div>
</div>

<style>
	.reception-board {
		display: grid;
		grid-template-rows: auto 1fr auto;
		min-height: 100%;
		padding: 24px;
		gap: 24px;
	}
	.reception-header h1 {
		margin: 0;
		font-size: 28px;
	}
	.reception-subtitle {
		margin: 8px 0 0;
		color: #b9bbbe;
	}
	.reception-body {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
	}
	.reception-section h2 {
		margin: 0 0 12px;
		font-size: 16px;
	}
	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.chip {
		appearance: none;
		border: 1px solid #4f545c;
		background: #2f3136;
		color: #dcddde;
		padding: 8px 12px;
		border-radius: 9999px;
		cursor: pointer;
	}
	.room-list {
		display: grid;
		gap: 8px;
	}
	.room-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 12px;
		border-radius: 8px;
		background: #2f3136;
		color: #dcddde;
		width: 100%;
		text-align: left;
		cursor: pointer;
	}
	.room-row-off {
		opacity: 0.7;
	}
	.room-status {
		font-size: 12px;
		opacity: 0.8;
	}
	.reception-footer {
		display: flex;
		justify-content: flex-end;
	}
	.primary {
		appearance: none;
		border: none;
		background: #5865f2;
		color: white;
		padding: 12px 18px;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 600;
	}
</style>
