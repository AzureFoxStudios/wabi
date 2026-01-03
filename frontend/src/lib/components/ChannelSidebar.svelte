<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { channels, currentChannel, joinChannel, createChannel, deleteChannel, markMessagesAsRead, currentUser, updateChannelSettings, channelUnreadCounts, updateProfile } from '$lib/socket';
	import Settings from './Settings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import type { Channel } from '$lib/socket';

	const dispatch = createEventDispatcher();

	// Helper function to format badge display
	function formatBadge(count: number): string {
		if (count === 0) return '';
		if (count <= 10) return `+${count}`;
		return '•';
	}

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
	let showStatusPopup = false;
	let showChannelSettingsModal = false;
	let selectedChannelForSettings: Channel | null = null;

	// Sidebar width management - 3 modes: normal (280px), compact (60px), hidden (0px)
	export let sidebarWidth = 280;
	let isResizing = false;
	let startX = 0;
	let startWidth = 0;

	function startResize(e: MouseEvent) {
		isResizing = true;
		startX = e.clientX;
		startWidth = sidebarWidth;
		document.addEventListener('mousemove', handleResize);
		document.addEventListener('mouseup', stopResize);
	}

	function handleResize(e: MouseEvent) {
		if (!isResizing) return;
		const delta = e.clientX - startX;
		sidebarWidth = Math.max(0, startWidth + delta);
	}

	function stopResize() {
		isResizing = false;
		document.removeEventListener('mousemove', handleResize);
		document.removeEventListener('mouseup', stopResize);

		// Snap to nearest mode
		if (sidebarWidth < 30) {
			sidebarWidth = 0; // Hidden
		} else if (sidebarWidth < 170) {
			sidebarWidth = 60; // Compact
		} else {
			sidebarWidth = 280; // Normal
		}
	}

	function toggleSidebar() {
		sidebarWidth = sidebarWidth === 0 ? 280 : 0;
	}

	// Separate channels by type
	// Note: DMs are excluded from sidebar - only accessible via UserPanel
	$: publicChannels = $channels.filter(ch => !ch.type || ch.type === 'public');
	$: groupChannels = $channels.filter(ch => ch.type === 'group');

	// Clear unread count when switching to chat view
	$: if (activeView === 'chat') {
		markMessagesAsRead();
	}

	function handleChannelClick(channelId: string) {
		joinChannel(channelId);
		dispatch('close'); // Close sidebar on mobile after channel selection
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

	let tempPersistMessages = false;

	function handleOpenChannelSettings(channel: Channel) {
		selectedChannelForSettings = channel;
		tempPersistMessages = channel.persistMessages || false;
		showChannelSettingsModal = true;
	}

	function handleUpdateAutoDelete(autoDeleteAfter: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null) {
		if (selectedChannelForSettings) {
			updateChannelSettings(selectedChannelForSettings.id, {
				autoDeleteAfter,
				persistMessages: tempPersistMessages
			});
			showChannelSettingsModal = false;
		}
	}

	function handleTogglePersistence() {
		tempPersistMessages = !tempPersistMessages;
	}

	function toggleStatusPopup() {
		showStatusPopup = !showStatusPopup;
	}

	function changeStatus(newStatus: 'active' | 'away' | 'busy') {
		updateProfile(newStatus, undefined, undefined);
		showStatusPopup = false;
	}
</script>

{#if sidebarWidth === 0}
	<button class="expand-btn" on:click={toggleSidebar} title="Expand sidebar">›</button>
{/if}

<div class="channel-sidebar" style="width: {sidebarWidth}px">
	<div class="top-section">
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<div class="logo">
			<img src="/wabi-logo.png" alt="Wabi" class="logo-img" />
		</div>
	</div>

	<div class="resize-handle" on:mousedown={startResize}></div>

	<div class="sidebar-header">
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
		<!-- Public Channels -->
		{#each publicChannels as channel (channel.id)}
			<div class="channel-item" class:active={$currentChannel === channel.id}>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleChannelClick(channel.id)}>
					<span class="hash">#</span>
					{channel.name}
					{#if channel.autoDeleteAfter}
						<span class="auto-delete-indicator" title="Auto-delete: {channel.autoDeleteAfter}">⏱️</span>
					{/if}
					{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
						<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
					{/if}
				</button>
				<div class="channel-actions">
					<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">⚙️</button>
					<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">📌</button>
					{#if channel.id !== 'general'}
						<button class="delete-btn" on:click|stopPropagation={() => handleDeleteChannel(channel.id)}>×</button>
					{/if}
				</div>
			</div>
		{/each}

		<!-- DMs removed from sidebar - now accessible via UserPanel -->

		<!-- Group Chats -->
		{#if groupChannels.length > 0}
			<div class="section-header">Group Chats</div>
			{#each groupChannels as channel (channel.id)}
				<div class="channel-item" class:active={$currentChannel === channel.id}>
					<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleChannelClick(channel.id)}>
						<span class="group-icon">👥</span>
						{channel.name}
						{#if channel.autoDeleteAfter}
							<span class="auto-delete-indicator" title="Auto-delete: {channel.autoDeleteAfter}">⏱️</span>
						{/if}
						{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
							<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
						{/if}
					</button>
					<div class="channel-actions">
						<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">⚙️</button>
						<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">📌</button>
						<button class="delete-btn" on:click|stopPropagation={() => handleDeleteChannel(channel.id)}>×</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>

	{#if $currentUser}
		<div class="profile-card">
			<div class="profile-info">
				<button class="avatar-container" on:click={() => showSettings = true}>
					{#if $currentUser.profilePicture}
						<img src={$currentUser.profilePicture} alt={$currentUser.username} class="avatar" />
					{:else}
						<div class="avatar-placeholder" style="background-color: {$currentUser.color}">
							{$currentUser.username.charAt(0).toUpperCase()}
						</div>
					{/if}
					<div class="status-indicator" class:online={$currentUser.status === 'active'} class:away={$currentUser.status === 'away'} class:busy={$currentUser.status === 'busy'}></div>
				</button>
				<div class="user-details">
					<!-- svelte-ignore a11y-click-events-have-key-events -->
					<!-- svelte-ignore a11y-no-static-element-interactions -->
					<div class="username" on:click={toggleStatusPopup}>{$currentUser.username}</div>
					<div class="user-tag">#{$currentUser.id.slice(0, 4)}</div>
				</div>
			</div>

			{#if showStatusPopup}
				<div class="status-popup">
					<button class="status-option active" on:click={() => changeStatus('active')}>
						<span class="status-dot" style="background-color: var(--status-online)"></span>
						Active
					</button>
					<button class="status-option away" on:click={() => changeStatus('away')}>
						<span class="status-dot" style="background-color: var(--status-away)"></span>
						Away
					</button>
					<button class="status-option busy" on:click={() => changeStatus('busy')}>
						<span class="status-dot" style="background-color: var(--status-busy)"></span>
						Busy
					</button>
				</div>
			{/if}
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

<!-- Channel Settings Modal -->
{#if showChannelSettingsModal && selectedChannelForSettings}
	<div class="modal-overlay" on:click={() => showChannelSettingsModal = false}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>⚙️ Channel Settings</h2>
				<button class="close-btn" on:click={() => showChannelSettingsModal = false}>&times;</button>
			</div>
			<div class="modal-body">
				<div class="setting-section">
					<h3>Channel: #{selectedChannelForSettings.name}</h3>

					<div class="setting-group">
						<label>Auto-Delete Messages</label>
						<p class="setting-description">Automatically delete messages after a set period of time</p>

						<div class="auto-delete-options">
							<button
								class="auto-delete-btn"
								class:active={!selectedChannelForSettings.autoDeleteAfter}
								on:click={() => handleUpdateAutoDelete(null)}
							>
								Disabled
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '1h'}
								on:click={() => handleUpdateAutoDelete('1h')}
							>
								1 Hour
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '6h'}
								on:click={() => handleUpdateAutoDelete('6h')}
							>
								6 Hours
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '12h'}
								on:click={() => handleUpdateAutoDelete('12h')}
							>
								12 Hours
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '24h'}
								on:click={() => handleUpdateAutoDelete('24h')}
							>
								1 Day
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '3d'}
								on:click={() => handleUpdateAutoDelete('3d')}
							>
								3 Days
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '7d'}
								on:click={() => handleUpdateAutoDelete('7d')}
							>
								7 Days
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '14d'}
								on:click={() => handleUpdateAutoDelete('14d')}
							>
								14 Days
							</button>
							<button
								class="auto-delete-btn"
								class:active={selectedChannelForSettings.autoDeleteAfter === '30d'}
								on:click={() => handleUpdateAutoDelete('30d')}
							>
								30 Days
							</button>
						</div>
					</div>

					<!-- Only show persistence option for non-DM channels (privacy protection) -->
					{#if selectedChannelForSettings.type !== 'dm'}
						<div class="setting-group">
							<label class="setting-label">
								<input
									type="checkbox"
									bind:checked={tempPersistMessages}
									class="setting-checkbox"
								/>
								Persist Messages Locally
							</label>
							<p class="setting-description">
								Save messages to your browser's local storage so you can see them after the server restarts.
								Each client controls their own message history.
							</p>
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.expand-btn {
		position: fixed;
		left: 0;
		top: 50%;
		transform: translateY(-50%);
		width: 30px;
		height: 30px;
		background: var(--bg-tertiary);
		border: 1px solid var(--border);
		border-right: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		transition: all 0.2s;
		padding: 0;
		opacity: 0;
		pointer-events: none;
	}

	.expand-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		opacity: 1;
	}

	/* Show on hover near the left edge */
	body:has(.expand-btn:hover) .expand-btn,
	.expand-btn:hover {
		opacity: 1;
		pointer-events: auto;
	}

	.channel-sidebar {
		background: var(--bg-tertiary);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		transition: width 0.2s ease;
		position: relative;
		z-index: 50;
	}

	.resize-handle {
		position: absolute;
		right: -4px;
		top: 0;
		width: 8px;
		height: 100%;
		cursor: col-resize;
		z-index: 5;
	}

	/* Compact mode: show only letters */
	.channel-sidebar[style*="width: 60px"] .logo-img {
		display: none;
	}

	.channel-sidebar[style*="width: 60px"] .sidebar-header,
	.channel-sidebar[style*="width: 60px"] .profile-card .user-details,
	.channel-sidebar[style*="width: 60px"] .profile-controls,
	.channel-sidebar[style*="width: 60px"] .status-popup,
	.channel-sidebar[style*="width: 60px"] .create-channel {
		display: none;
	}

	.channel-sidebar[style*="width: 60px"] .channel-btn {
		font-size: 0;
		justify-content: center;
		position: relative;
		width: 100%;
		height: 100%;
	}

	.channel-sidebar[style*="width: 60px"] .channel-btn::after {
		content: attr(data-abbrev);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.channel-sidebar[style*="width: 60px"] .channel-item.active .channel-btn::after {
		color: var(--text-primary);
	}

	.channel-sidebar[style*="width: 60px"] .channel-btn .hash,
	.channel-sidebar[style*="width: 60px"] .channel-btn .group-icon {
		font-size: 1rem;
		margin: 0;
	}

	.channel-sidebar[style*="width: 60px"] .channel-item {
		justify-content: center;
		padding: 0.25rem;
	}

	.channel-sidebar[style*="width: 60px"] .channel-actions {
		display: none;
	}

	.top-section {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		height: 58px;
		gap: 0.5rem;
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

	.collapse-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.5rem;
		padding: 0.5rem;
		transition: all 0.2s;
		min-width: 36px;
		min-height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.collapse-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
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
		border: none;
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

	.hash,
	.group-icon {
		color: var(--text-secondary);
		font-weight: 600;
	}

	.section-header {
		padding: 1rem 1rem 0.5rem 1rem;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin-top: 0.5rem;
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
		background: var(--pinned-border);
		color: white;
	}

	.delete-btn {
		font-size: 1.25rem;
	}

	.delete-btn:hover {
		background: var(--color-danger);
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
		position: relative;
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
		cursor: pointer;
		background: transparent;
		border: none;
		padding: 0;
		border-radius: 50%;
		transition: opacity 0.2s;
	}

	.avatar-container:hover {
		opacity: 0.8;
	}

	.avatar,
	.avatar-placeholder {
		width: 32px;
	}

	.avatar-placeholder {
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
		border: none;
		background: var(--status-offline);
	}

	.status-indicator.online {
		background: var(--status-online);
	}

	.status-indicator.away {
		background: var(--status-away);
	}

	.status-indicator.busy {
		background: var(--status-busy);
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
		cursor: pointer;
		transition: color 0.2s;
	}

	.username:hover {
		color: var(--accent);
	}

	.status-popup {
		position: absolute;
		bottom: 100%;
		left: 0.625rem;
		margin-bottom: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		background: var(--bg-secondary);
		border-radius: 8px;
		padding: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		z-index: 100;
		min-width: 140px;
	}

	.status-option {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		background: transparent;
		border: none;
		border-radius: 6px;
		color: var(--text-primary);
		cursor: pointer;
		transition: background 0.2s;
		text-align: left;
		font-size: 0.9rem;
	}

	.status-option:hover {
		background: var(--bg-hover);
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
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
		background: var(--color-danger);
		color: white;
	}

	/* Auto-delete indicator */
	.auto-delete-indicator {
		font-size: 0.75rem;
		margin-left: 0.25rem;
		opacity: 0.8;
	}

	/* Channel Settings Modal */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal-content {
		background: var(--modal-bg);
		border-radius: 8px;
		max-width: 600px;
		width: 90%;
		max-height: 80vh;
		overflow-y: auto;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid var(--border);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		color: var(--text-primary);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: var(--text-secondary);
		cursor: pointer;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: all 0.2s;
	}

	.close-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.modal-body {
		padding: 1.5rem;
	}

	.setting-section h3 {
		margin: 0 0 1rem 0;
		color: var(--text-primary);
		font-size: 1.1rem;
	}

	.setting-group {
		margin-top: 1.5rem;
	}

	.setting-group label {
		display: block;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 0.5rem;
	}

	.setting-description {
		color: var(--text-secondary);
		font-size: 0.875rem;
		margin-bottom: 1rem;
	}

	.auto-delete-options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 0.5rem;
	}

	.auto-delete-btn {
		padding: 0.75rem 1rem;
		background: var(--bg-secondary);
		border: 2px solid transparent;
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.auto-delete-btn:hover {
		background: var(--bg-tertiary);
		border-color: var(--accent);
	}

	.auto-delete-btn.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.settings-btn {
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-size: 0.875rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: all 0.2s;
		opacity: 0;
	}

	.channel-item:hover .settings-btn {
		opacity: 1;
	}

	.settings-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	/* Unread badge styling */
	.unread-badge {
		background: #ff4444;
		color: white;
		font-size: 0.75rem;
		font-weight: bold;
		padding: 2px 6px;
		border-radius: 10px;
		margin-left: auto;
		min-width: 20px;
		text-align: center;
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.7; }
	}

	/* Mobile close button - hidden by default */
	.mobile-close-btn {
		display: none;
		background: none;
		border: none;
		font-size: 2rem;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0;
		line-height: 1;
		min-width: 44px;
		min-height: 44px;
	}

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.channel-sidebar {
			height: calc(100dvh - 56px);
		}

		.mobile-close-btn {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 36px;
			height: 36px;
			min-width: 36px;
			min-height: 36px;
			font-size: 1.5rem;
		}

		.top-section {
			padding: 0.375rem 0.5rem;
		}

		.sidebar-header {
			padding: 0.375rem 0.5rem;
			height: auto;
			min-height: 40px;
		}

		.sidebar-header h3 {
			font-size: 0.75rem;
		}

		/* Compact buttons */
		.screen-share-icon-btn,
		.add-btn {
			width: 32px;
			height: 32px;
			font-size: 1.2rem;
			opacity: 0.8;
		}

		.channel-item {
			padding: 0.125rem 0.375rem;
		}

		.channel-btn {
			padding: 0.5rem 0.375rem;
			min-height: 36px;
			font-size: 0.875rem;
		}

		/* Compact channel actions */
		.pin-btn,
		.delete-btn,
		.settings-btn {
			opacity: 0.7;
			min-width: 28px;
			min-height: 28px;
			width: 28px;
			height: 28px;
		}

		.create-channel {
			padding: 0.5rem;
		}

		.create-channel input {
			padding: 0.5rem;
			font-size: 16px;
			min-height: 36px;
		}

		.create-channel button {
			padding: 0.5rem;
			min-height: 36px;
			font-size: 0.8rem;
		}

		/* Compact profile card */
		.profile-card {
			padding: 0.5rem;
			height: auto;
			min-height: 50px;
		}

		.profile-info {
			padding: 0.25rem;
		}

		.control-btn {
			width: 32px;
			height: 32px;
			font-size: 1rem;
		}

		/* Modal adjustments */
		.modal-content {
			width: 95%;
			max-height: 90vh;
		}

		.modal-header {
			padding: 0.75rem;
		}

		.modal-body {
			padding: 0.75rem;
		}

		.auto-delete-options {
			grid-template-columns: repeat(2, 1fr);
			gap: 0.375rem;
		}

		.auto-delete-btn {
			padding: 0.5rem;
			font-size: 0.75rem;
		}
	}

	/* Extra small screens */
	@media (max-width: 400px) {
		.sidebar-header {
			padding: 0.25rem 0.375rem;
			min-height: 36px;
		}

		.sidebar-header h3 {
			font-size: 0.7rem;
		}

		.channel-btn {
			padding: 0.375rem;
			min-height: 32px;
			font-size: 0.8rem;
		}

		.auto-delete-options {
			grid-template-columns: 1fr 1fr;
			gap: 0.25rem;
		}

		.auto-delete-btn {
			padding: 0.375rem;
			font-size: 0.7rem;
		}

		.profile-controls {
			gap: 0.125rem;
		}

		.control-btn {
			width: 28px;
			height: 28px;
		}
	}
</style>
