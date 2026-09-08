<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { User, UserBadge } from '$lib/socket';
	import RoleBadge from '$lib/components/RoleBadge.svelte';

	type ManagedUserRole = 'member' | 'mod' | 'admin';

	let { sortedUsers, searchQuery, canManageRoles, canManageTargetUser, getRoleLabel,
		getManagedUserRole, manageableUserRoleOptions, isUserPaymentBlocked, paymentBlockBusyUserId,
		onSearchInput, onMessage, onUserRoleChange, onTogglePaymentBlock, roleBusyUserIds = [],
		badgeCatalog = [], onAssignBadge = null, onRemoveBadge = null }: {
		sortedUsers: User[]; searchQuery: string; canManageRoles: boolean;
		canManageTargetUser: (user: User) => boolean; getRoleLabel: (roleName?: string) => string;
		getManagedUserRole: (user: User) => ManagedUserRole; manageableUserRoleOptions: ManagedUserRole[];
		isUserPaymentBlocked: (user: User) => boolean; paymentBlockBusyUserId: number | null;
		onSearchInput: (value: string) => void; onMessage: (user: User) => void;
		onUserRoleChange: (user: User, role: ManagedUserRole) => void; onTogglePaymentBlock: (user: User) => void;
		roleBusyUserIds?: number[]; badgeCatalog?: UserBadge[];
		onAssignBadge?: ((user: User, badgeId: string) => void) | null;
		onRemoveBadge?: ((user: User, badgeId: string) => void) | null;
	} = $props();

	const heldBadges = (user: User): UserBadge[] => user.badges ?? [];
	const unheldBadges = (user: User): UserBadge[] =>
		badgeCatalog.filter((b) => !heldBadges(user).some((h) => h.id === b.id));
</script>

<div class="admin-section">
	<h4>{$_('admin.sections.users')}</h4>
	<p class="admin-moderation-limit">Server-wide bans are not available in this version. Changing a role does not revoke account access.</p>
	<div class="admin-search-wrap">
		<input
			type="text"
			class="admin-search"
			placeholder={$_('admin.placeholders.search_users')}
			value={searchQuery}
			oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
			aria-label="Search server members"
		/>
	</div>
	<div class="admin-user-list">
		{#each sortedUsers as user (user.id)}
			<div class="admin-user-item">
				<div class="admin-user-meta">
					<span class="admin-user-name">{user.username}</span>
					<RoleBadge {user} size="md" />
					{#if !user.dbUserId || user.isRegistered === false}
						<span class="admin-guest-badge">{getRoleLabel('guest')}</span>
					{/if}
					{#if user.dbUserId && isUserPaymentBlocked(user)}
						<span class="admin-payment-block-badge">Pay Blocked</span>
					{/if}
				</div>
				<div class="admin-actions">
					<button class="admin-icon-btn" onclick={() => onMessage(user)} title={$_('admin.actions.message')} aria-label={$_('admin.actions.message')}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
						</svg>
					</button>
					{#if canManageRoles}
						<label class="admin-role-control">
							<span>Role</span>
							<select
								class="admin-select admin-user-role-select"
								value={user.highestRole === 'owner' ? 'owner' : user.isRegistered === false ? 'guest' : getManagedUserRole(user)}
								disabled={!canManageTargetUser(user) || roleBusyUserIds.includes(user.dbUserId ?? 0)}
								aria-label={`Role for ${user.username}`}
								onchange={(event) => {
									const select = event.currentTarget;
									const next = select.value as ManagedUserRole;
									select.value = getManagedUserRole(user);
									onUserRoleChange(user, next);
								}}
							>
								{#if user.highestRole === 'owner'}<option value="owner">{getRoleLabel('owner')}</option>{/if}
								{#if user.isRegistered === false}<option value="guest">{getRoleLabel('guest')}</option>{/if}
								{#each manageableUserRoleOptions as roleName (roleName)}
									<option value={roleName}>{getRoleLabel(roleName)}</option>
								{/each}
							</select>
						</label>
						{#if roleBusyUserIds.includes(user.dbUserId ?? 0)}<span role="status">Updating role…</span>{/if}
						{#if badgeCatalog.length > 0 && onAssignBadge && onRemoveBadge}
							<div class="admin-badge-control">
								{#each heldBadges(user) as badge (badge.id)}
									<button
										class="admin-badge-chip"
										title={`Remove ${badge.label}`}
										disabled={!canManageTargetUser(user)}
										onclick={() => onRemoveBadge?.(user, badge.id)}
									>
										<span class="admin-badge-chip-icon">{badge.icon}</span>
										{badge.label}
										<span class="admin-badge-chip-x">×</span>
									</button>
								{/each}
								{#if unheldBadges(user).length > 0}
									<select
										class="admin-select admin-badge-select"
										disabled={!canManageTargetUser(user)}
										value=""
										onchange={(event) => {
													const value = (event.currentTarget as HTMLSelectElement).value;
													if (value) onAssignBadge?.(user, value);
													(event.currentTarget as HTMLSelectElement).value = '';
												}}
									>
										<option value="">+ Badge…</option>
										{#each unheldBadges(user) as badge (badge.id)}
											<option value={badge.id}>{badge.icon} {badge.label}</option>
										{/each}
									</select>
								{/if}
							</div>
						{/if}
						<button
							class="admin-btn warning admin-pay-toggle"
							disabled={!canManageTargetUser(user) || !user.dbUserId || paymentBlockBusyUserId === user.dbUserId}
							onclick={() => onTogglePaymentBlock(user)}
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

<style>
	.admin-moderation-limit { margin: 0; color: var(--text-secondary); font-size: 0.875rem; line-height: 1.6; text-wrap: pretty; }
</style>
