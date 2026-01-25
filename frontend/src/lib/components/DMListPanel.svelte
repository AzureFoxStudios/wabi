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
		<span class="header-title">{activeTab === 'users' ? 'All Users' : 'Direct Messages'}</span>
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
		<div class="users-list">
			{#each $users as user (user.id)}
				<div class="user-item">
					<button class="user-avatar-btn">
						{#if user.profilePicture}
							<img src={user.profilePicture} alt={user.username} class="user-avatar" />
						{:else}
							<div class="user-avatar-placeholder" style="background-color: {user.color}">
								{user.username.charAt(0).toUpperCase()}
							</div>
						{/if}
					</button>
					<button
						class="user-info-btn"
						on:click={() => {
							if (user.id !== $currentUser?.id) {
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
							}
						}}
					>
						<div class="user-name">
							{user.username}
							{#if user.id === $currentUser?.id}<span class="you-badge">(you)</span>{/if}
						</div>
						<div class="user-status">
							<span class="status-dot" style="background-color: {user.status === 'active' ? 'var(--status-online)' : user.status === 'away' ? 'var(--status-away)' : 'var(--status-offline)'}"></span>
							<span>{user.status}</span>
						</div>
					</button>
				</div>
			{/each}
		</div>
	</div>
</aside>

<CreateDMModal bind:isOpen={showDMModal} on:dm-created={handleDMCreated} />

<style>
	.dm-list-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-secondary);
		border-left: 1px solid var(--border);
		overflow: hidden;
	}

	.panel-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		height: 52px;
	}

	.header-title {
		color: var(--text-primary);
		font-weight: 600;
		font-size: 1rem;
		flex: 1;
	}

	.mobile-close-btn {
		display: none;
		background: none;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-primary);
	}

	.add-dm-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
		padding: 0;
		width: 2rem;
		height: 2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: all 0.2s;
	}

	.add-dm-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.panel-tabs {
		display: flex;
		flex-shrink: 0;
		border-bottom: 1px solid var(--border);
		padding: 0 0.5rem;
	}

	.tab-btn {
		flex: 1;
		padding: 0.75rem 0.5rem;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.875rem;
		font-weight: 500;
		transition: all 0.2s;
		margin-bottom: -1px; /* Overlap with border-bottom */
	}

	.tab-btn:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	.tab-btn.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
		font-weight: 600;
	}

	.hidden {
		display: none;
	}
	
	.messages-tab,
	.users-tab {
		display: flex;
		flex-direction: column;
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		color: var(--text-secondary);
		text-align: center;
		flex: 1;
	}

	.empty-icon {
		font-size: 2.5rem;
		margin-bottom: 1rem;
		opacity: 0.5;
	}

	.empty-state p {
		margin: 0.25rem 0;
	}

	.empty-hint {
		font-size: 0.875rem;
		opacity: 0.7;
	}

	.conversations-list {
		display: flex;
		flex-direction: column;
		gap: 0;
		overflow-y: auto;
	}

	.conversation-item {
		display: flex;
		align-items: center;
		padding: 0.75rem 0.5rem;
		background: transparent;
		border: none;
		border-bottom: none;
		cursor: pointer;
		transition: all 0.15s;
		gap: 0.75rem;
		text-align: left;
		margin: 0 0.5rem;
		border-radius: 4px;
	}

	.conversation-item:hover {
		background: var(--accent-muted);
	}

	.conversation-avatar {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		overflow: hidden;
		position: relative;
	}

	.conversation-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.avatar-placeholder {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-weight: 600;
		font-size: 0.75rem;
	}

	.conversation-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.conversation-name {
		font-weight: 500;
		color: var(--text-primary);
		font-size: 0.9rem;
		line-height: 1.2;
	}

	.conversation-preview {
		font-size: 0.8rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.2;
	}

	.users-list {
		display: flex;
		flex-direction: column;
		gap: 0;
		overflow-y: auto;
	}

	.user-item {
		display: flex;
		align-items: center;
		padding: 0.625rem 1rem;
		gap: 0.75rem;
		transition: background 0.1s ease-in-out;
	}
	.user-item:hover {
		background: var(--bg-tertiary);
	}

	.user-avatar-btn {
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		overflow: hidden;
	}

	.user-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.user-avatar-placeholder {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-weight: 600;
		font-size: 0.75rem;
	}

	.user-info-btn {
		flex: 1;
		background: transparent;
		border: none;
		padding: 0;
		cursor: pointer;
		text-align: left;
		transition: all 0.2s;
		color: var(--text-primary);
	}

	.user-info-btn:hover .user-name {
		color: var(--accent);
	}

	.user-name {
		font-weight: 500;
		margin-bottom: 0.125rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		transition: color 0.1s ease-in-out;
	}

	.you-badge {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-weight: normal;
	}

	.user-status {
		font-size: 0.75rem;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		display: inline-block;
	}

	@media (max-width: 768px) {
		.mobile-close-btn {
			display: block;
		}
	}
</style>
