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
	<div class="panel-tabs-header">
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<button class="tab-btn" class:active={activeTab === 'messages'} on:click={() => setActiveTab('messages')}>
			Messages
		</button>
		<button class="tab-btn" class:active={activeTab === 'users'} on:click={() => setActiveTab('users')}>
			Users
		</button>
		{#if activeTab === 'messages'}
			<button class="add-dm-btn" on:click={handleOpenDMModal} title="Start new DM">+</button>
		{/if}
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
</aside>

<CreateDMModal bind:isOpen={showDMModal} on:dm-created={handleDMCreated} />

<style>
	.dm-list-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-secondary);
		overflow: hidden;
	}

	.panel-tabs-header {
		display: flex;
		align-items: stretch;
		flex-shrink: 0;
		border-bottom: 1px solid var(--border);
		padding: 0;
		gap: 0;
		height: 52px;
		background: var(--bg-secondary);
		box-sizing: border-box;
	}

	.mobile-close-btn {
		display: none;
		background: none;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-primary);
		padding: 0 var(--space-3);
		width: auto;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 0;
		transition: all 150ms ease;
		flex-shrink: 0;
	}

	.mobile-close-btn:hover {
		background: rgba(var(--accent-rgb), var(--opacity-light));
		color: var(--accent);
	}

	.add-dm-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.25rem;
		padding: 0 var(--space-3);
		width: auto;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 0;
		transition: all 150ms ease;
		flex-shrink: 0;
		border-bottom: 2px solid transparent;
	}

	.add-dm-btn:hover {
		background: rgba(var(--accent-rgb), var(--opacity-light));
		color: var(--accent);
	}

	.tab-btn {
		flex: 1;
		padding: 0 var(--space-3);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.875rem;
		font-weight: 500;
		transition: all 150ms ease;
		display: flex;
		align-items: center;
		justify-content: center;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		height: 100%;
	}

	.tab-btn:hover {
		color: var(--text-primary);
		background: rgba(var(--accent-rgb), var(--opacity-subtle));
	}

	.tab-btn.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
		font-weight: 600;
	}

	.hidden {
		display: none;
	}

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
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: var(--space-8) var(--space-4);
		color: var(--text-secondary);
		text-align: center;
		flex: 1;
	}

	.empty-icon {
		font-size: 2.5rem;
		margin-bottom: var(--space-4);
		opacity: 0.5;
	}

	.empty-state p {
		margin: var(--space-1) 0;
		font-size: 0.875rem;
	}

	.empty-hint {
		font-size: 0.8rem;
		opacity: 0.6;
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
		padding: var(--space-3) var(--space-3);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: all 150ms ease;
		gap: var(--space-3);
		text-align: left;
		border-radius: 0;
		margin: 0;
	}

	.conversation-item:hover {
		background: rgba(var(--accent-rgb), var(--opacity-subtle));
	}

	.conversation-avatar {
		flex-shrink: 0;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		overflow: hidden;
		position: relative;
		border: 1px solid rgba(var(--accent-rgb), var(--opacity-light));
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
		font-weight: 600;
		font-size: 0.875rem;
	}

	.conversation-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.conversation-name {
		font-weight: 500;
		color: var(--text-primary);
		font-size: 0.9rem;
		line-height: 1.25;
	}

	.conversation-preview {
		font-size: 0.8rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		line-height: 1.25;
	}

	.user-item {
		display: flex;
		align-items: center;
		padding: var(--space-3) var(--space-3);
		gap: var(--space-3);
		transition: background 150ms ease;
		background: transparent;
		border: none;
		cursor: pointer;
		width: 100%;
		text-align: left;
		border-radius: 0;
	}

	.user-item:hover {
		background: rgba(var(--accent-rgb), var(--opacity-subtle));
	}

	.user-avatar-btn {
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		overflow: hidden;
		border: 1px solid rgba(var(--accent-rgb), var(--opacity-light));
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
		font-weight: 600;
		font-size: 0.875rem;
	}

	.user-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.user-name {
		font-weight: 500;
		color: var(--text-primary);
		font-size: 0.9rem;
		transition: color 150ms ease;
	}

	.you-badge {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-weight: 400;
	}

	.user-status {
		font-size: 0.75rem;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.status-dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		display: inline-block;
		flex-shrink: 0;
	}

	@media (max-width: 768px) {
		.mobile-close-btn {
			display: flex;
		}

		.header-title {
			flex: 1;
		}

		.add-dm-btn {
			margin-left: auto;
		}
	}
</style>
