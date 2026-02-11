<script lang="ts">
	import { channels, channelMessages, currentUser, users, createDM, deleteDM, getDMChannelIdForUser } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import DMMessageView from './DMMessageView.svelte';
	import type { User, Channel } from '$lib/socket';

	let searchQuery = '';
	let showNewDM = false;

	$: selectedDmId = $layoutStore.selectedDmChannelId;
	$: dmOther = $layoutStore.dmOtherUser;

	$: dmChannels = $channels.filter(ch => ch.type === 'dm').sort((a, b) => {
		const aMsgs = $channelMessages[a.id] || [];
		const bMsgs = $channelMessages[b.id] || [];
		const aLast = aMsgs.length > 0 ? aMsgs[aMsgs.length - 1].timestamp : 0;
		const bLast = bMsgs.length > 0 ? bMsgs[bMsgs.length - 1].timestamp : 0;
		return bLast - aLast;
	});

	$: onlineUsers = $users.filter(u => u.id !== $currentUser?.id);
	$: filteredUsers = searchQuery
		? onlineUsers.filter(u => u.username.toLowerCase().includes(searchQuery.toLowerCase()))
		: onlineUsers;

	function getOtherUser(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;
		const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
		const otherStableId = (channel.members || []).find((id: string) => id !== myStableId);
		if (!otherStableId) return null;
		if (otherStableId.startsWith('user-')) {
			const dbId = parseInt(otherStableId.substring(5), 10);
			return $users.find(u => u.dbUserId === dbId) || null;
		}
		return $users.find(u => u.id === otherStableId) || null;
	}

	function getLastPreview(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return 'No messages';
		const last = msgs[msgs.length - 1];
		if (last.type === 'text') {
			return last.text.length > 35 ? last.text.slice(0, 35) + '...' : last.text;
		}
		return `Sent a ${last.type}`;
	}

	function formatRelativeTime(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return '';
		const ts = msgs[msgs.length - 1].timestamp;
		const diff = Date.now() - ts;
		if (diff < 60000) return 'now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
		return `${Math.floor(diff / 86400000)}d`;
	}

	function selectDM(channel: Channel) {
		const other = getOtherUser(channel);
		if (other) {
			layoutStore.openDM(channel.id, other);
		}
	}

	function startDMWith(user: User) {
		createDM(user.id);
		showNewDM = false;
		searchQuery = '';
	}

</script>

