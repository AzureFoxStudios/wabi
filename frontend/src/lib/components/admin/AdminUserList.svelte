<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { User, UserBadge } from '$lib/socket';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import { getDmDirectoryKey } from '$lib/dmUserDirectory';
	import type { AdminBadgeMutationState } from '$lib/adminBadgeMutation';

	type ManagedUserRole = 'member' | 'mod' | 'admin';

	let { sortedUsers, searchQuery, canManageRoles, canManageTargetUser, getRoleLabel,
		getManagedUserRole, manageableUserRoleOptions, isUserPaymentBlocked, paymentBlockBusyUserId, paymentControlsReady = false,
		onSearchInput, onMessage, onUserRoleChange, onTogglePaymentBlock, onResetPassword, roleBusyUserIds = [], messagePendingUserId = null,
		badgeCatalog = [], onAssignBadge = null, onRemoveBadge = null,
		badgeMutationState = { pending: null, error: '', status: '' }, badgeControlsOnline = false }: {
		sortedUsers: User[]; searchQuery: string; canManageRoles: boolean;
		canManageTargetUser: (user: User) => boolean; getRoleLabel: (roleName?: string) => string;
		getManagedUserRole: (user: User) => ManagedUserRole; manageableUserRoleOptions: ManagedUserRole[];
		isUserPaymentBlocked: (user: User) => boolean; paymentBlockBusyUserId: number | null;
		paymentControlsReady?: boolean;
		onSearchInput: (value: string) => void; onMessage: (user: User) => void;
		onUserRoleChange: (user: User, role: ManagedUserRole) => void; onTogglePaymentBlock: (user: User) => void;
		onResetPassword: (user: User) => void;
		messagePendingUserId?: string | null;
		roleBusyUserIds?: number[]; badgeCatalog?: UserBadge[];
		onAssignBadge?: ((user: User, badgeId: string) => void) | null;
		onRemoveBadge?: ((user: User, badgeId: string) => void) | null;
		badgeMutationState?: AdminBadgeMutationState;
		badgeControlsOnline?: boolean;
	} = $props();

	const isUsableBadge = (badge: UserBadge): boolean => Boolean(badge.id?.trim() && badge.label?.trim());
	const availableBadges = $derived(badgeCatalog.filter(isUsableBadge));
	const heldBadges = (user: User): UserBadge[] => (user.badges ?? []).filter(isUsableBadge);
	const unheldBadges = (user: User): UserBadge[] =>
		availableBadges.filter((b) => !heldBadges(user).some((h) => h.id === b.id));
</script>

