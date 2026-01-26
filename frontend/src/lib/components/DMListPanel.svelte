<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { users, currentUser, channels, channelMessages, createDM, type User } from '$lib/socket';
	import CreateDMModal from './CreateDMModal.svelte';

	const dispatch = createEventDispatcher();

	export let activeTab: 'users' | 'messages' = 'messages';

	let showDMModal = false;

	// Get all active DM conversations
	$: dmChannels = $channels.filter(ch => ch.type === 'dm').sort((a, b) => {
		const aLastMsg = ($channelMessages[a.id] || []).length > 0
			? ($channelMessages[a.id] || [])[$channelMessages[a.id].length - 1].timestamp
			: 0;
		const bLastMsg = ($channelMessages[b.id] || []).length > 0
			? ($channelMessages[b.id] || [])[$channelMessages[b.id].length - 1].timestamp
			: 0;
		return bLastMsg - aLastMsg; // Most recent first
	});

	// Get other user from DM channel
	function getOtherUser(channel: any): User | null {
		if (channel.otherUser) return channel.otherUser;
		const otherUserId = channel.members?.find((id: string) => id !== $currentUser?.id);
		if (!otherUserId) return null;
		return $users.find(u => u.id === otherUserId) || null;
	}

	// Get last message preview
	function getLastMessagePreview(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return 'No messages yet';

		const lastMsg = msgs[msgs.length - 1];
		if (lastMsg.type === 'text') {
			return lastMsg.text.length > 50 ? lastMsg.text.slice(0, 50) + '...' : lastMsg.text;
		} else if (lastMsg.type === 'gif') {
			return '🎬 Sent a GIF';
		} else if (lastMsg.type === 'file') {
			return `📎 ${lastMsg.fileName}`;
		}
		return '';
	}

	function handleOpenDM(channel: any) {
		const otherUser = getOtherUser(channel);
		if (otherUser) {
			dispatch('openDM', { channelId: channel.id, otherUser });
		}
	}

	function handleOpenDMModal() {
		showDMModal = true;
	}

	function handleDMCreated(event: CustomEvent<{ user: User }>) {
		const user = event.detail.user;
		const memberIds = [$currentUser?.id, user.id].sort();
		const dmId = `dm-${memberIds.join('-')}`;

		// Check if DM already exists
		const existingDM = $channels.find(ch => ch.id === dmId);

		if (existingDM) {
			dispatch('openDM', { channelId: dmId, otherUser: user });
		} else {
			createDM(user.id);
			// Subscribe to channels to wait for the new DM
			const unsubscribe = channels.subscribe(chs => {
				const newDM = chs.find(ch => ch.id === dmId);
				if (newDM) {
					dispatch('openDM', { channelId: dmId, otherUser: user });
					unsubscribe();
				}
			});
		}

		showDMModal = false;
	}

	function setActiveTab(tab: 'users' | 'messages') {
		activeTab = tab;
	}
</script>

