<script lang="ts">
	import type { User } from '$lib/socket';

	export let sortedAdminUsers: User[];
	export let canManageTargetUser: (user: User) => boolean;
	export let userHasRole: (user: User, role: 'admin' | 'mod' | 'owner') => boolean;
	export let getRoleLabel: (roleName?: string) => string;
	export let onPromoteAdmin: (user: User) => void;
	export let onRemoveAdmin: (user: User) => void;
	export let onPromoteMod: (user: User) => void;
	export let onRemoveMod: (user: User) => void;
	export let onResetToMember: (user: User) => void;
	export let onResetPassword: (user: User) => void;
	export let onClearLockout: (user: User) => void;
</script>

<div class="admin-user-list">
	{#each sortedAdminUsers as user (user.id)}
		<div class="admin-user-item">
			<div class="admin-user-meta">
				<span class="admin-user-name">{user.username}</span>
				<span class="admin-role-badge">{getRoleLabel(user.highestRole || 'member')}</span>
				{#if !user.dbUserId}
					<span class="admin-guest-badge">{getRoleLabel('guest')} session</span>
				{/if}
			</div>
			<div class="admin-user-actions">
				<button
					class="action-btn"
					disabled={!canManageTargetUser(user) || userHasRole(user, 'admin')}
					on:click={() => onPromoteAdmin(user)}
				>
					Make Admin
				</button>
				<button
					class="action-btn"
					disabled={!canManageTargetUser(user) || !userHasRole(user, 'admin')}
					on:click={() => onRemoveAdmin(user)}
				>
					Remove Admin
				</button>
				<button
					class="action-btn"
					disabled={!canManageTargetUser(user) || userHasRole(user, 'mod')}
					on:click={() => onPromoteMod(user)}
				>
					Make Mod
				</button>
				<button
					class="action-btn"
					disabled={!canManageTargetUser(user) || !userHasRole(user, 'mod')}
					on:click={() => onRemoveMod(user)}
				>
					Remove Mod
				</button>
				<button
					class="action-btn danger"
					disabled={!canManageTargetUser(user) || (!userHasRole(user, 'admin') && !userHasRole(user, 'mod'))}
					on:click={() => onResetToMember(user)}
				>
					Reset to Member
				</button>
				<button
					class="action-btn"
					disabled={!canManageTargetUser(user)}
					on:click={() => onResetPassword(user)}
				>
					Reset Password
				</button>
				<button
					class="action-btn"
					disabled={!canManageTargetUser(user)}
					on:click={() => onClearLockout(user)}
				>
					Clear Lockout
				</button>
			</div>
		</div>
	{/each}
</div>