<section class="admin-people" aria-label="Server members">
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
	{#if badgeMutationState.error}<p class="admin-badge-feedback" role="alert">{badgeMutationState.error}</p>{/if}
	{#if badgeMutationState.pending}<p class="admin-badge-pending" role="status">Updating badges for {badgeMutationState.pending.username}…</p>
	{:else if badgeMutationState.status}<p class="admin-badge-status" role="status">{badgeMutationState.status}</p>{/if}
	{#if canManageRoles && !badgeControlsOnline}<p class="admin-badge-status">Reconnect to change badges.</p>{/if}
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
						<span class="admin-payment-block-badge">Payments restricted</span>
					{/if}
				</div>
				<div class="admin-actions">
					<button class="admin-person-action admin-message-action" type="button" disabled={messagePendingUserId !== null} onclick={() => onMessage(user)} aria-label={`Message ${user.username}`}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
						</svg>
						<span>Message</span>
					</button>
					{#if messagePendingUserId === getDmDirectoryKey(user)}<span class="admin-person-status" role="status">Opening conversation…</span>{/if}
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
						{#if roleBusyUserIds.includes(user.dbUserId ?? 0)}<span class="admin-person-status" role="status">Updating role…</span>{/if}
						{#if canManageTargetUser(user)}
							<button class="admin-person-action admin-reset-password" type="button" aria-label={`Reset password for ${user.username}`} onclick={() => onResetPassword(user)}>Reset password</button>
							<button
								class="admin-person-action admin-pay-toggle"
								type="button"
								disabled={!paymentControlsReady || !user.dbUserId || paymentBlockBusyUserId !== null}
								onclick={() => onTogglePaymentBlock(user)}
							>
								{#if paymentBlockBusyUserId === user.dbUserId}
									Updating…
								{:else if isUserPaymentBlocked(user)}
									Allow payments
								{:else}
									Restrict payments
								{/if}
							</button>
						{/if}
						{#if canManageTargetUser(user) && onAssignBadge && onRemoveBadge && (heldBadges(user).length > 0 || unheldBadges(user).length > 0)}
							<details class="admin-person-badges">
								<summary aria-label={`Manage badges for ${user.username}`}>Badges{#if heldBadges(user).length > 0}<span class="admin-badge-count">{heldBadges(user).length}</span>{/if}</summary>
								<div class="admin-badge-control">
								{#each heldBadges(user) as badge (badge.id)}
									<button
										class="admin-person-action admin-badge-chip"
										type="button"
										aria-label={`Remove ${badge.label} badge from ${user.username}`}
										disabled={!badgeControlsOnline || badgeMutationState.pending !== null}
										onclick={() => onRemoveBadge?.(user, badge.id)}
									>
										<span class="admin-badge-chip-icon">{badge.icon}</span>
										{badge.label}
										<span class="admin-badge-chip-x" aria-hidden="true">×</span>
									</button>
								{/each}
								{#if unheldBadges(user).length > 0}
									<select
										class="admin-select admin-badge-select"
										aria-label={`Add badge for ${user.username}`}
										disabled={!badgeControlsOnline || badgeMutationState.pending !== null}
										value=""
										onchange={(event) => {
													const value = (event.currentTarget as HTMLSelectElement).value;
													if (value) onAssignBadge?.(user, value);
													(event.currentTarget as HTMLSelectElement).value = '';
												}}
									>
										<option value="">Add a badge…</option>
										{#each unheldBadges(user) as badge (badge.id)}
											<option value={badge.id}>{badge.icon} {badge.label}</option>
										{/each}
									</select>
								{/if}
								</div>
							</details>
						{/if}
					{/if}
				</div>
			</div>
		{:else}
			<div class="admin-empty">{$_('admin.empty.search')}</div>
		{/each}
	</div>
</section>

<style>
	.admin-people { display: grid; gap: 1rem; min-width: 0; }
	.admin-badge-feedback, .admin-badge-pending, .admin-badge-status { margin: 0; color: var(--text-secondary); font-size: 0.875rem; line-height: 1.6; overflow-wrap: anywhere; }
	.admin-badge-feedback { padding: 0.75rem 1rem; color: color-mix(in srgb, var(--text-primary) 70%, var(--text-danger)); background: var(--accent-danger-soft); border-inline-start: 3px solid var(--text-danger); border-radius: var(--radius-md); }
	.admin-people .admin-search { width: 100%; min-height: 44px; padding: 0.65rem 0.85rem; font: inherit; font-size: 1rem; }
	.admin-people .admin-user-list { display: grid; gap: 0.75rem; min-width: 0; }
	.admin-people .admin-user-item { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; min-width: 0; padding: 1rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-raised); }
	.admin-people .admin-user-meta { display: flex; flex-wrap: wrap; align-items: center; flex: 1 1 12rem; gap: 0.5rem; min-width: 0; }
	.admin-people .admin-user-name { max-width: 100%; font-size: 0.95rem; line-height: 1.5; overflow-wrap: anywhere; }
	.admin-people .admin-payment-block-badge { height: auto; padding: 0.2rem 0.45rem; font-size: 0.75rem; line-height: 1.4; }
	.admin-people .admin-actions { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 0.625rem; min-width: 0; }
	.admin-people .admin-person-action { display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; min-width: 44px; min-height: 44px; height: auto; padding: 0.55rem 0.7rem; background: var(--surface-raised); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-md); font: inherit; font-size: 0.875rem; line-height: 1.4; cursor: pointer; white-space: normal; }
	.admin-people .admin-person-action:not(:disabled):hover { background: var(--surface-hover); }
	.admin-people .admin-person-action:disabled { opacity: 0.5; cursor: not-allowed; }
	.admin-message-action svg { flex: 0 0 18px; }
	.admin-people .admin-role-control { display: flex; flex-direction: row; align-items: center; gap: 0.5rem; margin: 0; color: var(--text-secondary); font-size: 0.875rem; }
	.admin-people .admin-select { min-height: 44px; height: auto; max-width: 100%; padding: 0.55rem 0.65rem; background: var(--surface-sunken); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-md); font: inherit; font-size: 0.875rem; line-height: 1.4; }
	.admin-people .admin-select:disabled { opacity: 0.65; cursor: not-allowed; }
	.admin-person-status { color: var(--text-secondary); font-size: 0.875rem; line-height: 1.5; }
	.admin-person-badges { width: 100%; min-width: 0; }
	.admin-person-badges summary { width: fit-content; min-height: 44px; padding: 0.65rem 0.25rem; box-sizing: border-box; color: var(--text-secondary); font-size: 0.875rem; line-height: 1.5; cursor: pointer; }
	.admin-person-badges summary:hover { color: var(--text-primary); }
	.admin-badge-count { margin-inline-start: 0.5rem; font-variant-numeric: tabular-nums; }
	.admin-people .admin-badge-control { display: flex; flex-wrap: wrap; gap: 0.5rem; padding-top: 0.25rem; min-width: 0; }
	.admin-people .admin-badge-chip { background: var(--surface-sunken); }
	.admin-people :is(button, input, select, summary):focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: 3px; }
	@media (max-width: 600px) { .admin-people .admin-user-meta, .admin-people .admin-actions { width: 100%; flex-basis: 100%; } }
</style>
