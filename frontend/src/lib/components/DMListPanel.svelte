<script lang="ts">
	import { channels, channelMessages, currentChannel, users, currentUser, createDM, joinChannel, type User } from '$lib/socket';

	// TEMPORARY: This is a temporary DM panel for the left sidebar
	// TODO: Refactor DM system later, move to dedicated DM section

	let isExpanded = true;
	let showCreateDM = false;
	let searchQuery = '';

	$: dmChannels = $channels.filter(ch => ch.type === 'dm').sort((a, b) => {
		const aLastMsg = ($channelMessages[a.id] || []).length > 0
			? ($channelMessages[a.id] || [])[$channelMessages[a.id].length - 1].timestamp
			: 0;
		const bLastMsg = ($channelMessages[b.id] || []).length > 0
			? ($channelMessages[b.id] || [])[$channelMessages[b.id].length - 1].timestamp
			: 0;
		return bLastMsg - aLastMsg;
	});

	$: onlineUsers = $users.filter(u => u.id !== $currentUser?.id);

	$: filteredUsers = onlineUsers.filter(u =>
		u.username.toLowerCase().includes(searchQuery.toLowerCase())
	);

	function getOtherUser(channel: { otherUser?: User; members?: string[] }): User | null {
		if (channel.otherUser) return channel.otherUser;
		const otherUserId = (channel.members as string[] || []).find((id: string) => id !== $currentUser?.id);
		if (!otherUserId) return null;
		return $users.find(u => u.id === otherUserId) || null;
	}

	function getLastMessagePreview(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return 'No messages';
		const lastMsg = msgs[msgs.length - 1];
		if (lastMsg.type === 'text') {
			return lastMsg.text.length > 30 ? lastMsg.text.slice(0, 30) + '...' : lastMsg.text;
		}
		return `Sent a ${lastMsg.type}`;
	}

	function startDMWithUser(user: User) {
		const memberIds = [$currentUser?.id, user.id].sort();
		const dmId = `dm-${memberIds.join('-')}`;
		const existingDM = $channels.find(ch => ch.id === dmId);

		if (existingDM) {
			joinChannel(dmId);
		} else {
			createDM(user.id);
			const unsubscribe = channels.subscribe(chs => {
				const newDM = chs.find(ch => ch.id === dmId);
				if (newDM) {
					joinChannel(dmId);
					unsubscribe();
				}
			});
		}
		showCreateDM = false;
		searchQuery = '';
	}

	function selectDM(channelId: string) {
		joinChannel(channelId);
	}
</script>

<!-- TEMPORARY DM LIST PANEL - Will be refactored -->
<div class="dm-panel">
	<div class="dm-header">
		<button
			class="dm-toggle"
			on:click={() => (isExpanded = !isExpanded)}
			title={isExpanded ? 'Collapse' : 'Expand'}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points={isExpanded ? '6 9 12 15 18 9' : '9 6 15 12 9 18'} />
			</svg>
			<span>Direct Messages</span>
		</button>
		<button
			class="dm-create"
			on:click={() => (showCreateDM = !showCreateDM)}
			title="New DM"
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<line x1="12" y1="5" x2="12" y2="19" />
				<line x1="5" y1="12" x2="19" y2="12" />
			</svg>
		</button>
	</div>

	{#if isExpanded}
		{#if showCreateDM}
			<div class="dm-create-panel">
				<input
					type="text"
					class="search-input"
					placeholder="Search users..."
					bind:value={searchQuery}
				/>
				{#if filteredUsers.length === 0}
					<div class="empty">No users found</div>
				{:else}
					<div class="user-list">
						{#each filteredUsers as user (user.id)}
							<button
								class="user-item"
								on:click={() => startDMWithUser(user)}
							>
								<div class="user-avatar">
									{#if user.profilePicture}
										<img src={user.profilePicture} alt={user.username} />
									{:else}
										<div class="avatar-placeholder" style="background-color: {user.color}">
											{user.username.charAt(0).toUpperCase()}
										</div>
									{/if}
								</div>
								<span class="username">{user.username}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		{#if dmChannels.length === 0}
			<div class="empty-state">
				<p>No DMs yet</p>
				<button class="start-dm-btn" on:click={() => (showCreateDM = true)}>
					Start a conversation
				</button>
			</div>
		{:else}
			<div class="dm-list">
				{#each dmChannels as channel (channel.id)}
					{@const otherUser = getOtherUser(channel)}
					{#if otherUser}
						<button
							class="dm-item"
							class:active={$currentChannel === channel.id}
							on:click={() => selectDM(channel.id)}
						>
							<div class="dm-avatar">
								{#if otherUser.profilePicture}
									<img src={otherUser.profilePicture} alt={otherUser.username} />
								{:else}
									<div class="avatar-placeholder" style="background-color: {otherUser.color}">
										{otherUser.username.charAt(0).toUpperCase()}
									</div>
								{/if}
							</div>
							<div class="dm-info">
								<span class="dm-name">{otherUser.username}</span>
								<span class="dm-preview">{getLastMessagePreview(channel.id)}</span>
							</div>
						</button>
					{/if}
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.dm-panel {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--border-color);
	}

	.dm-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.5rem;
		background: var(--bg-secondary);
	}

	.dm-toggle,
	.dm-create {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: var(--text-sm);
		font-weight: 500;
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-md);
		transition: all 0.2s;
	}

	.dm-toggle {
		flex: 1;
		justify-content: flex-start;
	}

	.dm-toggle:hover,
	.dm-create:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-create-panel {
		padding: 0.75rem;
		background: var(--bg-secondary);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border-bottom: 1px solid var(--border-color);
	}

	.search-input {
		width: 100%;
		padding: 0.5rem;
		border: 1px solid var(--border-color);
		background: var(--bg-primary);
		color: var(--text-primary);
		border-radius: var(--radius-md);
		font-size: var(--text-sm);
	}

	.search-input::placeholder {
		color: var(--text-secondary);
	}

	.user-list {
		display: flex;
		flex-direction: column;
		max-height: 200px;
		overflow-y: auto;
		gap: 0.25rem;
	}

	.user-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		border-radius: var(--radius-md);
		transition: background 0.2s;
	}

	.user-item:hover {
		background: var(--bg-hover);
	}

	.user-avatar {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border-radius: 50%;
		overflow: hidden;
	}

	.user-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.empty,
	.empty-state {
		padding: 1rem;
		text-align: center;
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}

	.start-dm-btn {
		padding: 0.5rem 1rem;
		background: var(--accent-color);
		color: white;
		border: none;
		border-radius: var(--radius-md);
		cursor: pointer;
		font-size: var(--text-sm);
		font-weight: 500;
		transition: opacity 0.2s;
	}

	.start-dm-btn:hover {
		opacity: 0.9;
	}

	.dm-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.25rem;
	}

	.dm-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		border-radius: var(--radius-md);
		transition: background 0.2s;
		text-align: left;
	}

	.dm-item:hover {
		background: var(--bg-hover);
	}

	.dm-item.active {
		background: var(--accent-color);
		color: white;
	}

	.dm-item.active .dm-preview {
		color: rgba(255, 255, 255, 0.7);
	}

	.dm-avatar {
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: 50%;
		overflow: hidden;
	}

	.dm-avatar img {
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
		font-size: var(--text-sm);
	}

	.dm-info {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		flex: 1;
	}

	.dm-name {
		font-size: var(--text-sm);
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-preview {
		font-size: var(--text-xs);
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.username {
		font-size: var(--text-sm);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
