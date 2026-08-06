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

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && isOpen) {
			closeModal();
		}
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

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="modal-overlay" on:click={closeModal}></div>
	<div class="modal" role="dialog" aria-modal="true" tabindex="-1">
		<div class="modal-header">
			<h2>Start a Direct Message</h2>
			<button class="close-btn" on:click={closeModal} aria-label="Close">&times;</button>
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
								<div class="user-avatar-placeholder" style="background-color: {user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<div class="status-indicator" style="background-color: {getStatusColor(user.status)}"></div>
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
		background: var(--surface-overlay, rgba(0, 0, 0, 0.6));
		z-index: var(--z-modal);
	}

	.modal {
		position: fixed;
		top: 0;
		right: 0;
		width: 400px;
		height: 100vh;
		height: 100dvh;
		background: var(--surface-modal, #0f0c29);
		z-index: var(--z-modal-surface);
		display: flex;
		flex-direction: column;
		box-shadow: var(--shadow-drawer-right, -8px 0 28px rgba(0, 0, 0, 0.35));
	}

	.modal-header {
		padding: var(--space-6, 1.5rem);
		border-bottom: 1px solid var(--border-subtle, #24243e);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.modal-header h2 {
		margin: 0;
		font-size: var(--text-xl, 1.25rem);
		font-weight: var(--font-weight-semibold, 600);
		color: var(--text-heading, #e0e0ff);
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: var(--text-2xl, 1.5rem);
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all var(--duration-fast, 150ms);
	}

	.close-btn:hover {
		color: var(--text-primary);
		background: var(--surface-raised, #24243e);
		transform: none;
	}

	.search-container {
		padding: var(--space-4, 1rem) var(--space-6, 1.5rem);
		border-bottom: 1px solid var(--border-subtle, #24243e);
	}

	.search-container input {
		width: 100%;
		padding: var(--space-3, 0.75rem);
		background: var(--surface-base, #1a1a2e);
		border: none;
		color: var(--text-heading, #e0e0ff);
		font-size: var(--text-base, 0.875rem);
	}

	.search-container input:focus {
		outline: none;
	}

	.user-list {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-2, 0.5rem);
	}

	.no-users {
		padding: var(--space-8, 2rem);
		text-align: center;
		color: var(--text-secondary);
	}

	.user-item {
		display: flex;
		align-items: center;
		gap: var(--space-4, 1rem);
		padding: var(--space-3, 0.75rem);
		width: 100%;
		background: transparent;
		border: none;
		cursor: pointer;
		transition: background var(--duration-fast, 150ms);
		text-align: left;
	}

	.user-item:hover {
		background: var(--surface-raised, #24243e);
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
		font-weight: var(--font-weight-semibold, 600);
		color: var(--text-heading, #e0e0ff);
	}

	.status-indicator {
		position: absolute;
		bottom: 0;
		right: 0;
		width: var(--space-3, 12px);
		height: var(--space-3, 12px);
		border-radius: 50%;
		border: 2px solid var(--surface-modal, #0f0c29);
	}

	.user-info {
		flex: 1;
		min-width: 0;
	}

	.username {
		font-size: var(--text-base, 0.875rem);
		font-weight: var(--font-weight-medium, 500);
		color: var(--text-heading, #e0e0ff);
		margin-bottom: var(--space-1, 0.25rem);
	}

	.status-text {
		font-size: var(--text-sm, 0.8125rem);
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
</style>
