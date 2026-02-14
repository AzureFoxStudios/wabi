<script lang="ts">
	import { channels, channelMessages, currentChannel, users, currentUser, createDM, getDMChannelIdForUser, joinChannel, type User } from '$lib/socket';
	import { longpress } from '$lib/actions/longpress';
	import GroupAvatar from './GroupAvatar.svelte';

	// TEMPORARY: This is a temporary DM panel for the left sidebar
	// TODO: Refactor DM system later, move to dedicated DM section

	let isExpanded = true;
	let showCreateDM = false;
	let searchQuery = '';

	// TEMPORARY: Context menu for DMs
	let contextMenuDM: any = null;
	let contextMenuPosition = { x: 0, y: 0 };
	let showContextMenu = false;

	$: dmChannels = $channels.filter(ch => ch.type === 'dm' || ch.type === 'group').sort((a, b) => {
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
		// Fallback: try to resolve from members using stable IDs
		const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
		const otherStableId = (channel.members as string[] || []).find((id: string) => id !== myStableId);
		if (!otherStableId) return null;
		// Match by socket.id or by stable dbUserId
		if (otherStableId.startsWith('user-')) {
			const dbId = parseInt(otherStableId.substring(5), 10);
			return $users.find(u => u.dbUserId === dbId) || null;
		}
		return $users.find(u => u.id === otherStableId) || null;
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
		const dmId = getDMChannelIdForUser($currentUser, user);
		const existingDM = $channels.find(ch => ch.id === dmId);

		if (existingDM) {
			joinChannel(dmId);
		} else {
			createDM(user.id);
			// Listen for the DM to appear (server will assign the correct stable ID)
			const unsubscribe = channels.subscribe(chs => {
				// Check by our computed ID or by otherUser match
				const newDM = chs.find(ch => ch.id === dmId || (ch.type === 'dm' && ch.otherUser?.id === user.id));
				if (newDM) {
					joinChannel(newDM.id);
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

	function handleDMLongPress(event: TouchEvent, dmChannel: any) {
		const touch = event.touches?.[0] || event.changedTouches?.[0];
		if (!touch) return;
		const syntheticEvent = new MouseEvent('contextmenu', {
			clientX: touch.clientX,
			clientY: touch.clientY,
			bubbles: true
		});
		handleDMRightClick(syntheticEvent, dmChannel);
	}

	// TEMPORARY: Context menu handlers
	function handleDMRightClick(event: MouseEvent, dmChannel: any) {
		event.preventDefault();
		contextMenuDM = dmChannel;
		contextMenuPosition = { x: event.clientX, y: event.clientY };
		showContextMenu = true;
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuDM = null;
	}

	function deleteDM() {
		if (!contextMenuDM) return;
		// TODO: Implement delete DM on backend
		// For now, just remove from local state by leaving the channel
		console.log('Delete DM:', contextMenuDM.id);
		closeContextMenu();
	}

	function archiveDM() {
		if (!contextMenuDM) return;
		// TODO: Implement archive DM on backend
		console.log('Archive DM:', contextMenuDM.id);
		closeContextMenu();
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
					{#if channel.type === 'group'}
						<button
							class="dm-item"
							class:active={$currentChannel === channel.id}
							on:click={() => selectDM(channel.id)}
							on:contextmenu={(e) => handleDMRightClick(e, channel)}
							use:longpress={{ onLongPress: (e) => handleDMLongPress(e, channel) }}
						>
							<div class="dm-avatar">
								<GroupAvatar {channel} size={40} />
							</div>
							<div class="dm-info">
								<span class="dm-name">{channel.name}</span>
								<span class="dm-preview">{getLastMessagePreview(channel.id)}</span>
							</div>
						</button>
					{:else}
						{@const otherUser = getOtherUser(channel)}
						{#if otherUser}
							<button
								class="dm-item"
								class:active={$currentChannel === channel.id}
								on:click={() => selectDM(channel.id)}
								on:contextmenu={(e) => handleDMRightClick(e, channel)}
								use:longpress={{ onLongPress: (e) => handleDMLongPress(e, channel) }}
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
					{/if}
				{/each}
			</div>
		{/if}
	{/if}

	<!-- TEMPORARY: Context menu for DMs -->
	{#if showContextMenu && contextMenuDM}
		<div
			class="context-menu"
			style:left="{contextMenuPosition.x}px"
			style:top="{contextMenuPosition.y}px"
			on:click={closeContextMenu}
			on:contextmenu|preventDefault
		>
			<button class="context-menu-item" on:click={archiveDM}>
				📦 Archive
			</button>
			<button class="context-menu-item" on:click={deleteDM}>
				🗑️ Delete
			</button>
		</div>
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

	/* TEMPORARY: Context menu styles */
	.context-menu {
		position: fixed;
		background: var(--bg-secondary);
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		z-index: 1000;
		min-width: 150px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	}

	.context-menu-item {
		display: block;
		width: 100%;
		padding: 0.5rem 1rem;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
		font-size: var(--text-sm);
		transition: background 0.2s;
	}

	.context-menu-item:hover {
		background: var(--bg-hover);
	}

	.context-menu-item:first-child {
		border-radius: var(--radius-md) var(--radius-md) 0 0;
	}

	.context-menu-item:last-child {
		border-radius: 0 0 var(--radius-md) var(--radius-md);
	}

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.dm-header {
			padding: 0.75rem;
			min-height: 52px;
		}

		.dm-toggle,
		.dm-create {
			font-size: 1rem;
			padding: 0.5rem;
			min-height: 44px;
		}

		.dm-create-panel {
			padding: 0.75rem;
			gap: 0.5rem;
		}

		.search-input {
			padding: 0.75rem;
			font-size: 16px;
			min-height: 44px;
			border-radius: 8px;
		}

		.user-list {
			gap: 0.25rem;
			max-height: 250px;
		}

		.user-item {
			padding: 0.625rem 0.5rem;
			min-height: 52px;
			font-size: 1rem;
		}

		.user-avatar {
			width: 40px;
			height: 40px;
		}

		.username {
			font-size: 1rem;
		}

		.dm-list {
			gap: 0.25rem;
			padding: 0.375rem;
		}

		.dm-item {
			padding: 0.625rem 0.5rem;
			min-height: 56px;
			border-radius: 8px;
		}

		.dm-avatar {
			width: 44px;
			height: 44px;
		}

		.dm-name {
			font-size: 1rem;
		}

		.dm-preview {
			font-size: 0.8125rem;
		}

		.empty,
		.empty-state {
			padding: 1.5rem;
			font-size: 1rem;
		}

		.start-dm-btn {
			padding: 0.75rem 1.5rem;
			font-size: 1rem;
			min-height: 44px;
			border-radius: 8px;
		}

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
		.dm-item {
			padding: 0.5rem;
			min-height: 52px;
		}

		.dm-avatar {
			width: 40px;
			height: 40px;
		}

		.user-item {
			padding: 0.5rem;
			min-height: 48px;
		}

		.user-avatar {
			width: 36px;
			height: 36px;
		}
	}
</style>
