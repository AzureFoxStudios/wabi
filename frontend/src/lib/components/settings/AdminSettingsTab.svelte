<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import {
		assignRole,
		channels,
		currentUser,
		removeUserRole,
		roleDefinitions,
		users
	} from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import {
		adminClearUserLoginLockout,
		adminResetUserPassword,
		getAdminUploadLimits,
		saveAdminUploadLimits,
		type UploadLimitConfig,
		type UploadRoleTier
	} from '$lib/api';
	import UploadLimitsPanel from './admin/UploadLimitsPanel.svelte';
	import AdminSettingsPayments from './admin/AdminSettingsPayments.svelte';
	import AdminSettingsCommunityNodes from './admin/AdminSettingsCommunityNodes.svelte';
	import AdminUserList from './admin/AdminUserList.svelte';
	import {
		MB,
		bytesToMbInput,
		fallbackRoleLabels,
		isProtectedOwner,
		parseMbInput,
		uploadLimitInputsFromConfig,
		uploadRoleLabels,
		uploadRoleOrder,
		userHasRole
	} from './admin/adminSettingsHelpers';

	const dispatch = createEventDispatcher<{ openServerDonation: void }>();
	let uploadLimitConfig: UploadLimitConfig = {
		perRoleBytes: { new: 10 * MB, trusted: 1024 * MB, moderator: 30 * 1024 * MB, admin: null, owner: null },
		globalUploadCapBytes: null
	};
	let uploadLimitInputs: Record<UploadRoleTier, string> = {
		new: '10',
		trusted: '1024',
		moderator: '30720',
		admin: '',
		owner: ''
	};
	let globalUploadLimitInput = '';
	let loadingUploadLimits = false;
	let savingUploadLimits = false;
	let uploadLimitsLoaded = false;

	$: roleLabelMap = (() => {
		const labels: Record<string, string> = { ...fallbackRoleLabels };
		for (const role of $roleDefinitions) {
			labels[role.roleName] = role.displayName;
		}
		return labels;
	})();
	$: canManageAdmin = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: sortedAdminUsers = [...$users].sort((a, b) => {
		const aPriority = a.highestRole === 'owner' ? 3 : a.highestRole === 'admin' ? 2 : a.highestRole === 'mod' ? 1 : 0;
		const bPriority = b.highestRole === 'owner' ? 3 : b.highestRole === 'admin' ? 2 : b.highestRole === 'mod' ? 1 : 0;
		if (aPriority !== bPriority) return bPriority - aPriority;
		return a.username.localeCompare(b.username);
	});
	$: communityAnnouncementChannelOptions = $channels.filter(
		(channel) => channel.type === 'text' || channel.type === 'public' || channel.type === 'thread_public' || channel.type === 'thread_private'
	);
	$: communityNodeWhitelistCandidates = sortedAdminUsers.filter(
		(user) => typeof user.dbUserId === 'number'
	);
	$: if (canManageAdmin && !uploadLimitsLoaded && !loadingUploadLimits) void loadUploadLimits();

	function openServerDonation(): void {
		dispatch('openServerDonation');
	}

	function syncUploadLimitInputsFromConfig(config: UploadLimitConfig) {
		uploadLimitConfig = config;
		uploadLimitInputs = uploadLimitInputsFromConfig(config);
		globalUploadLimitInput = bytesToMbInput(config.globalUploadCapBytes);
	}

	async function loadUploadLimits() {
		if (!canManageAdmin || loadingUploadLimits) return;
		const token = getAuthToken();
		if (!token) return;
		loadingUploadLimits = true;
		try {
			const { config } = await getAdminUploadLimits(token);
			syncUploadLimitInputsFromConfig(config);
			uploadLimitsLoaded = true;
		} catch (error) {
			console.error('Failed to load upload limits:', error);
		} finally {
			loadingUploadLimits = false;
		}
	}

	async function saveUploadLimits() {
		if (!canManageAdmin || savingUploadLimits) return;
		const token = getAuthToken();
		if (!token) {
			alert('You are not authenticated.');
			return;
		}
		try {
			const nextConfig: UploadLimitConfig = {
				perRoleBytes: {
					new: parseMbInput(uploadLimitInputs.new),
					trusted: parseMbInput(uploadLimitInputs.trusted),
					moderator: parseMbInput(uploadLimitInputs.moderator),
					admin: parseMbInput(uploadLimitInputs.admin),
					owner: parseMbInput(uploadLimitInputs.owner)
				},
				globalUploadCapBytes: parseMbInput(globalUploadLimitInput)
			};
			savingUploadLimits = true;
			const saved = await saveAdminUploadLimits(token, nextConfig);
			syncUploadLimitInputsFromConfig(saved);
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to save upload limits.');
		} finally {
			savingUploadLimits = false;
		}
	}

	function canManageTargetUser(user: { id: string; dbUserId?: number; highestRole?: string }): boolean {
		if (!canManageAdmin) return false;
		if (!user.dbUserId) return false;
		if (!$currentUser || user.id === $currentUser.id) return false;
		if (isProtectedOwner(user)) return false;
		return true;
	}

	function getRoleLabel(roleName?: string): string {
		if (!roleName) return roleLabelMap.member;
		return roleLabelMap[roleName] || roleName;
	}

	function promoteUser(user: { dbUserId?: number }, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		assignRole(user.dbUserId, role);
	}

	function removeRoleFromUser(user: { dbUserId?: number }, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, role);
	}

	function resetUserToMember(user: { dbUserId?: number }) {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, 'admin');
		removeUserRole(user.dbUserId, 'mod');
	}

	async function promptAdminPasswordReset(user: { dbUserId?: number; username: string; id: string; highestRole?: string }) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;
		const newPassword = window.prompt(`Set a new password for ${user.username} (min 8 chars):`);
		if (!newPassword) return;
		if (newPassword.length < 8) {
			alert('Password must be at least 8 characters.');
			return;
		}
		const confirm = window.prompt(`Confirm new password for ${user.username}:`);
		if (confirm !== newPassword) {
			alert('Password confirmation does not match.');
			return;
		}
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const temporaryReset = window.confirm(`Make this a temporary password for ${user.username}? Click OK to require a password change on next login, or Cancel to make it permanent.`);
		try {
			await adminResetUserPassword(token, user.dbUserId, newPassword, temporaryReset);
			alert(temporaryReset ? `Temporary password set for ${user.username}. They will be asked to change it on next login.` : `Password reset for ${user.username}.`);
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to reset password.');
		}
	}

	async function clearUserLoginLockout(user: { dbUserId?: number; username: string; id: string; highestRole?: string }) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		try {
			await adminClearUserLoginLockout(token, user.dbUserId);
			alert(`Cleared login lockout state for ${user.username}.`);
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to clear lockout.');
		}
	}
