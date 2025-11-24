<script lang="ts">
	import { channels, currentChannel, joinChannel, createChannel, deleteChannel, markMessagesAsRead } from '$lib/socket';
	import Settings from './Settings.svelte';

	export let activeView: 'chat' | 'draw' | 'screen' = 'chat';

	let newChannelName = '';
	let showCreateInput = false;
	let showSettings = false;

	// Clear unread count when switching to chat view
	$: if (activeView === 'chat') {
		markMessagesAsRead();
	}

	function handleChannelClick(channelId: string) {
		joinChannel(channelId);
	}

	function handleCreateChannel() {
		if (newChannelName.trim()) {
			createChannel(newChannelName.trim());
			newChannelName = '';
			showCreateInput = false;
		}
	}

	function handleDeleteChannel(channelId: string) {
		if (confirm(`Delete channel #${channelId}?`)) {
			deleteChannel(channelId);
		}
	}
</script>

<div class="channel-sidebar">
	<div class="top-section">
		<div class="logo">
			<img src="/wabi-logo.png" alt="Wabi" class="logo-img" />
		</div>
		<button class="settings-btn" on:click={() => showSettings = true} title="Settings">
			⚙️
		</button>
	</div>

	<div class="sidebar-header">
		<h3>Text Channels</h3>
		<button class="add-btn" on:click={() => showCreateInput = !showCreateInput} title="Create channel">+</button>
	</div>

	{#if showCreateInput}
		<div class="create-channel">
			<input
				type="text"
				bind:value={newChannelName}
				placeholder="channel-name"
				on:keydown={(e) => e.key === 'Enter' && handleCreateChannel()}
				autofocus
			/>
			<button on:click={handleCreateChannel}>Create</button>
		</div>
	{/if}

	<div class="channel-list">
		{#each $channels as channel (channel.id)}
			<div class="channel-item" class:active={$currentChannel === channel.id}>
				<button class="channel-btn" on:click={() => handleChannelClick(channel.id)}>
					<span class="hash">#</span>
					{channel.name}
				</button>
				{#if channel.id !== 'general'}
					<button class="delete-btn" on:click|stopPropagation={() => handleDeleteChannel(channel.id)}>×</button>
				{/if}
			</div>
		{/each}
	</div>

	<div class="bottom-nav">
		<button
			class="nav-btn"
			class:active={activeView === 'draw'}
			on:click={() => activeView = 'draw'}
		>
			<span class="icon">✏️</span>
			<span>Draw</span>
		</button>
		<button
			class="nav-btn"
			class:active={activeView === 'screen'}
			on:click={() => activeView = 'screen'}
		>
			<span class="icon">🖥️</span>
			<span>Screen Share</span>
		</button>
	</div>
</div>

<Settings bind:isOpen={showSettings} />

<style>
	.channel-sidebar {
		width: 100%;
		background: var(--bg-tertiary);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.top-section {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem;
		border-bottom: 1px solid var(--border);
	}

	.logo {
		flex: 1;
		display: flex;
		align-items: center;
	}

	.logo-img {
		height: 40px;
		width: auto;
		filter: invert(1);
	}

	.settings-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.5rem;
		transition: all 0.2s;
		border-radius: 8px;
	}

	.settings-btn:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
		transform: rotate(45deg);
	}

	.sidebar-header {
		padding: 1rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.sidebar-header h3 {
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin: 0;
	}

	.add-btn {
		width: 24px;
		height: 24px;
		border-radius: 4px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1.25rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
	}

	.add-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.create-channel {
		padding: 0.5rem 1rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		gap: 0.5rem;
	}

	.create-channel input {
		flex: 1;
		padding: 0.25rem 0.5rem;
		font-size: 0.875rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.create-channel button {
		padding: 0.25rem 0.75rem;
		font-size: 0.875rem;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.channel-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem 0;
	}

	.channel-item {
		display: flex;
		align-items: center;
		padding: 0 0.5rem;
		position: relative;
	}

	.channel-item.active {
		background: var(--bg-secondary);
	}

	.channel-btn {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		text-align: left;
		font-size: 0.9rem;
		border-radius: 4px;
		transition: all 0.2s;
	}

	.channel-item.active .channel-btn {
		color: var(--text-primary);
	}

	.channel-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.hash {
		color: var(--text-secondary);
		font-weight: 600;
	}

	.delete-btn {
		opacity: 0;
		width: 20px;
		height: 20px;
		border-radius: 4px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1.25rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
	}

	.channel-item:hover .delete-btn {
		opacity: 1;
	}

	.delete-btn:hover {
		background: #ef4444;
		color: white;
	}

	.bottom-nav {
		margin-top: auto;
		padding: 0.5rem;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.nav-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 4px;
		transition: all 0.2s;
		font-size: 0.9rem;
		text-align: left;
	}

	.nav-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.nav-btn.active {
		background: var(--accent);
		color: white;
	}

	.nav-btn .icon {
		font-size: 1.1rem;
	}
</style>
