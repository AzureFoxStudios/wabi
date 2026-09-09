<script lang="ts">
	import { onMount } from 'svelte';
	import { users, serverMembers, currentUser, createGroup } from '$lib/socket';
	import type { User } from '$lib/socket';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';

	let { isOpen = $bindable(false) }: { isOpen?: boolean } = $props();

	let searchQuery = $state('');
	let groupName = $state('');
	let selectedUsers = $state<User[]>([]);
	let pending = $state(false);
	let operationError = $state('');

	// Mirrors the popout `disableAllBanners` profile-visibility kill switch
	// (localStorage `wabi:profile:visibility` -> disableAll).
	let disableAllBanners = $state(false);

	onMount(() => {
		try {
			const raw = localStorage.getItem('wabi:profile:visibility');
			if (!raw) return;
			const v = JSON.parse(raw);
			if (typeof v.disableAll === 'boolean') disableAllBanners = v.disableAll;
		} catch {
			// ignore malformed local state
		}
	});

	let filteredUsers = $derived(buildDmDirectoryUsers({
		onlineUsers: $users,
		serverMembers: $serverMembers,
		currentUser: $currentUser,
		searchQuery
	}).filter((user) => /^user-[1-9][0-9]*$/.test(getDmDirectoryKey(user)) &&
		!selectedUsers.some((selected) => getDmDirectoryKey(selected) === getDmDirectoryKey(user))));

	function toggleUser(user: User) {
		if (pending) return;
		const idx = selectedUsers.findIndex((selected) => getDmDirectoryKey(selected) === getDmDirectoryKey(user));
		if (idx >= 0) {
			selectedUsers = selectedUsers.filter((_, i) => i !== idx);
		} else {
			selectedUsers = [...selectedUsers, user];
		}
	}

	function removeSelected(user: User) {
		if (pending) return;
		selectedUsers = selectedUsers.filter((selected) => getDmDirectoryKey(selected) !== getDmDirectoryKey(user));
	}

	async function handleCreate() {
		if (pending || !groupName.trim() || selectedUsers.length === 0) return;
		const memberIds = selectedUsers.map((user) => getDmDirectoryKey(user));
		pending = true;
		operationError = '';
		try {
			await createGroup(groupName.trim(), memberIds);
			pending = false;
			closeModal();
		} catch (error) {
			operationError = error instanceof Error ? error.message : 'Could not confirm group creation';
		} finally { pending = false; }
	}

	function closeModal() {
		if (pending) return;
		isOpen = false;
		searchQuery = '';
		groupName = '';
		selectedUsers = [];
		operationError = '';
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && isOpen) {
			closeModal();
		}
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

<svelte:window onkeydown={handleKeydown} />

