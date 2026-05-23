<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { User } from '$lib/socket';

	type ManagedUserRole = 'member' | 'mod' | 'admin';

	export let sortedUsers: User[];
	export let searchQuery: string;
	export let canManageRoles: boolean;
	export let canManageTargetUser: (user: User) => boolean;
	export let getRoleLabel: (roleName?: string) => string;
	export let getManagedUserRole: (user: User) => ManagedUserRole;
	export let manageableUserRoleOptions: ManagedUserRole[];
	export let isUserPaymentBlocked: (user: User) => boolean;
	export let paymentBlockBusyUserId: number | null;
	export let onSearchInput: (value: string) => void;
	export let onMessage: (user: User) => void;
	export let onUserRoleChange: (user: User, role: ManagedUserRole) => void;
	export let onTogglePaymentBlock: (user: User) => void;
</script>

<div class="admin-section">
	<h4>{$_('admin.sections.users')}</h4>
	<div class="admin-search-wrap">
		<input
			type="text"
			class="admin-search"
			placeholder={$_('admin.placeholders.search_users')}
			value={searchQuery}
			on:input={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
		/>
	</div>
	<div class="admin-user-list">
		{#each sortedUsers as user (user.id)}
			<div class="admin-user-item">
				<div class="admin-user-meta">
					<span class="admin-user-name">{user.username}</span>
					<span class="admin-role-badge">{getRoleLabel(user.highestRole || 'member')}</span>
					{#if !user.dbUserId}
						<span class="admin-guest-badge">{getRoleLabel('guest')}</span>
					{/if}
					{#if user.dbUserId && isUserPaymentBlocked(user)}
						<span class="admin-payment-block-badge">Pay Blocked</span>
					{/if}
				</div>
				<div class="admin-actions">
					<button class="admin-icon-btn" on:click={() => onMessage(user)} title={$_('admin.actions.message')} aria-label={$_('admin.actions.message')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
						</svg>
					</button>
					{#if canManageRoles}
						<label class="admin-role-control">
							<span>Role</span>
							<select
								class="admin-select admin-user-role-select"
								value={getManagedUserRole(user)}
								disabled={!canManageTargetUser(user)}
								on:change={(event) => onUserRoleChange(user, (event.currentTarget as HTMLSelectElement).value as ManagedUserRole)}
							>
								{#each manageableUserRoleOptions as roleName (roleName)}
									<option value={roleName}>{getRoleLabel(roleName)}</option>
								{/each}
							</select>
						</label>
						<button
							class="admin-btn warning admin-pay-toggle"
							disabled={!canManageTargetUser(user) || !user.dbUserId || paymentBlockBusyUserId === user.dbUserId}
							on:click={() => onTogglePaymentBlock(user)}
						>
							{#if paymentBlockBusyUserId === user.dbUserId}
								Updating...
							{:else if isUserPaymentBlocked(user)}
								Enable Pay
							{:else}
								Disable Pay
							{/if}
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="admin-empty">{$_('admin.empty.search')}</div>
		{/each}
	</div>
</div>
