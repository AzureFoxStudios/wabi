<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { users, currentUser, socket, channels, type User, createDM, channelUnreadCounts } from '$lib/socket';
	import { startCall } from '$lib/calling';
	import ProfileModal from './ProfileModal.svelte';
	import UserContextMenu from './UserContextMenu.svelte';
	import CreateDMModal from './CreateDMModal.svelte';

	const dispatch = createEventDispatcher();

	// Helper function to get DM channel ID for a user
	function getDMChannelId(userId: string): string {
		const memberIds = [$currentUser?.id, userId].sort();
		return `dm-${memberIds.join('-')}`;
	}

	// Helper function to get unread count for a user's DM
	function getUserUnreadCount(userId: string): number {
		const dmId = getDMChannelId(userId);
		return $channelUnreadCounts[dmId] || 0;
	}

	// Helper function to format badge display
	function formatBadge(count: number): string {
		if (count === 0) return '';
		if (count <= 10) return `+${count}`;
		return '•';
	}

	let showProfileModal = false;
	let selectedUser: User | null = null;
	let isOwnProfile = false;
	let showDMModal = false;

	// Context menu state
	let showContextMenu = false;
	let contextMenuUser: User | null = null;
	let contextMenuX = 0;
	let contextMenuY = 0;

	function openProfile(user: User) {
		selectedUser = user;
		isOwnProfile = user.id === $currentUser?.id;
		showProfileModal = true;
	}

	function handleContextMenu(event: MouseEvent, user: User) {
		event.preventDefault();
		event.stopPropagation();
		contextMenuUser = user;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		showContextMenu = true;
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuUser = null;
	}

	function handleOpenDM(targetUser?: User) {
		const user = targetUser || contextMenuUser;
		if (!user) return;

		// Create DM and find the channel
		const memberIds = [$currentUser?.id, user.id].sort();
		const dmId = `dm-${memberIds.join('-')}`;

		// Check if DM already exists
		const existingDM = $channels.find(ch => ch.id === dmId);

		if (existingDM) {
			// DM exists, open it immediately
			dispatch('openDM', { channelId: dmId, otherUser: user });
		} else {
			// Create new DM
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
	}

	function openDMModal() {
		showDMModal = true;
	}

	function getStatusColor(status: string) {
		switch (status) {
			case 'active':
				return 'var(--status-online)';
			case 'away':
				return 'var(--status-away)';
			case 'busy':
				return 'var(--status-busy)';
			default:
				return 'var(--status-offline)';
		}
	}

	async function handleVoiceCall(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || targetUser.id === $currentUser?.id) return;
		try {
			await startCall($socket, targetUser.id, false);
		} catch (error) {
			alert('Failed to start voice call. Please check microphone permissions.');
		}
	}

	async function handleVideoCall(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || targetUser.id === $currentUser?.id) return;
		try {
			await startCall($socket, targetUser.id, true);
		} catch (error) {
			alert('Failed to start video call. Please check camera and microphone permissions.');
		}
	}
</script>

<aside class="user-panel">
	<div class="panel-header">
		<h3>Online ({$users.length})</h3>
		<button class="dm-btn" on:click={openDMModal} title="Start a DM">💬</button>
	</div>

	<div class="user-list">
		{#each $users as user (user.id)}
			<div class="user-container">
				<button
					class="user"
					on:click={() => {
						if (user.id !== $currentUser?.id) {
							handleOpenDM(user);
						} else {
							openProfile(user);
						}
					}}
					on:contextmenu={(e) => handleContextMenu(e, user)}
				>
					<!-- Profile Picture or Placeholder -->
					{#if user.profilePicture}
						<img src={user.profilePicture} alt={user.username} class="user-avatar" />
					{:else}
						<div class="user-avatar-placeholder" style="background-color: {user.color}">
							{user.username.charAt(0).toUpperCase()}
						</div>
					{/if}

					<!-- Username and Status -->
					<div class="user-info">
						<span class="user-name">
							{user.username}
							{#if user.id === $currentUser?.id}<span class="you-badge">(you)</span>{/if}
						</span>
						<div class="user-status">
							<span class="status-dot" style="background-color: {getStatusColor(user.status)}"></span>
							<span class="status-text">{user.status}</span>
						</div>
					</div>

					<!-- Unread badge for DMs -->
					{#if user.id !== $currentUser?.id && getUserUnreadCount(user.id) > 0}
						<span class="unread-badge">{formatBadge(getUserUnreadCount(user.id))}</span>
					{/if}
				</button>

				<!-- Call buttons (only show for other users) -->
				{#if user.id !== $currentUser?.id}
					<div class="call-buttons">
						<button
							class="call-btn voice-call"
							on:click={(e) => handleVoiceCall(e, user)}
							title="Voice call"
						>
							📞
						</button>
						<button
							class="call-btn video-call"
							on:click={(e) => handleVideoCall(e, user)}
							title="Video call"
						>
							📹
						</button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</aside>

<ProfileModal bind:isOpen={showProfileModal} bind:user={selectedUser} {isOwnProfile} />

{#if showContextMenu && contextMenuUser}
	<UserContextMenu
		user={contextMenuUser}
		x={contextMenuX}
		y={contextMenuY}
		isOwnProfile={contextMenuUser.id === $currentUser?.id}
		on:close={closeContextMenu}
		on:voiceCall={() => handleVoiceCall()}
		on:videoCall={() => handleVideoCall()}
		on:openDM={handleOpenDM}
		on:viewProfile={() => {
			if (contextMenuUser) openProfile(contextMenuUser);
		}}
	/>
{/if}

<CreateDMModal bind:isOpen={showDMModal} />

<style>
	.user-panel {
		width: 100%;
		background: var(--bg-secondary);
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.panel-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
		height: 58px;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.panel-header h3 {
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin: 0;
		flex: 1;
	}

	.dm-btn {
		width: 32px;
		height: 32px;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.2rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		padding: 0;
		opacity: 0.6;
	}

	.dm-btn:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
		opacity: 1;
		transform: none;
	}

	.user-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.user-container {
		position: relative;
		margin-bottom: 0.5rem;
	}

	.user-container:hover .call-buttons {
		opacity: 1;
		pointer-events: auto;
	}

	.user {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem;
		border-radius: 0;
		background: transparent;
		border: none;
		width: 100%;
		text-align: left;
		cursor: pointer;
		transition: all 0.2s;
	}

	.user:hover {
		background: var(--bg-tertiary);
		transform: translateX(2px);
	}

	.user-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		border: none;
	}

	.user-avatar-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 1rem;
		border: none;
	}

	.user-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.user-name {
		font-size: 0.9rem;
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.you-badge {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-weight: normal;
		margin-left: 0.25rem;
	}

	.user-status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-text {
		font-size: 0.75rem;
		color: var(--text-secondary);
		text-transform: capitalize;
	}

	.call-buttons {
		position: absolute;
		right: 0.5rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		gap: 0.25rem;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.2s;
	}

	.call-btn {
		width: 32px;
		height: 32px;
		border: none;
		border-radius: 0;
		background: var(--bg-tertiary);
		color: var(--text-primary);
		font-size: 1rem;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.call-btn:hover {
		transform: scale(1.1);
	}

	.voice-call:hover {
		background: var(--color-success);
	}

	.video-call:hover {
		background: var(--color-info);
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
</style>