{#if isOpen}
	<!-- The dialog has a labelled close button and Escape handling. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="modal-overlay" onclick={closeModal}></div>
	<div class="modal" role="dialog" aria-modal="true" aria-label="Create group" aria-busy={pending} tabindex="-1">
		<div class="modal-header">
			<h2>Create Group</h2>
			<button class="close-btn" onclick={closeModal} disabled={pending} aria-label="Close">x</button>
		</div>

		<div class="group-name-container">
			<input
				type="text"
				bind:value={groupName}
				placeholder="Group name..."
				aria-label="Group name"
				disabled={pending}
				class="group-name-input"
			/>
		</div>

		{#if selectedUsers.length > 0}
			<div class="selected-chips">
				{#each selectedUsers as user (getDmDirectoryKey(user))}
					<span class="chip">
						{user.username}
						<button class="chip-remove" disabled={pending} aria-label={`Remove ${user.username} from selection`} onclick={() => removeSelected(user)}>x</button>
					</span>
				{/each}
			</div>
		{/if}

		<div class="search-container">
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search users to add..."
				aria-label="Search group invitees"
				disabled={pending}
			/>
		</div>

		<div class="user-list">
			{#if filteredUsers.length === 0}
				<div class="no-users">No users found</div>
			{:else}
				{#each filteredUsers as user (getDmDirectoryKey(user))}
					<button class="user-item" disabled={pending} onclick={() => toggleUser(user)}>
						<div class="user-avatar-container">
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="user-avatar" />
							{:else}
								<div class="user-avatar-placeholder" style="background-color: {user.roleColor || user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							{#if user.overlayUrl && !disableAllBanners}
								<span class="avatar-overlay-badge" style="background-image: url({user.overlayUrl})" aria-hidden="true"></span>
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
			{#if operationError}<p class="operation-error" role="alert">{operationError}</p>{/if}
			{#if pending}<p role="status">Waiting for server confirmation…</p>{/if}
			<button class="create-btn" onclick={handleCreate} disabled={pending || !groupName.trim() || selectedUsers.length === 0}>
				{pending ? 'Creating…' : `Create Group (${selectedUsers.length + 1} members)`}
			</button>
		</div>
	</div>
{/if}

<style>
	.operation-error { color: var(--color-danger, #f44336); overflow-wrap: anywhere; }
	button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
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
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: color var(--duration-fast, 150ms), background-color var(--duration-fast, 150ms);
	}

	.close-btn:hover {
		color: var(--text-primary);
		background: var(--surface-raised, #24243e);
	}

	.group-name-container {
		padding: var(--space-4, 1rem) var(--space-6, 1.5rem) var(--space-2, 0.5rem);
	}

	.group-name-input {
		width: 100%;
		padding: var(--space-3, 0.75rem);
		background: var(--surface-base, #1a1a2e);
		border: 1px solid var(--border-subtle, #24243e);
		border-radius: var(--radius-md, 8px);
		color: var(--text-heading, #e0e0ff);
		font-size: var(--text-base, 0.875rem);
	}

	.group-name-input:focus {
		outline: none;
		border-color: var(--accent-primary-color, #6366f1);
	}

	.selected-chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2, 0.5rem);
		padding: var(--space-2, 0.5rem) var(--space-6, 1.5rem);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1, 0.25rem);
		padding: var(--space-1, 0.25rem) var(--space-2, 0.5rem);
		background: var(--accent-primary-color, #6366f1);
		color: var(--text-on-accent, #0f0c29);
		border-radius: var(--radius-lg, 12px);
		font-size: var(--text-sm, 0.8125rem);
		font-weight: var(--font-weight-medium, 500);
	}

	.chip-remove {
		background: none;
		border: none;
		color: var(--text-on-accent, #0f0c29);
		cursor: pointer;
		padding: 0 2px;
		font-size: var(--text-sm, 0.8125rem);
		line-height: 1;
	}

	.chip-remove:hover {
		color: var(--text-on-accent, #0f0c29);
		opacity: var(--opacity-80, 0.8);
	}

	.search-container {
		padding: var(--space-2, 0.5rem) var(--space-6, 1.5rem);
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
		color: var(--text-heading, #e0e0ff);
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
		border-radius: var(--radius-full, 9999px);
		object-fit: cover;
	}

	.user-avatar-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: var(--font-weight-semibold, 600);
		color: white;
		font-size: var(--text-sm, 0.8125rem);
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
	}

	.handle {
		font-size: var(--text-sm, 0.8125rem);
		color: var(--text-secondary);
	}

	.modal-footer {
		padding: var(--space-4, 1rem) var(--space-6, 1.5rem);
		border-top: 1px solid var(--border-subtle, #24243e);
	}

	.create-btn {
		width: 100%;
		padding: var(--space-3, 0.75rem);
		background: var(--accent-primary-color, #6366f1);
		color: var(--text-on-accent, #0f0c29);
		border: none;
		border-radius: var(--radius-md, 8px);
		font-size: var(--text-base, 0.875rem);
		font-weight: var(--font-weight-semibold, 600);
		cursor: pointer;
		transition: opacity var(--duration-fast, 150ms);
	}

	.create-btn:disabled {
		opacity: var(--opacity-40, 0.4);
		cursor: default;
	}

	.create-btn:hover:not(:disabled) {
		opacity: var(--opacity-90, 0.9);
	}

	@media (max-width: 768px) {
		.modal {
			width: 100%;
		}
	}
</style>
