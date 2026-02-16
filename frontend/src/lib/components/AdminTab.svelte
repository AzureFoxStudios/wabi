<script lang="ts">
	import { users, currentUser, createDM, assignRole, removeUserRole, type User } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';

	let searchQuery = '';

	$: canManageRoles = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: isModerator = $currentUser?.highestRole === 'mod';
	$: visibleUsers = $users.filter((u) => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return true;
		return u.username.toLowerCase().includes(q) || (u.handle || '').toLowerCase().includes(q);
	});

	$: sortedUsers = [...visibleUsers].sort((a, b) => {
		const aPriority = a.highestRole === 'owner' ? 3 : a.highestRole === 'admin' ? 2 : a.highestRole === 'mod' ? 1 : 0;
		const bPriority = b.highestRole === 'owner' ? 3 : b.highestRole === 'admin' ? 2 : b.highestRole === 'mod' ? 1 : 0;
		if (aPriority !== bPriority) return bPriority - aPriority;
		return a.username.localeCompare(b.username);
	});

	$: ownerCount = $users.filter((u) => u.highestRole === 'owner').length;
	$: adminCount = $users.filter((u) => u.highestRole === 'admin').length;
	$: modCount = $users.filter((u) => u.highestRole === 'mod').length;
	$: guestCount = $users.filter((u) => !u.dbUserId).length;

	function userHasRole(user: User, role: 'admin' | 'mod' | 'owner'): boolean {
		return user.highestRole === role || (user.roles || []).includes(role);
	}

	function canManageTargetUser(user: User): boolean {
		if (!canManageRoles) return false;
		if (!$currentUser || user.id === $currentUser.id) return false;
		if (!user.dbUserId) return false;
		if (user.highestRole === 'owner') return false;
		return true;
	}

	function handleMessage(user: User) {
		createDM(user.id);
		layoutStore.showDMsTab();
	}

	function promoteUser(user: User, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		assignRole(user.dbUserId, role);
	}

	function removeRoleFromUser(user: User, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, role);
	}

	function resetToMember(user: User) {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, 'admin');
		removeUserRole(user.dbUserId, 'mod');
	}
</script>

<div class="admin-tab">
	<div class="admin-header">
		<div class="admin-title-row">
			<h3>Admin Dashboard</h3>
			<span class="admin-role-indicator">You: {$currentUser?.highestRole || 'member'}</span>
		</div>
		<p class="admin-subtitle">
			{#if canManageRoles}
				Manage users, moderation roles, and quick member actions.
			{:else if isModerator}
				Moderator view: monitor users and jump into direct messages quickly.
			{:else}
				No moderation privileges detected.
			{/if}
		</p>
	</div>

	<div class="admin-stats">
		<div class="admin-stat"><span class="k">Users</span><span class="v">{$users.length}</span></div>
		<div class="admin-stat"><span class="k">Owners</span><span class="v">{ownerCount}</span></div>
		<div class="admin-stat"><span class="k">Admins</span><span class="v">{adminCount}</span></div>
		<div class="admin-stat"><span class="k">Mods</span><span class="v">{modCount}</span></div>
		<div class="admin-stat"><span class="k">Guests</span><span class="v">{guestCount}</span></div>
	</div>

	<div class="admin-search-wrap">
		<input
			type="text"
			class="admin-search"
			placeholder="Search users by name or handle..."
			bind:value={searchQuery}
		/>
	</div>

	<div class="admin-user-list">
		{#each sortedUsers as user (user.id)}
			<div class="admin-user-item">
				<div class="admin-user-meta">
					<span class="admin-user-name">{user.username}</span>
					<span class="admin-role-badge">{user.highestRole || 'member'}</span>
					{#if !user.dbUserId}
						<span class="admin-guest-badge">guest</span>
					{/if}
				</div>
				<div class="admin-actions">
					<button class="admin-btn" on:click={() => handleMessage(user)}>Message</button>
					{#if canManageRoles}
						<button
							class="admin-btn"
							disabled={!canManageTargetUser(user) || userHasRole(user, 'admin')}
							on:click={() => promoteUser(user, 'admin')}
						>
							Make Admin
						</button>
						<button
							class="admin-btn"
							disabled={!canManageTargetUser(user) || !userHasRole(user, 'admin')}
							on:click={() => removeRoleFromUser(user, 'admin')}
						>
							Remove Admin
						</button>
						<button
							class="admin-btn"
							disabled={!canManageTargetUser(user) || userHasRole(user, 'mod')}
							on:click={() => promoteUser(user, 'mod')}
						>
							Make Mod
						</button>
						<button
							class="admin-btn"
							disabled={!canManageTargetUser(user) || !userHasRole(user, 'mod')}
							on:click={() => removeRoleFromUser(user, 'mod')}
						>
							Remove Mod
						</button>
						<button
							class="admin-btn danger"
							disabled={!canManageTargetUser(user) || (!userHasRole(user, 'admin') && !userHasRole(user, 'mod'))}
							on:click={() => resetToMember(user)}
						>
							Reset
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="admin-empty">No users match your search.</div>
		{/each}
	</div>
</div>

<style>
	.admin-tab {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		padding: 0.6rem;
		gap: 0.55rem;
	}

	.admin-header {
		padding: 0.2rem 0.2rem 0.15rem;
	}

	.admin-title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.admin-title-row h3 {
		margin: 0;
		font-size: 0.92rem;
	}

	.admin-role-indicator {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-secondary);
	}

	.admin-subtitle {
		margin: 0.25rem 0 0;
		font-size: 0.76rem;
		color: var(--text-secondary);
	}

	.admin-stats {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 0.35rem;
	}

	.admin-stat {
		display: flex;
		flex-direction: column;
		padding: 0.4rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-tertiary);
	}

	.admin-stat .k {
		font-size: 0.65rem;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.admin-stat .v {
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.admin-search-wrap {
		padding: 0.1rem;
	}

	.admin-search {
		width: 100%;
		height: 30px;
		padding: 0 0.6rem;
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.82rem;
	}

	.admin-user-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.1rem;
	}

	.admin-user-item {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.55rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.admin-user-meta {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.admin-user-name {
		font-size: 0.84rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.admin-role-badge,
	.admin-guest-badge {
		font-size: 0.64rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.12rem 0.35rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--text-secondary);
	}

	.admin-guest-badge {
		background: rgba(255, 193, 7, 0.12);
		border-color: rgba(255, 193, 7, 0.35);
	}

	.admin-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.admin-btn {
		height: 26px;
		padding: 0 0.5rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-tertiary);
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
	}

	.admin-btn:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.admin-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.admin-btn.danger:hover:not(:disabled) {
		color: #f44336;
		border-color: rgba(244, 67, 54, 0.4);
		background: rgba(244, 67, 54, 0.08);
	}

	.admin-empty {
		padding: 1rem 0.75rem;
		text-align: center;
		color: var(--text-secondary);
		font-size: 0.82rem;
	}

	@media (max-width: 768px) {
		.admin-stats {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
