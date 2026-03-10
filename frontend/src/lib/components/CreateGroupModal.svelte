<script lang="ts">
	import { users, currentUser, createGroup } from '$lib/socket';
	import type { User } from '$lib/socket';

	export let isOpen = false;

	let searchQuery = '';
	let groupName = '';
	let selectedUsers: User[] = [];

	$: filteredUsers = $users.filter(user => {
		if (user.id === $currentUser?.id) return false;
		if (selectedUsers.some(s => s.id === user.id)) return false;
		if (searchQuery) {
			return user.username.toLowerCase().includes(searchQuery.toLowerCase());
		}
		return true;
	});

	function toggleUser(user: User) {
		const idx = selectedUsers.findIndex(s => s.id === user.id);
		if (idx >= 0) {
			selectedUsers = selectedUsers.filter((_, i) => i !== idx);
		} else {
			selectedUsers = [...selectedUsers, user];
		}
	}

	function removeSelected(user: User) {
		selectedUsers = selectedUsers.filter(s => s.id !== user.id);
	}

	function handleCreate() {
		if (!groupName.trim() || selectedUsers.length === 0) return;
		const memberIds = selectedUsers.map(u => u.dbUserId ? `user-${u.dbUserId}` : u.id);
		createGroup(groupName.trim(), memberIds);
		closeModal();
	}

	function closeModal() {
		isOpen = false;
		searchQuery = '';
		groupName = '';
		selectedUsers = [];
	}

	function getStatusColor(status: string) {
		switch (status) {
			case 'active': return 'var(--status-online)';
			case 'away': return 'var(--status-away)';
			case 'busy': return 'var(--status-busy)';
			default: return 'var(--status-offline)';
		}
	}
</script>

{#if isOpen}
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeModal}
		on:keydown={(e) => { if (e.key === 'Escape') closeModal(); }}
	></div>
	<div class="modal">
		<div class="modal-header">
			<h2>Create Group</h2>
			<button class="close-btn" on:click={closeModal}>x</button>
		</div>

		<div class="group-name-container">
			<input
				type="text"
				bind:value={groupName}
				placeholder="Group name..."
				class="group-name-input"
			/>
		</div>

		{#if selectedUsers.length > 0}
			<div class="selected-chips">
				{#each selectedUsers as user (user.id)}
					<span class="chip">
						{user.username}
						<button class="chip-remove" on:click={() => removeSelected(user)}>x</button>
					</span>
				{/each}
			</div>
		{/if}

		<div class="search-container">
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search users to add..."
			/>
		</div>

		<div class="user-list">
			{#if filteredUsers.length === 0}
				<div class="no-users">No users found</div>
			{:else}
				{#each filteredUsers as user (user.id)}
					<button class="user-item" on:click={() => toggleUser(user)}>
						<div class="user-avatar-container">
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="user-avatar" />
							{:else}
								<div class="user-avatar-placeholder" style="background-color: {user.roleColor || user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<div class="status-indicator" style="background-color: {getStatusColor(user.status)}"></div>
						</div>
						<div class="user-info">
							<div class="username">{user.username}</div>
							{#if user.handle}<div class="handle">@{user.handle}</div>{/if}
						</div>
					</button>
				{/each}
			{/if}
		</div>

		<div class="modal-footer">
			<button class="create-btn" on:click={handleCreate} disabled={!groupName.trim() || selectedUsers.length === 0}>
				Create Group ({selectedUsers.length + 1} members)
			</button>
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
		background: var(--modal-overlay);
		z-index: var(--z-modal);
	}

	.modal {
		position: fixed;
		top: 0;
		right: 0;
		width: 400px;
		height: 100vh;
		height: 100dvh;
		background: var(--modal-bg);
		z-index: var(--z-modal-surface);
		display: flex;
		flex-direction: column;
		box-shadow: -4px 0 12px rgba(0, 0, 0, 0.3);
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
		color: var(--text-primary);
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.5rem;
		cursor: pointer;
		padding: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-btn:hover {
		color: var(--text-primary);
		background: var(--ui-bg-light);
	}

	.group-name-container {
		padding: 1rem 1.5rem 0.5rem;
	}

	.group-name-input {
		width: 100%;
		padding: 0.75rem;
		background: var(--ui-bg-lighter);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.group-name-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.selected-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding: 0.5rem 1.5rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		background: var(--accent);
		color: white;
		border-radius: 12px;
		font-size: 0.8rem;
		font-weight: 500;
	}

	.chip-remove {
		background: none;
		border: none;
		color: rgba(255,255,255,0.8);
		cursor: pointer;
		padding: 0 2px;
		font-size: 0.85rem;
		line-height: 1;
	}

	.chip-remove:hover {
		color: white;
	}

	.search-container {
		padding: 0.5rem 1.5rem;
		border-bottom: 1px solid var(--ui-bg-light);
	}

	.search-container input {
		width: 100%;
		padding: 0.75rem;
		background: var(--ui-bg-lighter);
		border: none;
		color: var(--text-primary);
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
		color: var(--text-primary);
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
		border-radius: 50%;
		object-fit: cover;
	}

	.user-avatar-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		color: white;
		font-size: 0.8rem;
	}

	.status-indicator {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--modal-bg);
	}

	.user-info {
		flex: 1;
		min-width: 0;
	}

	.username {
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.handle {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.modal-footer {
		padding: 1rem 1.5rem;
		border-top: 1px solid var(--ui-bg-light);
	}

	.create-btn {
		width: 100%;
		padding: 0.75rem;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.create-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.create-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	@media (max-width: 768px) {
		.modal {
			width: 100%;
		}
	}
</style>
