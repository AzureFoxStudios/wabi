<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { channels, currentChannel, joinChannel, createChannel, deleteChannel, markMessagesAsRead, currentUser, updateChannelSettings, channelUnreadCounts, updateProfile, pinnedChannels, pinChannel, unpinChannel, activeVoiceChannel, voiceChannelMembers, joinVoiceChannel, leaveVoiceChannel } from '$lib/socket';
	import Settings from './Settings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PinnedMessagesModal from './PinnedMessagesModal.svelte';
	import type { Channel } from '$lib/socket';
	import { longpress } from '$lib/actions/longpress';
	import { layoutStore } from '$lib/layoutStore';

	const dispatch = createEventDispatcher();

	// Helper function to format badge display
	function formatBadge(count: number): string {
		if (count === 0) return '';
		if (count <= 10) return `+${count}`;
		return '•';
	}

	export let activeView: 'chat' | 'screen' = 'chat';

	let newChannelName = '';
	let newChannelDescription = '';
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

	// Sidebar width from layout store - 3 modes: normal (280px), compact (60px), hidden (0px)
	$: sidebarWidth = $layoutStore.channelSidebarWidth;
	$: isCompactSidebar = sidebarWidth === 60;

	// Context menu state
	let contextMenuChannel: Channel | null = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;

	function toggleSidebar() {
		const current = $layoutStore.channelSidebarWidth;
		layoutStore.channelSidebarWidth.set(current === 0 ? 280 : 0);
	}

	function handleLogout() {
		dispatch('logout');
	}

	// Separate channels by type
	// Note: DMs are excluded from sidebar - only accessible via UserPanel
	$: publicChannels = $channels
		.filter(ch => !ch.type || ch.type === 'public')
		.sort((a, b) => {
			if (a.id === 'general') return -1;
			if (b.id === 'general') return 1;
			return a.name.localeCompare(b.name);
		});
	$: groupChannels = $channels.filter(ch => ch.type === 'group');
	$: voiceChannels = $channels
		.filter(ch => ch.type !== 'dm')
		.sort((a, b) => {
			if (a.id === 'general') return -1;
			if (b.id === 'general') return 1;
			return a.name.localeCompare(b.name);
		});

	// Clear unread count when switching to chat view
	$: if (activeView === 'chat') {
		markMessagesAsRead();
	}

	function handleChannelClick(channelId: string) {
		joinChannel(channelId);
		dispatch('close'); // Close sidebar on mobile after channel selection
	}


	function getVoiceMembers(channelId: string) {
		return $voiceChannelMembers[channelId] || [];
	}

	function isConnectedToVoice(channelId: string): boolean {
		return $activeVoiceChannel === channelId;
	}

	function handleVoiceAction(channelId: string) {
		if (isConnectedToVoice(channelId)) {
			leaveVoiceChannel(channelId);
			return;
		}
		joinVoiceChannel(channelId);
	}

	function voiceActionLabel(channelId: string): string {
		return isConnectedToVoice(channelId) ? 'Leave Voice' : 'Join Voice';
	}

	function avatarTitle(username?: string): string {
		return username || 'Voice participant';
	}

	function handleCreateChannel() {
		if (newChannelName.trim()) {
			createChannel(newChannelName.trim(), newChannelDescription.trim());
			newChannelName = '';
			newChannelDescription = '';
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
	let tempDescription = '';

	function handleOpenChannelSettings(channel: Channel) {
		selectedChannelForSettings = channel;
		tempPersistMessages = channel.persistMessages || false;
		tempDescription = channel.description || '';
		showChannelSettingsModal = true;
	}

	function handleUpdateAutoDelete(autoDeleteAfter: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null) {
		if (selectedChannelForSettings) {
			updateChannelSettings(selectedChannelForSettings.id, {
				autoDeleteAfter,
				persistMessages: tempPersistMessages,
				description: tempDescription
			});
			showChannelSettingsModal = false;
		}
	}

	function handleSaveChannelSettings() {
		if (selectedChannelForSettings) {
			updateChannelSettings(selectedChannelForSettings.id, {
				autoDeleteAfter: selectedChannelForSettings.autoDeleteAfter || null,
				persistMessages: tempPersistMessages,
				description: tempDescription
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

	function handleChannelLongPress(event: TouchEvent, channel: Channel) {
		const touch = event.touches?.[0] || event.changedTouches?.[0];
		if (!touch) return;
		const syntheticEvent = new MouseEvent('contextmenu', {
			clientX: touch.clientX,
			clientY: touch.clientY,
			bubbles: true
		});
		handleChannelRightClick(syntheticEvent, channel);
	}

	function handleChannelRightClick(event: MouseEvent, channel: Channel) {
		event.preventDefault();
		contextMenuChannel = channel;
		contextMenuPosition = { x: event.clientX, y: event.clientY };
		showContextMenu = true;
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuChannel = null;
	}

	function isChannelPinned(channel: Channel): boolean {
		return $pinnedChannels.some(ch => ch.id === channel.id);
	}

	async function togglePinChannel() {
		if (!contextMenuChannel) return;

		if (isChannelPinned(contextMenuChannel)) {
			unpinChannel(contextMenuChannel.id);
		} else {
			pinChannel(contextMenuChannel.id);
		}
		closeContextMenu();
	}

</script>

{#if sidebarWidth === 0}
	<button class="expand-btn" on:click={toggleSidebar} title="Expand sidebar">›</button>
{/if}

<div class="channel-sidebar" class:compact={isCompactSidebar} style="width: {$layoutStore.channelSidebarWidth}px">
	<div class="top-section">
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<div class="logo">
			<img src="/wabi-logo-small.webp" alt="Wabi" class="logo-img" />
		</div>
		<div class="header-buttons">
			<button
				class="screen-share-icon-btn"
				class:active={activeView === 'screen'}
				on:click={() => activeView = 'screen'}
				title="Screen Share"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
			</button>
			{#if sidebarWidth < 170}
				<button
					class="control-btn compact-settings-btn"
					on:click={() => showSettings = true}
					title="User Settings"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v4m0 10v4m9-9h-4M7 12H3M18.5 5.5l-2.8 2.8m-7.4 0l-2.8-2.8M18.5 18.5l-2.8-2.8m-7.4 0l-2.8 2.8"></path></svg>
				</button>
			{/if}
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
			<input
				type="text"
				bind:value={newChannelDescription}
				placeholder="Description (optional)"
				on:keydown={(e) => e.key === 'Enter' && handleCreateChannel()}
			/>
			<button on:click={handleCreateChannel}>Create</button>
		</div>
	{/if}

	<div class="channel-list">
		<div class="section-header">Text Channels</div>
		<!-- Public text channels -->
		{#each publicChannels as channel (channel.id)}
			<div class="channel-item" class:active={$currentChannel === channel.id} class:has-timer={channel.autoDeleteAfter} on:contextmenu={(e) => handleChannelRightClick(e, channel)} use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleChannelClick(channel.id)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : ''}>
					<span class="hash">#</span>
					{channel.name}
					{#if isChannelPinned(channel)}
						<svg class="pin-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5M9 8h6"></path></svg>
					{/if}
					{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
						<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
					{/if}
				</button>
				<div class="channel-actions text-channel-actions">
					<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m3.08 3.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m3.08-3.08l4.24-4.24M19.78 19.78l-4.24-4.24m-3.08-3.08l-4.24-4.24M19.78 4.22l-4.24 4.24m-3.08 3.08l-4.24-4.24"></path></svg>
<!-- Gear icon: circles with teeth around edges -->
				</button>
					<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5M9 8h6"></path></svg>
				</button>
					{#if channel.id !== 'general'}
						<button class="delete-btn" on:click|stopPropagation={() => handleDeleteChannel(channel.id)}>×</button>
					{/if}
				</div>
			</div>
		{/each}

		<!-- DMs removed from sidebar - now accessible via UserPanel -->

		<!-- Group text channels -->
		{#if groupChannels.length > 0}
			<div class="section-header">Group Chats</div>
			{#each groupChannels as channel (channel.id)}
				<div class="channel-item" class:active={$currentChannel === channel.id} class:has-timer={channel.autoDeleteAfter} on:contextmenu={(e) => handleChannelRightClick(e, channel)} use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, channel) }}>
					<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleChannelClick(channel.id)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : ''}>
						<svg class="group-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
						{channel.name}
						{#if isChannelPinned(channel)}
							<svg class="pin-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5M9 8h6"></path></svg>
						{/if}
						{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
							<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
						{/if}
					</button>
					<div class="channel-actions text-channel-actions">
						<button class="settings-btn" on:click|stopPropagation={() => handleOpenChannelSettings(channel)} title="Channel settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m3.08 3.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m3.08-3.08l4.24-4.24M19.78 19.78l-4.24-4.24m-3.08-3.08l-4.24-4.24M19.78 4.22l-4.24 4.24m-3.08 3.08l-4.24-4.24"></path></svg>
<!-- Gear icon: circles with teeth around edges -->
				</button>
						<button class="pin-btn" on:click|stopPropagation={() => handleShowPinnedMessages(channel.id)} title="View pinned messages">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V5M9 8h6"></path></svg>
				</button>
						<button class="delete-btn" on:click|stopPropagation={() => handleDeleteChannel(channel.id)}>×</button>
					</div>
				</div>
			{/each}
		{/if}

		<div class="section-header">Voice Channels</div>
		{#each voiceChannels as channel (channel.id)}
			<div class="channel-item voice-channel-item" class:active={isConnectedToVoice(channel.id)}>
				<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={() => handleVoiceAction(channel.id)}>
					<span class="hash">🔊</span>
					{channel.name}
				</button>
				<div class="channel-actions">
					<div class="voice-occupancy" title={`${getVoiceMembers(channel.id).length} in voice`}>
						<span class="voice-count">🔊 {getVoiceMembers(channel.id).length}</span>
						<div class="voice-avatars">
							{#each getVoiceMembers(channel.id).slice(0, 3) as member}
								{#if member.profilePicture}
									<img class="voice-avatar" src={member.profilePicture} alt={avatarTitle(member.username)} title={avatarTitle(member.username)} />
								{:else}
									<span class="voice-avatar voice-avatar-fallback" title={avatarTitle(member.username)}>{(member.username || '?').charAt(0).toUpperCase()}</span>
								{/if}
							{/each}
						</div>
					</div>
					<button class="voice-btn" class:active={isConnectedToVoice(channel.id)} on:click|stopPropagation={() => handleVoiceAction(channel.id)}>{voiceActionLabel(channel.id)}</button>
				</div>
			</div>
		{/each}
	</div>

	{#if showContextMenu && contextMenuChannel}
		<div
			class="context-menu"
			style:left="{contextMenuPosition.x}px"
			style:top="{contextMenuPosition.y}px"
			on:click={closeContextMenu}
			on:contextmenu|preventDefault
		>
			<button class="context-menu-item" on:click={togglePinChannel}>
				{#if isChannelPinned(contextMenuChannel)}
					Unpin Channel
				{:else}
					Pin Channel
				{/if}
			</button>
			<button class="context-menu-item" on:click={() => { if (contextMenuChannel) handleShowPinnedMessages(contextMenuChannel.id); closeContextMenu(); }}>
				Pinned Messages
			</button>
			<button class="context-menu-item" on:click={() => { if (contextMenuChannel) handleOpenChannelSettings(contextMenuChannel); closeContextMenu(); }}>
				Channel Settings
			</button>
			{#if contextMenuChannel.id !== 'general'}
				<div class="context-menu-separator"></div>
				<button class="context-menu-item danger" on:click={() => { if (contextMenuChannel) handleDeleteChannel(contextMenuChannel.id); closeContextMenu(); }}>
					Delete Channel
				</button>
			{/if}
		</div>
	{/if}

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
					<div
						class="username"
						role="button"
						tabindex="0"
						on:click={toggleStatusPopup}
						on:keydown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								toggleStatusPopup();
							}
						}}
					>
						{$currentUser.username}
					</div>
					<div class="user-tag">{$currentUser.handle ? `@${$currentUser.handle}` : `#${$currentUser.id.slice(-4)}`}</div>
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
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						{#if isMuted}
							<line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12m14 0a7 7 0 0 1-13.46 3.4"></path><path d="M12 19c3.314 0 6-2.686 6-6v-3m0-6h.01M6 9a6 6 0 0 0 11.13 3.13"></path>
						{:else}
							<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
						{/if}
					</svg>
				</button>
				<button
					class="control-btn"
					class:active={isDeafened}
					on:click={() => isDeafened = !isDeafened}
					title={isDeafened ? 'Undeafen' : 'Deafen'}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						{#if isDeafened}
							<circle cx="12" cy="13" r="5"></circle><path d="M6.5 8.5c-1 1-2 2.5-2 4.5 0 5.523 4.477 10 10 10s10-4.477 10-10c0-2 -1-3.5-2-4.5"></path><path d="M12 5V2"></path>
						{:else}
							<path d="M6 9v6"></path><circle cx="12" cy="13" r="5"></circle><path d="M18 9v6"></path><line x1="12" y1="2" x2="12" y2="5"></line>
						{/if}
					</svg>
				</button>
				{#if sidebarWidth >= 170}
					<button
						class="control-btn"
						on:click={() => showSettings = true}
						title="User Settings"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v4m0 10v4m9-9h-4M7 12H3M18.5 5.5l-2.8 2.8m-7.4 0l-2.8-2.8M18.5 18.5l-2.8-2.8m-7.4 0l-2.8 2.8"></path></svg>
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<Settings bind:isOpen={showSettings} on:logout={handleLogout} />

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
<div
	class="modal-overlay"
	role="button"
	tabindex="0"
	on:click={() => showChannelSettingsModal = false}
	on:keydown={(event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			showChannelSettingsModal = false;
		}
	}}
>
	<div
		class="modal-content"
		role="button"
		tabindex="0"
		on:click|stopPropagation
		on:keydown|stopPropagation={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
			}
		}}
	>
			<div class="modal-header">
				<h2>⚙️ Channel Settings</h2>
				<button class="close-btn" on:click={() => showChannelSettingsModal = false}>&times;</button>
			</div>
			<div class="modal-body">
				<div class="setting-section">
					<h3>Channel: #{selectedChannelForSettings.name}</h3>

					<div class="setting-group">
						<label>Description</label>
						<input
							type="text"
							bind:value={tempDescription}
							placeholder="Add a channel description..."
							class="description-input"
							maxlength="200"
						/>
						<button class="save-description-btn" on:click={handleSaveChannelSettings}>
							Save Settings
						</button>
					</div>

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

<svelte:window on:click={closeContextMenu} />

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
		pointer-events: auto;
	}

	.expand-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		opacity: 1;
	}

	.channel-sidebar {
		background: var(--bg-tertiary);
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
		transition: width 0.2s ease;
		position: relative;
		z-index: 50;
	}

	/* Compact mode: show only letters */
	.channel-sidebar.compact .logo-img {
		height: 24px;
		width: auto;
	}

	.channel-sidebar.compact .sidebar-header,
	.channel-sidebar.compact .profile-card .user-details,
	.channel-sidebar.compact .profile-controls,
	.channel-sidebar.compact .status-popup,
	.channel-sidebar.compact .create-channel {
		display: none;
	}

	.channel-sidebar.compact .channel-btn {
		font-size: 0;
		justify-content: center;
		position: relative;
		width: 100%;
		height: 100%;
	}

	.channel-sidebar.compact .channel-btn::after {
		content: attr(data-abbrev);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.channel-sidebar.compact .channel-item.active .channel-btn::after {
		color: var(--text-primary);
	}

	.channel-sidebar.compact .channel-btn .hash,
	.channel-sidebar.compact .channel-btn .group-icon {
		font-size: 1rem;
		margin: 0;
	}

	.channel-sidebar.compact .channel-item {
		justify-content: center;
		padding: 0.25rem;
	}

	.channel-sidebar.compact .channel-actions {
		display: none;
	}

	.channel-sidebar.compact .voice-occupancy,
	.channel-sidebar.compact .voice-btn {
		display: none;
	}

	.top-section {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		height: 52px;
		gap: 0.5rem;
		box-sizing: border-box;
	}

	.logo {
		flex: 1;
		display: flex;
		align-items: center;
	}

	.logo-img {
		height: 32px;
		width: auto;
		filter: drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3));
		transition: filter 0.3s ease;
	}

	/* Invert logo for dark themes only */
	:root[data-theme="dark"] .logo-img,
	:root[data-theme="midnight-blue"] .logo-img,
	:root[data-theme="vscode-high-contrast"] .logo-img {
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
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.settings-btn svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.settings-btn:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
		box-shadow: inset 0 0 6px rgba(255, 255, 255, 0.1);
	}

	.sidebar-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		justify-content: space-between;
		align-items: center;
		height: 58px;
		position: relative;
	}

	.sidebar-header h3 {
		font-size: var(--text-base);
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
		width: 32px;
		height: 32px;
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
		opacity: 0.7;
		padding: 0;
	}

	.screen-share-icon-btn svg,
	.add-btn {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.screen-share-icon-btn:hover,
	.add-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		opacity: 1;
	}

	.screen-share-icon-btn.active {
		background: var(--accent);
		color: var(--text-primary);
		opacity: 1;
	}

	.compact-settings-btn {
		width: 32px;
		height: 32px;
		border-radius: 4px;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		opacity: 0.7;
		padding: 0;
	}

	.compact-settings-btn svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.compact-settings-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		opacity: 1;
		box-shadow: inset 0 0 6px rgba(255, 255, 255, 0.1);
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
		font-size: var(--text-base);
		border: none;
		border-radius: 0;
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.create-channel button {
		padding: 0.5rem;
		font-size: var(--text-base);
		background: var(--accent);
		color: var(--text-primary);
		border: none;
		border-radius: 0;
		cursor: pointer;
		width: 100%;
	}

	.channel-list {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow-y: auto;
		padding: 0;
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
		font-size: var(--channel-btn-font-size);
		border-radius: 0;
		transition: all 0.2s;
		min-width: 0; /* Allows text to shrink and ellipsis */
		height: fit-content;
		justify-content: flex-start;
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

	.group-icon {
		color: var(--text-secondary);
		font-weight: 600;
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.pin-icon {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		stroke-width: 2;
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
		height: fit-content;
	}

	.voice-occupancy {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.voice-avatars {
		display: flex;
		align-items: center;
		margin-left: 0.1rem;
	}

	.voice-avatar {
		width: 16px;
		height: 16px;
		border-radius: 999px;
		margin-left: -4px;
		border: 1px solid var(--bg-tertiary);
		object-fit: cover;
		background: var(--bg-secondary);
	}

	.voice-avatar-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.6rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.voice-btn {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-size: 0.65rem;
		line-height: 1;
		padding: 0.2rem 0.35rem;
		cursor: pointer;
	}

	.voice-btn.active {
		color: var(--text-primary);
		border-color: var(--accent);
	}

	.pin-btn,
	.delete-btn {
		opacity: 0;
		width: 24px;
		height: 24px;
		border-radius: 4px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		padding: 0;
	}

	.pin-btn svg,
	.settings-btn svg {
		width: 16px;
		height: 16px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.channel-item:hover .pin-btn,
	.channel-item:hover .delete-btn {
		opacity: 1;
	}

	.pin-btn:hover {
		background: var(--pinned-border);
		color: var(--text-primary);
	}

	.delete-btn {
		font-size: 1.25rem;
	}

	.delete-btn:hover {
		background: var(--color-danger);
		color: var(--text-primary);
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
		font-size: var(--channel-btn-font-size);
		width: 100%;
		text-align: left;
	}

	.screen-share-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.screen-share-btn.active {
		background: var(--accent);
		color: var(--text-primary);
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
		color: var(--text-primary);
		font-weight: 600;
		font-size: var(--text-base);
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
		font-size: var(--text-base);
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
		font-size: var(--text-base);
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
		font-size: var(--text-xs);
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
		padding: 0;
	}

	.control-btn svg {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.control-btn:hover {
		background: var(--bg-secondary);
		color: var(--text-primary);
		box-shadow: inset 0 0 6px rgba(255, 255, 255, 0.1);
	}

	.control-btn.active {
		background: var(--color-danger);
		color: var(--text-primary);
	}

	.control-btn.active:hover {
		box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.2);
	}

	/* Auto-delete/Timer indicator - redder highlight */
	.channel-item.has-timer {
		background: rgba(255, 77, 77, var(--opacity-subtle));
		border-left: 3px solid var(--color-danger);
	}

	.channel-item.has-timer:hover {
		background: rgba(255, 77, 77, var(--opacity-light));
	}

	.channel-item.has-timer.active {
		background: rgba(255, 77, 77, var(--opacity-medium));
	}

	/* Compact mode: maintain red indicator */
	.channel-sidebar.compact .channel-item.has-timer {
		border-radius: 0;
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
		font-size: var(--text-xl);
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
		font-size: var(--text-lg);
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
		font-size: var(--text-base);
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
		font-size: var(--text-base);
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
		color: var(--text-primary);
		border-color: var(--accent);
	}

	.description-input {
		width: 100%;
		padding: 0.75rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: var(--text-base);
		box-sizing: border-box;
	}

	.save-description-btn {
		padding: 0.625rem 1.25rem;
		background: var(--accent);
		border: none;
		border-radius: 6px;
		color: white;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		margin-top: 0.5rem;
	}

	.save-description-btn:hover {
		opacity: 0.9;
	}

	.settings-btn {
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-size: var(--text-base);
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
		background: var(--color-danger);
		color: var(--text-primary);
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

	/* Context Menu Styles */
	.context-menu {
		position: fixed;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 4px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
		z-index: 10000;
		min-width: 160px;
	}

	.context-menu-item {
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		color: var(--text-primary);
		font-size: var(--channel-btn-font-size);
		transition: background 0.15s;
	}

	.context-menu-item:hover {
		background: var(--accent);
		color: white;
	}

	.context-menu-item.danger {
		color: #f44336;
	}

	.context-menu-item.danger:hover {
		background: #f44336;
		color: white;
	}

	.context-menu-separator {
		height: 1px;
		background: var(--border);
		margin: 4px 0;
	}

	.pin-icon {
		margin-left: auto;
		opacity: 0.7;
		font-size: 0.9em;
	}

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.channel-sidebar {
			height: calc(100dvh - 56px);
			max-width: 100%;
			overflow: hidden;
		}

		.mobile-close-btn {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			height: 44px;
			min-width: 44px;
			min-height: 44px;
			font-size: 1.5rem;
		}

		.top-section {
			padding: 0.75rem 1rem;
			height: 56px;
		}

		.resize-handle {
			display: none;
		}

		.sidebar-header {
			padding: 0.5rem 0.75rem;
			height: auto;
			min-height: 44px;
		}

		.sidebar-header h3 {
			font-size: 0.8rem;
			letter-spacing: 0.05em;
		}

		/* Touch-friendly header buttons */
		.screen-share-icon-btn,
		.add-btn {
			width: 44px;
			height: 44px;
			font-size: 1.3rem;
		}

		/* Spacious channel items */
		.channel-item {
			padding: 0.25rem 0.75rem;
		}

		.channel-btn {
			padding: 0.75rem 0.75rem;
			min-height: 52px;
			font-size: 1rem;
			border-radius: 8px;
		}

		/* Hide action buttons by default on mobile — show only on active channel */
		.channel-actions {
			display: none;
		}

		.channel-item.active .channel-actions {
			display: flex;
		}

		.pin-btn,
		.delete-btn,
		.settings-btn {
			min-width: 44px;
			min-height: 44px;
			width: 44px;
			height: 44px;
			padding: 10px;
		}

		.create-channel {
			padding: 0.75rem;
		}

		.create-channel input {
			padding: 0.75rem;
			font-size: 16px;
			min-height: 44px;
			border-radius: 8px;
		}

		.create-channel button {
			padding: 0.75rem;
			min-height: 44px;
			font-size: 0.9rem;
			border-radius: 8px;
		}

		/* Spacious profile card */
		.profile-card {
			padding: 0.75rem;
			height: auto;
			min-height: 64px;
		}

		.profile-info {
			padding: 0.25rem;
		}

		.avatar-container {
			width: 40px;
			height: 40px;
		}

		.control-btn {
			width: 44px;
			height: 44px;
			font-size: 1.1rem;
		}

		/* Section headers */
		.section-header {
			padding: 0.75rem 0.75rem 0.375rem;
			font-size: 0.8rem;
		}

		/* Modal adjustments */
		.modal-content {
			width: 95%;
			max-height: 90vh;
			max-height: 90dvh;
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
			padding: 0.75rem;
			font-size: 0.875rem;
			min-height: 44px;
		}

		/* Context menu mobile */
		.context-menu {
			min-width: 200px;
		}

		.context-menu-item {
			padding: 0.75rem 1rem;
			min-height: 44px;
			font-size: 1rem;
		}
	}

	/* Extra small screens */
	@media (max-width: 400px) {
		.channel-item {
			padding: 0.25rem 0.5rem;
		}

		.channel-btn {
			padding: 0.625rem 0.5rem;
			min-height: 48px;
			font-size: 0.9375rem;
		}

		.auto-delete-options {
			grid-template-columns: 1fr 1fr;
			gap: 0.25rem;
		}

		.auto-delete-btn {
			padding: 0.5rem;
			font-size: 0.8rem;
			min-height: 40px;
		}

		.profile-controls {
			gap: 0.25rem;
		}

		.control-btn {
			width: 40px;
			height: 40px;
		}
	}

</style>
