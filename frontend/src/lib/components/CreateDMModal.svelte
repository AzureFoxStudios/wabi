<script lang="ts">
	import { tick } from 'svelte';
	import { users, serverMembers, currentUser, createDM } from '$lib/socket';
	import type { User } from '$lib/socket';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';

	export let isOpen = false;

	let searchQuery = '';
	let searchInput: HTMLInputElement | null = null;

	$: if (isOpen) {
		void tick().then(() => searchInput?.focus());
	}

	$: filteredUsers = buildDmDirectoryUsers({
		onlineUsers: $users,
		serverMembers: $serverMembers,
		currentUser: $currentUser,
		searchQuery
	});

	function handleUserClick(user: User) {
		createDM(getDmDirectoryKey(user));
		closeModal();
	}

	function closeModal() {
		isOpen = false;
		searchQuery = '';
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
</script>

{#if isOpen}
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeModal}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeModal();
			}
		}}
	></div>
	<div class="modal">
		<div class="modal-header">
			<h2>Start a Direct Message</h2>
			<button class="close-btn" on:click={closeModal}>×</button>
		</div>

		<div class="search-container">
			<input
				bind:this={searchInput}
				type="text"
				bind:value={searchQuery}
				placeholder="Search users..."
			/>
		</div>

		<div class="user-list">
			{#if filteredUsers.length === 0}
				<div class="no-users">No users found</div>
			{:else}
				{#each filteredUsers as user (getDmDirectoryKey(user))}
					<button class="user-item" on:click={() => handleUserClick(user)}>
						<div class="user-avatar-container">
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="user-avatar" />
							{:else}
								<div class="user-avatar-placeholder" style="--avatar-color: {user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<div class="status-indicator" style="--status-color: {getStatusColor(user.status)}"></div>
						</div>
						<div class="user-info">
							<div class="username">{user.username}</div>
							<div class="status-text">{user.status}</div>
						</div>
					</button>
				{/each}
			{/if}
		</div>
	</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: var(--surface-overlay);
		z-index: var(--z-modal);
	}

	.modal {
		position: fixed;
		top: 0;
		right: 0;
		width: 400px;
		height: 100vh;
		height: 100dvh;
		background: var(--surface-modal);
		z-index: var(--z-modal-surface);
		display: flex;
		flex-direction: column;
		box-shadow: -4px 0 12px var(--shadow-sm, var(--shadow-lg, rgba(0, 0, 0, 0.3)));
	}

	.modal-header {
		padding: 1.5rem;
		border-bottom: 1px solid var(--ui-bg-light);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-heading);
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 2rem;
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
	}

	.close-btn:hover {
		color: var(--text-heading);
		background: var(--ui-bg-light);
		transform: none;
	}

	.search-container {
		padding: 1rem 1.5rem;
		border-bottom: 1px solid var(--ui-bg-light);
	}

	.search-container input {
		width: 100%;
		padding: 0.75rem;
		background: var(--ui-bg-lighter);
		border: none;
		color: var(--text-heading);
		font-size: 0.9rem;
	}

	.search-container input:focus {
		outline: none;
	}

	.user-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.no-users {
		padding: 2rem;
		text-align: center;
		color: var(--text-secondary);
	}

	.user-item {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem;
		width: 100%;
		background: transparent;
		border: none;
		cursor: pointer;
		transition: background 0.2s;
		text-align: left;
	}

	.user-item:hover {
		background: var(--ui-bg-light);
	}

	.user-avatar-container {
		position: relative;
		flex-shrink: 0;
	}

	.user-avatar,
	.user-avatar-placeholder {
		width: 32px;
		height: 32px;
	}

	.user-avatar-placeholder {
		font-weight: 600;
		color: var(--text-heading);
	}

	.status-indicator {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--surface-modal);
	}

	.user-info {
		flex: 1;
		min-width: 0;
	}

	.username {
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text-heading);
		margin-bottom: 0.25rem;
	}

	.status-text {
		font-size: 0.8rem;
		color: var(--text-secondary);
		text-transform: capitalize;
	}

	/* Mobile responsiveness */
	@media (max-width: 768px) {
		.modal {
			width: 100%;
			right: 0;
			height: 100vh;
			height: 100dvh;
		}
	}

	.user-avatar-placeholder { background-color: var(--avatar-color, var(--accent-primary)); }
	.status-indicator { background-color: var(--status-color); }
</style>