<div class="dm-tab">
	{#if selectedDmId && dmOther}
		<!-- Active DM conversation -->
		<div class="dm-tab-active">
			<div class="dm-active-header">
				<button class="dm-back-btn" on:click={() => layoutStore.closeDM()}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
					<span>All DMs</span>
				</button>
				<button class="dm-delete-btn" on:click={() => { deleteDM(selectedDmId); layoutStore.closeDM(); }} title="Delete conversation">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
				</button>
			</div>
			<div class="dm-tab-messages">
				<DMMessageView channelId={selectedDmId} otherUser={dmOther} />
			</div>
		</div>
	{:else}
		<!-- DM list view -->
		<div class="dm-tab-list">
			<div class="dm-tab-header">
				<span class="dm-tab-title">Direct Messages</span>
				<button class="dm-new-btn" on:click={() => { showNewDM = !showNewDM; }} title="New DM">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
				</button>
			</div>

			{#if showNewDM}
				<div class="dm-new-panel">
					<input
						type="text"
						class="dm-search"
						placeholder="Search users..."
						bind:value={searchQuery}
					/>
					<div class="dm-new-list">
						{#each filteredUsers as user (user.id)}
							<button class="dm-new-user" on:click={() => startDMWith(user)}>
								{#if user.profilePicture}
									<img src={user.profilePicture} alt={user.username} class="dm-new-avatar" />
								{:else}
									<div class="dm-new-avatar-ph" style="background-color: {user.roleColor || user.color}">
										{user.username.charAt(0).toUpperCase()}
									</div>
								{/if}
								<div class="dm-new-info">
									<span class="dm-new-name">{user.username}</span>
									{#if user.handle}<span class="dm-new-handle">@{user.handle}</span>{/if}
								</div>
							</button>
						{:else}
							<div class="dm-empty-search">No users found</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="dm-conversations">
				{#each dmChannels as channel (channel.id)}
					{@const other = getOtherUser(channel)}
					{#if other}
						<div
							class="dm-conv-item"
							role="button"
							tabindex="0"
							on:click={() => selectDM(channel)}
							on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectDM(channel); } }}
						>
							<div class="dm-conv-avatar-wrap">
								{#if other.profilePicture}
									<img src={other.profilePicture} alt={other.username} class="dm-conv-avatar" />
								{:else}
									<div class="dm-conv-avatar-ph" style="background-color: {other.roleColor || other.color}">
										{other.username.charAt(0).toUpperCase()}
									</div>
								{/if}
							</div>
							<div class="dm-conv-info">
								<div class="dm-conv-top">
									<span class="dm-conv-name">{other.username}</span>
									<span class="dm-conv-time">{formatRelativeTime(channel.id)}</span>
								</div>
								<span class="dm-conv-preview">{getLastPreview(channel.id)}</span>
							</div>
							<button
								class="dm-conv-close-btn"
								on:click|stopPropagation={() => { deleteDM(channel.id); if (selectedDmId === channel.id) layoutStore.closeDM(); }}
								title="Delete conversation"
							>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
							</button>
						</div>
					{/if}
				{:else}
					<div class="dm-empty-state">
						<p>No conversations yet</p>
						<button class="dm-start-btn" on:click={() => { showNewDM = true; }}>
							Start a conversation
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.dm-tab {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	/* Active DM view */
	.dm-tab-active {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.dm-active-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.dm-back-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.dm-back-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.dm-delete-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin-right: 0.5rem;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 4px;
	}

	.dm-delete-btn:hover {
		color: #f44336;
		background: rgba(244, 67, 54, 0.1);
	}

	.dm-tab-messages {
		flex: 1;
		min-height: 0;
	}

	/* DM list view */
	.dm-tab-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.dm-tab-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.dm-tab-title {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.dm-new-btn {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.dm-new-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	/* New DM panel */
	.dm-new-panel {
		padding: 0.5rem;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.dm-search {
		width: 100%;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		border-radius: 6px;
		font-size: 0.85rem;
		margin-bottom: 0.375rem;
	}

	.dm-search::placeholder { color: var(--text-secondary); }

	.dm-new-list {
		max-height: 180px;
		overflow-y: auto;
	}

	.dm-new-user {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.375rem 0.5rem;
		background: none;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		border-radius: 4px;
		text-align: left;
	}

	.dm-new-user:hover { background: var(--bg-hover); }

	.dm-new-avatar,
	.dm-new-avatar-ph {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		flex-shrink: 0;
		object-fit: cover;
	}

	.dm-new-avatar-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		font-weight: 600;
		color: white;
	}

	.dm-new-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.dm-new-name {
		font-size: 0.85rem;
		font-weight: 500;
	}

	.dm-new-handle {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.dm-empty-search {
		padding: 0.75rem;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	/* Conversation list */
	.dm-conversations {
		flex: 1;
		overflow-y: auto;
		padding: 0.25rem;
	}

	.dm-conv-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem;
		background: none;
		border: none;
		color: var(--text-primary);
		cursor: pointer;
		border-radius: 6px;
		text-align: left;
		position: relative;
		transition: background 0.15s;
	}

	.dm-conv-item:hover { background: var(--bg-hover); }

	.dm-conv-close-btn {
		position: absolute;
		right: 0.375rem;
		top: 50%;
		transform: translateY(-50%);
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 4px;
		opacity: 0;
		transition: opacity 0.15s, color 0.15s;
	}

	.dm-conv-item:hover .dm-conv-close-btn {
		opacity: 1;
	}

	.dm-conv-close-btn:hover {
		color: #f44336;
		background: rgba(244, 67, 54, 0.1);
	}

	.dm-conv-avatar-wrap {
		flex-shrink: 0;
		width: 36px;
		height: 36px;
	}

	.dm-conv-avatar,
	.dm-conv-avatar-ph {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		object-fit: cover;
	}

	.dm-conv-avatar-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
		font-weight: 600;
		color: white;
	}

	.dm-conv-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
		gap: 2px;
	}

	.dm-conv-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem;
	}

	.dm-conv-name {
		font-size: 0.85rem;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dm-conv-time {
		font-size: 0.65rem;
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.dm-conv-preview {
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}


	/* Empty state */
	.dm-empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 2rem 1rem;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.dm-start-btn {
		padding: 0.5rem 1rem;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 500;
	}

	.dm-start-btn:hover { opacity: 0.85; }

	@media (max-width: 768px) {
		.dm-conv-item {
			padding: 0.625rem 0.5rem;
			min-height: 52px;
		}

		.dm-conv-avatar-wrap {
			width: 40px;
			height: 40px;
		}

		.dm-conv-avatar,
		.dm-conv-avatar-ph {
			width: 40px;
			height: 40px;
		}

		.dm-conv-name { font-size: 1rem; }
		.dm-conv-preview { font-size: 0.85rem; }

		.dm-new-user {
			padding: 0.625rem 0.5rem;
			min-height: 44px;
		}
	}
</style>