</script>

<div class="settings-section">
	<h3>{$t('settings.sections.admin_panel')}</h3>
	<p class="admin-help">Manage live user roles from here or from user right-click menus.</p>

	<UploadLimitsPanel
		{canManageAdmin}
		{loadingUploadLimits}
		{savingUploadLimits}
		{uploadRoleOrder}
		{uploadRoleLabels}
		{uploadLimitInputs}
		{globalUploadLimitInput}
		onSave={saveUploadLimits}
	/>

	<AdminSettingsPayments {canManageAdmin} on:openServerDonation={openServerDonation} />

	<AdminSettingsCommunityNodes
		{canManageAdmin}
		communityNodeWhitelistCandidates={communityNodeWhitelistCandidates as any}
		communityAnnouncementChannelOptions={communityAnnouncementChannelOptions as any}
	/>

	<AdminUserList
		{sortedAdminUsers}
		{canManageTargetUser}
		{userHasRole}
		{getRoleLabel}
		onPromoteAdmin={(u) => promoteUser(u, 'admin')}
		onRemoveAdmin={(u) => removeRoleFromUser(u, 'admin')}
		onPromoteMod={(u) => promoteUser(u, 'mod')}
		onRemoveMod={(u) => removeRoleFromUser(u, 'mod')}
		onResetToMember={resetUserToMember}
		onResetPassword={promptAdminPasswordReset}
		onClearLockout={clearUserLoginLockout}
	/>
</div>
