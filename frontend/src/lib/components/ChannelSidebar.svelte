<script lang="ts">
	import { channels, currentChannel, joinChannel, createChannel, deleteChannel, markMessagesAsRead, currentUser } from '$lib/socket';
	import Settings from './Settings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';

	export let activeView: 'chat' | 'screen' = 'chat';

	let newChannelName = '';
	let showCreateInput = false;
	let showSettings = false;
	let isMuted = false;
	let isDeafened = false;
	let showDeleteConfirm = false;
	let channelToDelete = '';
	let showPinnedModal = false;
	let selectedChannelForPinned = '';

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
		channelToDelete = channelId;
		showDeleteConfirm = true;
	}

	function confirmDeleteChannel() {
		deleteChannel(channelToDelete);
		showDeleteConfirm = false;
	}

	function handleShowPinnedMessages(channelId: string) {
		selectedChannelForPinned = channelId;
		showPinnedModal = true;
	}
</script>

<div class="channel-sidebar">
	<div class="top-section">
		<div class="logo">
			<img src="/wabi-logo.png" alt="Wabi" class="logo-img" />
		</div>
	</div>

	<div class="sidebar-header">
		<h3>Text Channels</h3>
		<div class="header-buttons">
			<button
				class="screen-share-icon-btn"
				class:active={activeView === 'screen'}
				on:click={() => activeView = 'screen'}
				title="Screen Share"
			>
				📺
			</button>
			<button class="add-btn" on:click={() => showCreateInput = !showCreateInput} title="Create channel">+</button>
		</div>
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
				<div class="channel-actions">
					<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">📌</button>
					{#if channel.id !== 'general'}
						<button class="delete-btn" on:click|stopPropagation={() => handleDeleteChannel(channel.id)}>×</button>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if $currentUser}
		<div class="profile-card">
			<div class="profile-info">
				<div class="avatar-container">
					{#if $currentUser.profilePicture}
						<img src={$currentUser.profilePicture} alt={$currentUser.username} class="avatar" />
					{:else}
						<div class="avatar-placeholder" style="background-color: {$currentUser.color}">
							{$currentUser.username.charAt(0).toUpperCase()}
						</div>
					{/if}
					<div class="status-indicator" class:online={$currentUser.status === 'active'} class:away={$currentUser.status === 'away'} class:busy={$currentUser.status === 'busy'}></div>
				</div>
				<div class="user-details">
					<div class="username">{$currentUser.username}</div>
					<div class="user-tag">#{$currentUser.id.slice(0, 4)}</div>
				</div>
			</div>
			<div class="profile-controls">
				<button
					class="control-btn"
					class:active={isMuted}
					on:click={() => isMuted = !isMuted}
					title={isMuted ? 'Unmute' : 'Mute'}
				>
					{isMuted ? '🔇' : '🎤'}
				</button>
				<button
					class="control-btn"
					class:active={isDeafened}
					on:click={() => isDeafened = !isDeafened}
					title={isDeafened ? 'Undeafen' : 'Deafen'}
				>
					{isDeafened ? '🔇' : '🎧'}
				</button>
				<button
					class="control-btn"
					on:click={() => showSettings = true}
					title="User Settings"
				>
					⚙️
				</button>
			</div>
		</div>
	{/if}
</div>

<Settings bind:isOpen={showSettings} />

<ConfirmDialog
	isOpen={showDeleteConfirm}
	title="Delete Channel"
	message="Delete channel #{channelToDelete}? This action cannot be undone."
	confirmText="Delete"
	variant="danger"
	onConfirm={confirmDeleteChannel}
	onCancel={() => showDeleteConfirm = false}
/>

<PinnedMessagesModal bind:isOpen={showPinnedModal} channelId={selectedChannelForPinned} />

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
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		height: 58px;
	}

	.logo {
		flex: 1;
		display: flex;
		align-items: center;
	}

	.logo-img {
		height: 32px;
		width: auto;
		filter: invert(1) drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
	}

	.settings-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.5rem;
		transition: all 0.2s;
		border-radius: 0;
	}

	.settings-btn:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
		transform: rotate(45deg);
	}

	.sidebar-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
		height: 58px;
	}

	.sidebar-header h3 {
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin: 0;
		flex: 1;
	}

	.header-buttons {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.screen-share-icon-btn,
	.add-btn {
		width: 24px;
		height: 24px;
		border-radius: 0;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1.25rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		opacity: 0.3;
	}

	.screen-share-icon-btn:hover,
	.add-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		opacity: 1;
	}

	.screen-share-icon-btn.active {
		background: var(--accent);
		color: white;
		opacity: 1;
	}

	.create-channel {
		padding: 0.5rem 0.5rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.create-channel input {
		width: 100%;
		padding: 0.5rem;
		font-size: 0.875rem;
		border: 1px solid var(--border);
		border-radius: 0;
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.create-channel button {
		padding: 0.5rem;
		font-size: 0.875rem;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 0;
		cursor: pointer;
		width: 100%;
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
		border-radius: 0;
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

	.channel-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.pin-btn,
	.delete-btn {
		opacity: 0;
		width: 20px;
		height: 20px;
		border-radius: 0;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
	}

	.channel-item:hover .pin-btn,
	.channel-item:hover .delete-btn {
		opacity: 1;
	}

	.pin-btn:hover {
		background: #fbbf24;
		color: white;
	}

	.delete-btn {
		font-size: 1.25rem;
	}

	.delete-btn:hover {
		background: #ef4444;
		color: white;
	}

	.screen-share-section {
		padding: 0.5rem;
		border-bottom: 1px solid var(--border);
	}

	.screen-share-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 0;
		transition: all 0.2s;
		font-size: 0.9rem;
		width: 100%;
		text-align: left;
	}

	.screen-share-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.screen-share-btn.active {
		background: var(--accent);
		color: white;
	}

	.screen-share-btn .icon {
		font-size: 1.1rem;
	}

	.profile-card {
		background: var(--bg-tertiary);
		border-top: 1px solid var(--border);
		padding: 0.625rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: 52px;
	}

	.profile-info {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 80px;
		overflow: hidden;
	}

	.avatar-container {
		position: relative;
		flex-shrink: 0;
	}

	.avatar,
	.avatar-placeholder {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
	}

	.avatar-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-weight: 600;
		font-size: 0.875rem;
	}

	.status-indicator {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--bg-tertiary);
		background: #6b7280;
	}

	.status-indicator.online {
		background: #22c55e;
	}

	.status-indicator.away {
		background: #f59e0b;
	}

	.status-indicator.busy {
		background: #ef4444;
	}

	.user-details {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.username {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-tag {
		font-size: 0.75rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.profile-controls {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex-shrink: 1;
	}

	.control-btn {
		width: 28px;
		height: 28px;
		border-radius: 4px;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		flex-shrink: 0;
	}

	.control-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.control-btn.active {
		background: #ef4444;
		color: white;
	}
</style>
