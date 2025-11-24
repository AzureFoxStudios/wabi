<script lang="ts">
	import { users, currentUser, socket, type User } from '$lib/socket';
	import { startCall } from '$lib/calling';
	import ProfileModal from './ProfileModal.svelte';

	let showProfileModal = false;
	let selectedUser: User | null = null;
	let isOwnProfile = false;

	function openProfile(user: User) {
		selectedUser = user;
		isOwnProfile = user.id === $currentUser?.id;
		showProfileModal = true;
	}

	function getStatusColor(status: string) {
		switch (status) {
			case 'active':
				return '#10b981';
			case 'away':
				return '#f59e0b';
			case 'busy':
				return '#ef4444';
			default:
				return '#6b7280';
		}
	}

	async function handleVoiceCall(event: MouseEvent, user: User) {
		event.stopPropagation();
		if (!$socket || user.id === $currentUser?.id) return;
		try {
			await startCall($socket, user.id, false);
		} catch (error) {
			alert('Failed to start voice call. Please check microphone permissions.');
		}
	}

	async function handleVideoCall(event: MouseEvent, user: User) {
		event.stopPropagation();
		if (!$socket || user.id === $currentUser?.id) return;
		try {
			await startCall($socket, user.id, true);
		} catch (error) {
			alert('Failed to start video call. Please check camera and microphone permissions.');
		}
	}
</script>

<aside class="user-panel">
	<div class="panel-header">
		<h3>Online ({$users.length})</h3>
	</div>

	<div class="user-list">
		{#each $users as user (user.id)}
			<div class="user-container">
				<button class="user" on:click={() => openProfile(user)}>
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
		padding: 1rem;
		border-bottom: 1px solid var(--border);
	}

	.panel-header h3 {
		font-size: 0.85rem;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin: 0;
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
		border-radius: 8px;
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
		border: 2px solid var(--border);
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
		border: 2px solid var(--border);
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
		border-radius: 6px;
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
		background: #10b981;
	}

	.video-call:hover {
		background: #3b82f6;
	}
</style>