<aside class="dm-list-panel">
	<div class="panel-header">
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<span class="header-title">Direct Messages</span>
		{#if activeTab === 'messages'}
			<button class="add-dm-btn" on:click={handleOpenDMModal} title="Start new DM">+</button>
		{/if}
	</div>

	<div class="panel-tabs">
		<button class="tab-btn" class:active={activeTab === 'messages'} on:click={() => setActiveTab('messages')}>
			Messages
		</button>
		<button class="tab-btn" class:active={activeTab === 'users'} on:click={() => setActiveTab('users')}>
			Users
		</button>
	</div>

	<div class="panel-content">
		<div class="messages-tab" class:hidden={activeTab !== 'messages'}>
			{#if dmChannels.length === 0}
				<div class="empty-state">
					<div class="empty-icon">💭</div>
					<p>No messages yet</p>
					<p class="empty-hint">Start a conversation to begin</p>
				</div>
			{:else}
				<div class="conversations-list">
					{#each dmChannels as channel (channel.id)}
						{@const otherUser = getOtherUser(channel)}
						{#if otherUser}
							<button
								class="conversation-item"
								on:click={() => handleOpenDM(channel)}
							>
								<div class="conversation-avatar">
									{#if otherUser.profilePicture}
										<img src={otherUser.profilePicture} alt={otherUser.username} />
									{:else}
										<div class="avatar-placeholder" style="background-color: {otherUser.color}">
											{otherUser.username.charAt(0).toUpperCase()}
										</div>
									{/if}
								</div>
								<div class="conversation-info">
									<div class="conversation-name">{otherUser.username}</div>
									<div class="conversation-preview">{getLastMessagePreview(channel.id)}</div>
								</div>
							</button>
						{/if}
					{/each}
				</div>
			{/if}
		</div>

		<div class="users-tab" class:hidden={activeTab !== 'users'}>
			{#if $users.filter(u => u.id !== $currentUser?.id).length === 0}
				<div class="empty-state">
					<div class="empty-icon">👥</div>
					<p>No users online</p>
				</div>
			{:else}
				<div class="users-list">
					{#each $users.filter(u => u.id !== $currentUser?.id) as user (user.id)}
						<button
							class="user-item"
							on:click={() => {
								const memberIds = [$currentUser?.id, user.id].sort();
								const dmId = `dm-${memberIds.join('-')}`;
								const existingDM = $channels.find(ch => ch.id === dmId);
								if (existingDM) {
									dispatch('openDM', { channelId: dmId, otherUser: user });
								} else {
									createDM(user.id);
									const unsubscribe = channels.subscribe(chs => {
										const newDM = chs.find(ch => ch.id === dmId);
										if (newDM) {
											dispatch('openDM', { channelId: dmId, otherUser: user });
											unsubscribe();
										}
									});
								}
							}}
						>
							<div class="user-avatar-btn">
								{#if user.profilePicture}
									<img src={user.profilePicture} alt={user.username} class="user-avatar" />
								{:else}
									<div class="user-avatar-placeholder" style="background-color: {user.color}">
										{user.username.charAt(0).toUpperCase()}
									</div>
								{/if}
							</div>
							<div class="user-info">
								<div class="user-name">{user.username}</div>
								<div class="user-status">
									<span class="status-dot" style="background-color: {user.status === 'active' ? 'var(--status-online)' : user.status === 'away' ? 'var(--status-away)' : 'var(--status-offline)'}"></span>
									<span>{user.status}</span>
								</div>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div class="panel-footer">
		{#if $currentUser}
			<div class="current-user-section">
				<div class="footer-divider"></div>
				<div class="current-user">
					<div class="user-avatar-btn">
						{#if $currentUser.profilePicture}
							<img src={$currentUser.profilePicture} alt={$currentUser.username} class="user-avatar" />
						{:else}
							<div class="user-avatar-placeholder" style="background-color: {$currentUser.color}">
								{$currentUser.username.charAt(0).toUpperCase()}
							</div>
						{/if}
					</div>
					<div class="user-info">
						<div class="user-name">{$currentUser.username} <span class="you-badge">(you)</span></div>
						<div class="user-status">
							<span class="status-dot" style="background-color: {$currentUser.status === 'active' ? 'var(--status-online)' : $currentUser.status === 'away' ? 'var(--status-away)' : 'var(--status-offline)'}"></span>
							<span>{$currentUser.status}</span>
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>
</aside>

<CreateDMModal bind:isOpen={showDMModal} on:dm-created={handleDMCreated} />

<style>
	.dm-list-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--color-background-secondary);
		border-left: 1px solid var(--color-border-primary);
		overflow: hidden; /* Crucial for containing scroll */
	}

	.panel-header {
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--color-border-primary);
		flex-shrink: 0; /* Prevent header from shrinking */
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		height: 52px;
	}

	.header-title {
		color: var(--color-text-primary);
		font-weight: var(--font-weight-semibold);
		font-size: var(--font-size-3);
		flex: 1;
	}

	.mobile-close-btn {
		display: none;
		background: none;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--color-text-primary);
	}

	.add-dm-btn {
		background: none;
		border: none;
		color: var(--color-text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
		padding: 0;
		width: var(--space-8);
		height: var(--space-8);
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		transition: all var(--duration-fast);
	}

	.add-dm-btn:hover {
		background: var(--color-background-tertiary);
		color: var(--color-text-primary);
	}

	.panel-tabs {
		display: flex;
		flex-shrink: 0; /* Prevent tabs from shrinking */
		border-bottom: 1px solid var(--color-border-primary);
		padding: 0 var(--space-2);
	}

	.tab-btn {
		flex: 1;
		padding: var(--space-3) var(--space-2);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-medium);
		transition: all var(--duration-fast);
		margin-bottom: -1px; /* Overlap with border-bottom */
	}

	.tab-btn:hover {
		background: var(--color-background-tertiary);
		color: var(--color-text-primary);
	}

	.tab-btn.active {
		color: var(--color-accent-primary);
		border-bottom-color: var(--color-accent-primary);
		font-weight: var(--font-weight-semibold);
	}

	.hidden {
		display: none;
	}
	
	/* Scrollable content area (middle) */
	.panel-content {
		flex: 1;
		overflow-y: auto;
		position: relative;
	}

	.messages-tab,
	.users-tab {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: var(--space-8) var(--space-4);
		color: var(--color-text-secondary);
		text-align: center;
		flex: 1;
	}

	.empty-icon {
		font-size: 2.5rem;
		margin-bottom: var(--space-4);
		opacity: var(--opacity-50);
	}

	.empty-state p {
		margin: var(--space-1) 0;
	}

	.empty-hint {
		font-size: var(--font-size-2);
		opacity: 0.7;
	}

	.conversations-list,
	.users-list {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.conversation-item {
		display: flex;
		align-items: center;
		padding: var(--space-3) var(--space-2);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: all var(--duration-fast);
		gap: var(--space-3);
		text-align: left;
		margin: 0 var(--space-2);
		border-radius: var(--radius-sm);
	}

	.conversation-item:hover {
		background: rgba(var(--color-accent-primary-rgb), var(--opacity-10));
	}

	.conversation-avatar {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-full);
		overflow: hidden;
		position: relative;
	}

	.conversation-avatar img,
	.avatar-placeholder {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-weight: var(--font-weight-semibold);
		font-size: var(--font-size-1);
	}

	.conversation-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.conversation-name {
		font-weight: var(--font-weight-medium);
		color: var(--color-text-primary);
		font-size: var(--font-size-2);
		line-height: var(--line-height-tight);
	}

	.conversation-preview {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: var(--line-height-tight);
	}

	.user-item {
		display: flex;
		align-items: center;
		padding: var(--space-2) var(--space-4);
		gap: var(--space-3);
		transition: background var(--duration-fast) ease-in-out;
		background: transparent;
		border: none;
		cursor: pointer;
		width: 100%;
		text-align: left;
	}
	.user-item:hover {
		background: var(--color-background-tertiary);
	}

	.user-avatar-btn {
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.user-avatar,
	.user-avatar-placeholder {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-weight: var(--font-weight-semibold);
		font-size: var(--font-size-1);
	}

	.user-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.user-info-btn {
		flex: 1;
		background: transparent;
		border: none;
		padding: 0;
		cursor: pointer;
		text-align: left;
		transition: all var(--duration-fast);
		color: var(--color-text-primary);
	}

	.user-info-btn:hover .user-name {
		color: var(--color-accent-primary);
	}

	.user-name {
		font-weight: var(--font-weight-medium);
		margin-bottom: var(--space-1);
		display: flex;
		align-items: center;
		gap: var(--space-2);
		transition: color var(--duration-fast) ease-in-out;
	}

	.you-badge {
		font-size: var(--font-size-1);
		color: var(--color-text-secondary);
		font-weight: var(--font-weight-regular);
	}

	.user-status {
		font-size: var(--font-size-1);
		color: var(--color-text-secondary);
		display: flex;
		align-items: center;
		gap: 6px; /* 0.375rem */
	}

	.status-dot {
		width: var(--space-2);
		height: var(--space-2);
		border-radius: var(--radius-full);
		display: inline-block;
	}

	/* Fixed footer with current user at bottom */
	.panel-footer {
		flex-shrink: 0;
		background: var(--color-background-secondary);
		border-top: 1px solid var(--color-border-primary);
	}

	.current-user-section {
		display: flex;
		flex-direction: column;
	}

	.footer-divider {
		height: 1px;
		background: var(--color-border-primary);
	}

	.current-user {
		display: flex;
		align-items: center;
		padding: var(--space-3) var(--space-4);
		gap: var(--space-3);
	}

	.current-user .user-avatar-btn {
		flex-shrink: 0;
	}

	.current-user .user-info {
		flex: 1;
		min-width: 0;
	}

	@media (max-width: 768px) {
		.mobile-close-btn {
			display: block;
		}
	}
</style>
