<script lang="ts">
	import { onMount } from 'svelte';
	import { channels, currentUser, assignRole, badgeCatalog, assignBadge as emitAssignBadge, removeBadge as emitRemoveBadge, type User, connected } from '$lib/socket';
	import { createAdminRoleCatalog, type AdminRoleDefinition } from '$lib/adminRoleCatalog';
	import { users, serverMembers } from '$lib/socket';
	import { getSocket } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { getAuthToken } from '$lib/authSession';
	import { refreshSavedServer, currentSavedServer } from '$lib/savedServers';
	import { getServerUrl, resolveServerUrl } from '$lib/serverUrl';
	import {
		clearAdminPaymentUserBlock,
		getAdminPaymentAccessPolicy,
		getAdminFrontendAppMetadataPolicy,
		getAdminPolicy,
		getAdminPaymentUserBlocks,
		getAdminCompressionConfig,
		getAdminCompressionMetrics,
		getAdminRuntimeGuardrails,
		resetAdminCompressionMetrics,
		saveAdminPaymentAccessPolicy,
		saveAdminFrontendAppMetadataPolicy,
		setAdminPaymentUserBlock,
		saveAdminPolicy,
		type AdminCompressionConfig,
		type AdminCompressionMetrics,
		type FrontendAppMetadataPolicy,
		type AdminRuntimeGuardrailsResponse,
		type PaymentAccessPolicy,
		type PaymentUserBlock,
		type RuntimeTuningConfig
	} from '$lib/api';
	import AdminHeader from './admin/AdminHeader.svelte';
	import RoleNamesPanel from './admin/RoleNamesPanel.svelte';
	import ChannelAccessPanel from './admin/ChannelAccessPanel.svelte';
	import RoleGatesUnavailable from './admin/RoleGatesUnavailable.svelte';
	import PaymentAccessPanel from './admin/PaymentAccessPanel.svelte';
	import CompressionPanel from './admin/CompressionPanel.svelte';
	import RuntimeTuningPanel from './admin/RuntimeTuningPanel.svelte';
	import FrontendMetadataPanel from './admin/FrontendMetadataPanel.svelte';
	import AdminUserList from './admin/AdminUserList.svelte';
	import ServerPolicyPanel from './admin/ServerPolicyPanel.svelte';
	import TailcatPanel from './admin/TailcatPanel.svelte';
	import TailcatCallout from './admin/TailcatCallout.svelte';

	export let section:
		| 'all'
		| 'users'
		| 'roles'
		| 'channels'
		| 'gates'
		| 'payments'
		| 'runtime'
		| 'branding'
		| 'settings' = 'all';

	type ManagedUserRole = 'member' | 'mod' | 'admin';

	function createEmptyFrontendAppMetadata(): FrontendAppMetadataPolicy {
		return {
			displayName: null,
			iconUrl: null,
			bannerUrl: null,
			accentColor: null,
			description: null,
			tagline: null,
			launchPageFallbackEnabled: true
		};
	}

	function cloneFrontendAppMetadata(metadata: FrontendAppMetadataPolicy): FrontendAppMetadataPolicy {
		return { ...metadata };
	}

	function resolveFrontendMetadataAssetUrl(assetUrl: string | null | undefined): string | null {
		if (!assetUrl) return null;
		const trimmed = assetUrl.trim();
		if (!trimmed) return null;
		try {
			return new URL(trimmed, getServerUrl()).toString();
		} catch {
			return trimmed;
		}
	}

	let searchQuery = '';
	let roleBusyUserIds: number[] = [];
	let roleActionError = '';
	let roleActionStatus = '';
	let roleDefinitions: AdminRoleDefinition[] = [];
	let rolesLoading = true;
	let rolesError = '';
	const roleCatalog = createAdminRoleCatalog((state) => {
		roleDefinitions = state.roles;
		rolesLoading = state.loading;
		rolesError = state.error;
	});
	let compressionConfig: AdminCompressionConfig | null = null;
	let compressionMetrics: AdminCompressionMetrics | null = null;
	let compressionLoading = false;
	let compressionLoaded = false;
	let compressionAttempted = false;
	let compressionError = '';
	let runtimePanel: AdminRuntimeGuardrailsResponse | null = null;
	let runtimeTuningDraft: RuntimeTuningConfig = {
		applyOnRestart: true,
		threadPoolSize: null,
		heavyProfilingEnabled: false,
		heavyProfilingSampleRate: 0.1
	};
	let runtimeLoading = false;
	let runtimeSaving = false;
	let runtimeLoaded = false;
	let runtimeAttempted = false;
	let runtimeError = '';
	let runtimeSaveStatus = '';
	let paymentPolicy: PaymentAccessPolicy = {
		enabled: false,
		allowGuest: false,
		allowedRoleNames: ['owner', 'admin', 'mod', 'member']
	};
	let frontendAppMetadata: FrontendAppMetadataPolicy = createEmptyFrontendAppMetadata();
	let publishedFrontendAppMetadata: FrontendAppMetadataPolicy = createEmptyFrontendAppMetadata();
	let frontendMetadataLoading = false;
	let frontendMetadataLoaded = false;
	let frontendMetadataAttempted = false;
	let frontendMetadataSaving = false;
	let frontendMetadataError = '';
	let frontendMetadataSaveStatus = '';
	let frontendMetadataUploadTarget: 'icon' | 'banner' | null = null;
	let paymentPolicyLoading = false;
	let paymentPolicyLoaded = false;
	let paymentPolicyAttempted = false;
	let paymentPolicySaving = false;
	let paymentPolicyError = '';
	let paymentPolicySaveStatus = '';
	let paymentUserBlocks: PaymentUserBlock[] = [];
	let paymentBlockBusyUserId: number | null = null;
	let paymentBlockedUserIds = new Set<number>();
	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};

	$: canManageRoles = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: canModerate = canManageRoles || $currentUser?.highestRole === 'mod';
	$: manageableUserRoleOptions = (roleDefinitions.filter((role) =>
		['member', 'mod', 'admin'].includes(role.roleName)
	).map((role) => role.roleName) as ManagedUserRole[]).length > 0
		? (roleDefinitions
				.filter((role) => ['member', 'mod', 'admin'].includes(role.roleName))
				.map((role) => role.roleName) as ManagedUserRole[])
		: (['member', 'mod', 'admin'] as ManagedUserRole[]);
	$: customChannels = $channels.filter((ch) => ch.type === 'text' || ch.type === 'voice' || ch.type === 'public');
	// Full server roster: every registered user (serverMembers) merged with the
	// live online list (users). Online entries win so their live status/fields
	// are kept. Without serverMembers the admin registry only ever showed users
	// currently connected — offline registered accounts were invisible.
	$: rosterUsers = (() => {
		const byId = new Map<string, User>();
		for (const u of $serverMembers) byId.set(String(u.dbUserId ?? u.id), u);
		for (const u of $users) byId.set(String(u.dbUserId ?? u.id), u); // online wins
		return [...byId.values()];
	})();

	$: visibleUsers = rosterUsers.filter((u) => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return true;
		return u.username.toLowerCase().includes(q) || (u.handle || '').toLowerCase().includes(q);
	});
	$: sortedUsers = [...visibleUsers].sort((a, b) => {
		const aPriority = getRolePriority(a.highestRole);
		const bPriority = getRolePriority(b.highestRole);
		if (aPriority !== bPriority) return bPriority - aPriority;
		return a.username.localeCompare(b.username);
	});

	$: ownerCount = rosterUsers.filter((u) => u.highestRole === 'owner').length;
	$: adminCount = rosterUsers.filter((u) => u.highestRole === 'admin').length;
	$: modCount = rosterUsers.filter((u) => u.highestRole === 'mod').length;
	$: guestCount = rosterUsers.filter((u) => !u.dbUserId || u.isRegistered === false).length;
	$: if (canManageRoles && !compressionLoaded && !compressionLoading && !compressionAttempted) {
		void refreshCompressionPanel();
	}
	$: if (canManageRoles && !runtimeLoaded && !runtimeLoading && !runtimeAttempted) {
		void refreshRuntimePanel();
	}
	$: if (canManageRoles && !frontendMetadataLoaded && !frontendMetadataLoading && !frontendMetadataAttempted) {
		void refreshFrontendMetadata();
	}
	$: if (canManageRoles && !paymentPolicyLoaded && !paymentPolicyLoading && !paymentPolicyAttempted) {
		void refreshPaymentControls();
	}
	$: paymentBlockedUserIds = new Set(paymentUserBlocks.map((block) => block.userId));
	$: frontendMetadataDirty = !frontendMetadataMatches(
		frontendAppMetadata,
		publishedFrontendAppMetadata
	);

	function getRolePriority(roleName?: string): number {
		if (!roleName) return 0;
		const found = roleDefinitions.find((r) => r.roleName === roleName);
		return found?.priority ?? 0;
	}

	function getRoleLabel(roleName?: string): string {
		if (!roleName) return fallbackRoleLabels.member;
		const found = roleDefinitions.find((r) => r.roleName === roleName);
		return found?.displayName || fallbackRoleLabels[roleName] || roleName;
	}

	function userHasRole(user: User, role: string): boolean {
		return user.highestRole === role || (user.roles || []).includes(role);
	}

	function canManageTargetUser(user: User): boolean {
		if (!canManageRoles) return false;
		if (!$currentUser || user.id === $currentUser.id) return false;
		if (!user.dbUserId || user.isRegistered === false) return false;
		if (user.highestRole === 'owner') return false;
		return true;
	}

	function isCurrentUserEntry(user: User): boolean {
		if (!$currentUser) return false;
		if (user.id === $currentUser.id) return true;
		if (user.dbUserId && $currentUser.dbUserId && user.dbUserId === $currentUser.dbUserId) return true;
		return false;
	}

	function handleMessage(user: User) {
		if (isCurrentUserEntry(user)) {
			layoutStore.openNotes();
			return;
		}
		undefined;
		layoutStore.showDMsTab();
	}

	function getManagedUserRole(user: User): ManagedUserRole {
		if (userHasRole(user, 'admin')) return 'admin';
		if (userHasRole(user, 'mod')) return 'mod';
		return 'member';
	}

	async function setUserRoleLevel(user: User, nextRole: ManagedUserRole) {
		if (!canManageTargetUser(user) || !user.dbUserId || roleBusyUserIds.includes(user.dbUserId)) return;
		const currentRole = getManagedUserRole(user);
		if (currentRole === nextRole) return;
		// The server uses one authoritative role, so replacing it is one command.
		// Multiple concurrent remove/assign emits can apply in the wrong order.
		const userId = user.dbUserId;
		roleBusyUserIds = [...roleBusyUserIds, userId];
		roleActionError = ''; roleActionStatus = '';
		try {
			await assignRole(userId, nextRole);
			roleActionStatus = `${user.username} is now ${getRoleLabel(nextRole)}.`;
		} catch (error) {
			roleActionError = error instanceof Error ? error.message : 'Could not change this member’s role.';
		} finally {
			roleBusyUserIds = roleBusyUserIds.filter((id) => id !== userId);
		}
	}

	function handleAssignBadge(user: User, badgeId: string) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;
		emitAssignBadge(user.dbUserId, badgeId);
	}

	function handleRemoveBadge(user: User, badgeId: string) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;
		emitRemoveBadge(user.dbUserId, badgeId);
	}

	async function refreshCompressionPanel() {
		const token = getAuthToken();
		if (!token) return;
		compressionAttempted = true;
		compressionLoading = true;
		compressionError = '';
		try {
			const [config, metrics] = await Promise.all([
				getAdminCompressionConfig(token),
				getAdminCompressionMetrics(token)
			]);
			compressionConfig = config;
			compressionMetrics = metrics;
			compressionLoaded = true;
		} catch (error) {
			compressionError = (error as Error).message || 'Failed to load compression panel';
		} finally {
			compressionLoading = false;
		}
	}

	async function resetCompressionPanelMetrics() {
		const token = getAuthToken();
		if (!token) return;
		compressionLoading = true;
		compressionError = '';
		try {
			await resetAdminCompressionMetrics(token);
			await refreshCompressionPanel();
		} catch (error) {
			compressionError = (error as Error).message || 'Failed to reset compression metrics';
			compressionLoading = false;
		}
	}

	async function refreshRuntimePanel() {
		const token = getAuthToken();
		if (!token) return;
		runtimeAttempted = true;
		runtimeLoading = true;
		runtimeError = '';
		try {
			const [policy, guardrails] = await Promise.all([
				getAdminPolicy<RuntimeTuningConfig>(token, 'runtime_tuning'),
				getAdminRuntimeGuardrails(token)
			]);
			runtimeTuningDraft = { ...policy.config };
			runtimePanel = guardrails;
			runtimeLoaded = true;
		} catch (error) {
			runtimeError = (error as Error).message || 'Failed to load runtime settings';
		} finally {
			runtimeLoading = false;
		}
	}

	async function saveRuntimeTuning() {
		const token = getAuthToken();
		if (!token) return;
		runtimeSaving = true;
		runtimeSaveStatus = '';
		runtimeError = '';
		try {
			const saved = await saveAdminPolicy<RuntimeTuningConfig>(token, 'runtime_tuning', runtimeTuningDraft);
			runtimeTuningDraft = { ...saved };
			runtimeSaveStatus = 'Saved. Restart required to apply.';
			await refreshRuntimePanel();
		} catch (error) {
			runtimeError = (error as Error).message || 'Failed to save runtime settings';
		} finally {
			runtimeSaving = false;
		}
	}

	async function refreshFrontendMetadata() {
		const token = getAuthToken();
		if (!token) return;
		frontendMetadataAttempted = true;
		frontendMetadataLoading = true;
		frontendMetadataError = '';
		try {
			const loadedMetadata = await getAdminFrontendAppMetadataPolicy(token);
			frontendAppMetadata = cloneFrontendAppMetadata(loadedMetadata);
			publishedFrontendAppMetadata = cloneFrontendAppMetadata(loadedMetadata);
			frontendMetadataLoaded = true;
		} catch (error) {
			frontendMetadataError = (error as Error).message || 'Failed to load frontend app metadata';
		} finally {
			frontendMetadataLoading = false;
		}
	}

	async function saveFrontendMetadata() {
		const token = getAuthToken();
		if (!token) return;
		frontendMetadataSaving = true;
		frontendMetadataError = '';
		frontendMetadataSaveStatus = '';
		try {
			const savedMetadata = await saveAdminFrontendAppMetadataPolicy(token, frontendAppMetadata);
			frontendAppMetadata = cloneFrontendAppMetadata(savedMetadata);
			publishedFrontendAppMetadata = cloneFrontendAppMetadata(savedMetadata);
			frontendMetadataSaveStatus = 'Published frontend app metadata to the live shell.';
			refreshSavedServer(resolveServerUrl().url);
		} catch (error) {
			frontendMetadataError = (error as Error).message || 'Failed to save frontend app metadata';
		} finally {
			frontendMetadataSaving = false;
		}
	}

	function validateFrontendMetadataImage(file: File): string | null {
		const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
		if (!allowedTypes.includes(file.type)) {
			return 'Use PNG, JPG, GIF, or WEBP.';
		}
		if (file.size > 10 * 1024 * 1024) {
			return 'Image must be 10 MB or smaller.';
		}
		return null;
	}

	async function uploadFrontendMetadataAsset(target: 'icon' | 'banner', event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const token = getAuthToken();
		if (!token) {
			frontendMetadataError = 'Authentication required to upload branding assets.';
			input.value = '';
			return;
		}
		const validationError = validateFrontendMetadataImage(file);
		if (validationError) {
			frontendMetadataError = validationError;
			input.value = '';
			return;
		}
		frontendMetadataUploadTarget = target;
		frontendMetadataError = '';
		frontendMetadataSaveStatus = '';
		try {
			const formData = new FormData();
			formData.append('file', file);
			const response = await fetch(`${getServerUrl()}/api/upload`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: formData
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload?.fileUrl) {
				throw new Error(payload?.error || `Failed to upload ${target}.`);
			}
			if (target === 'icon') {
				frontendAppMetadata = { ...frontendAppMetadata, iconUrl: String(payload.fileUrl) };
			} else {
				frontendAppMetadata = { ...frontendAppMetadata, bannerUrl: String(payload.fileUrl) };
			}
			frontendMetadataSaveStatus = `${target === 'icon' ? 'Icon' : 'Banner'} uploaded to the draft. Save to publish it in the app shell.`;
		} catch (error) {
			frontendMetadataError = (error as Error).message || `Failed to upload ${target}.`;
		} finally {
			frontendMetadataUploadTarget = null;
			input.value = '';
		}
	}

	function discardFrontendMetadataDraft(): void {
		frontendAppMetadata = cloneFrontendAppMetadata(publishedFrontendAppMetadata);
		frontendMetadataError = '';
		frontendMetadataSaveStatus = 'Discarded draft changes.';
	}

	function setRolePaymentAllowed(roleName: string, enabled: boolean) {
		const current = new Set(paymentPolicy.allowedRoleNames.map((role) => role.toLowerCase()));
		if (enabled) current.add(roleName.toLowerCase());
		else current.delete(roleName.toLowerCase());
		paymentPolicy = { ...paymentPolicy, allowedRoleNames: [...current] };
	}

	function isUserPaymentBlocked(user: User): boolean {
		if (!user.dbUserId) return false;
		return paymentBlockedUserIds.has(user.dbUserId);
	}

	async function refreshPaymentControls() {
		const token = getAuthToken();
		if (!token) return;
		paymentPolicyAttempted = true;
		paymentPolicyLoading = true;
		paymentPolicyError = '';
		paymentPolicySaveStatus = '';
		try {
			const [policy, blocks] = await Promise.all([
				getAdminPaymentAccessPolicy(token),
				getAdminPaymentUserBlocks(token)
			]);
			paymentPolicy = {
				...policy,
				allowedRoleNames: Array.isArray(policy.allowedRoleNames)
					? policy.allowedRoleNames.map((role) => role.toLowerCase())
					: []
			};
			paymentUserBlocks = blocks;
			paymentPolicyLoaded = true;
		} catch (error) {
			paymentPolicyError = (error as Error).message || 'Failed to load payment controls';
		} finally {
			paymentPolicyLoading = false;
		}
	}

	async function savePaymentPolicy() {
		const token = getAuthToken();
		if (!token) return;
		paymentPolicySaving = true;
		paymentPolicyError = '';
		paymentPolicySaveStatus = '';
		try {
			const saved = await saveAdminPaymentAccessPolicy(token, paymentPolicy);
			paymentPolicy = {
				...saved,
				allowedRoleNames: Array.isArray(saved.allowedRoleNames)
					? saved.allowedRoleNames.map((role) => role.toLowerCase())
					: []
			};
			paymentPolicySaveStatus = 'Saved payment access policy.';
		} catch (error) {
			paymentPolicyError = (error as Error).message || 'Failed to save payment policy';
		} finally {
			paymentPolicySaving = false;
		}
	}

	async function toggleUserPaymentBlock(user: User) {
		if (!user.dbUserId) return;
		const token = getAuthToken();
		if (!token) return;
		paymentBlockBusyUserId = user.dbUserId;
		paymentPolicyError = '';
		paymentPolicySaveStatus = '';
		try {
			if (isUserPaymentBlocked(user)) {
				await clearAdminPaymentUserBlock(token, user.dbUserId);
				paymentPolicySaveStatus = `Unblocked payments for ${user.username}.`;
			} else {
				await setAdminPaymentUserBlock(token, user.dbUserId, { reason: 'Blocked by admin policy' });
				paymentPolicySaveStatus = `Blocked payments for ${user.username}.`;
			}
			paymentUserBlocks = await getAdminPaymentUserBlocks(token);
		} catch (error) {
			paymentPolicyError = (error as Error).message || 'Failed to update payment block';
		} finally {
			paymentBlockBusyUserId = null;
		}
	}

	function frontendMetadataMatches(left: FrontendAppMetadataPolicy, right: FrontendAppMetadataPolicy): boolean {
		return (
			left.displayName === right.displayName &&
			left.iconUrl === right.iconUrl &&
			left.bannerUrl === right.bannerUrl &&
			left.accentColor === right.accentColor &&
			left.description === right.description &&
			left.tagline === right.tagline &&
			left.launchPageFallbackEnabled === right.launchPageFallbackEnabled
		);
	}

	onMount(() => {
		const unsubscribe = connected.subscribe((online) => {
			roleCatalog.bind(online ? getSocket() : null);
		});
		return () => {
			unsubscribe();
			roleCatalog.dispose();
		};
	});
</script>

{#if section === 'all'}
	<div class="admin-tab">
		<TailcatCallout />
		<AdminHeader
			currentUserHighestRole={$currentUser?.highestRole}
			{canManageRoles}
			{canModerate}
			usersLength={rosterUsers.length}
			{ownerCount}
			{adminCount}
			{modCount}
			{guestCount}
			serverName={$currentSavedServer?.effectiveName || ''}
			serverTagline={$currentSavedServer?.effectiveTagline || ''}
		/>

		{#if canManageRoles}
			<RoleNamesPanel
				{roleDefinitions}
				loading={rolesLoading}
				error={rolesError}
				onRetry={roleCatalog.refresh}
			/>

			<ChannelAccessPanel
				customChannels={customChannels as any}
			/>

			<RoleGatesUnavailable />

			<PaymentAccessPanel
				{paymentPolicy}
				{paymentUserBlocks}
				{paymentPolicyLoading}
				{paymentPolicySaving}
				{paymentPolicyError}
				{paymentPolicySaveStatus}
				roleDefinitions={roleDefinitions}
				{getRoleLabel}
				onPolicyChange={(p) => paymentPolicy = p}
				onRefresh={refreshPaymentControls}
				onSave={savePaymentPolicy}
			/>

			<CompressionPanel
				{compressionConfig}
				{compressionMetrics}
				{compressionLoading}
				{compressionError}
				onRefresh={refreshCompressionPanel}
				onResetMetrics={resetCompressionPanelMetrics}
			/>

			<RuntimeTuningPanel
				{runtimePanel}
				{runtimeTuningDraft}
				{runtimeLoading}
				{runtimeSaving}
				{runtimeError}
				{runtimeSaveStatus}
				onRefresh={refreshRuntimePanel}
				onSave={saveRuntimeTuning}
				onDraftChange={(d) => runtimeTuningDraft = d}
			/>

			<FrontendMetadataPanel
				{frontendAppMetadata}
				{publishedFrontendAppMetadata}
				{frontendMetadataLoading}
				{frontendMetadataSaving}
				{frontendMetadataError}
				{frontendMetadataSaveStatus}
				{frontendMetadataUploadTarget}
				onMetadataChange={(m) => frontendAppMetadata = m}
				onSave={saveFrontendMetadata}
			onDiscard={discardFrontendMetadataDraft}
			onUploadAsset={uploadFrontendMetadataAsset}
			{resolveFrontendMetadataAssetUrl}
		/>
	{/if}

	{#if roleActionError}<p role="alert">{roleActionError}</p>{/if}
	{#if roleActionStatus}<p role="status">{roleActionStatus}</p>{/if}
	<AdminUserList
			{roleBusyUserIds}
			{sortedUsers}
			{searchQuery}
			{canManageRoles}
			{canManageTargetUser}
			{getRoleLabel}
			{getManagedUserRole}
			{manageableUserRoleOptions}
			{isUserPaymentBlocked}
			{paymentBlockBusyUserId}
				badgeCatalog={$badgeCatalog}
			onAssignBadge={handleAssignBadge}
			onRemoveBadge={handleRemoveBadge}
			onSearchInput={(v) => searchQuery = v}
			onMessage={handleMessage}
			onUserRoleChange={setUserRoleLevel}
			onTogglePaymentBlock={toggleUserPaymentBlock}
		/>
	</div>
{:else if section === 'users'}
	{#if roleActionError}<p role="alert">{roleActionError}</p>{/if}
	{#if roleActionStatus}<p role="status">{roleActionStatus}</p>{/if}
	<AdminUserList
		{roleBusyUserIds}
		{sortedUsers}
		{searchQuery}
		{canManageRoles}
		{canManageTargetUser}
		{getRoleLabel}
		{getManagedUserRole}
		{manageableUserRoleOptions}
		{isUserPaymentBlocked}
		{paymentBlockBusyUserId}
		badgeCatalog={$badgeCatalog}
		onAssignBadge={handleAssignBadge}
		onRemoveBadge={handleRemoveBadge}
		onSearchInput={(v) => searchQuery = v}
		onMessage={handleMessage}
		onUserRoleChange={setUserRoleLevel}
		onTogglePaymentBlock={toggleUserPaymentBlock}
	/>
{:else if section === 'roles'}
	{#if canManageRoles}
		<RoleNamesPanel
			{roleDefinitions}
			loading={rolesLoading}
			error={rolesError}
			onRetry={roleCatalog.refresh}
		/>
	{/if}
{:else if section === 'channels'}
	{#if canManageRoles}
		<ChannelAccessPanel
			customChannels={customChannels as any}
		/>
	{/if}
{:else if section === 'gates'}
	{#if canManageRoles}
		<RoleGatesUnavailable />
	{/if}
{:else if section === 'payments'}
	{#if canManageRoles}
		<ServerPolicyPanel canManageAdmin={canManageRoles} />

		<PaymentAccessPanel
			{paymentPolicy}
			{paymentUserBlocks}
			{paymentPolicyLoading}
			{paymentPolicySaving}
			{paymentPolicyError}
			{paymentPolicySaveStatus}
			roleDefinitions={roleDefinitions}
			{getRoleLabel}
			onPolicyChange={(p) => paymentPolicy = p}
			onRefresh={refreshPaymentControls}
			onSave={savePaymentPolicy}
		/>
	{/if}
	{:else if section === 'runtime'}
	{#if canManageRoles}
		<RuntimeTuningPanel
			{runtimePanel}
			{runtimeTuningDraft}
			{runtimeLoading}
			{runtimeSaving}
			{runtimeError}
			{runtimeSaveStatus}
			onRefresh={refreshRuntimePanel}
			onSave={saveRuntimeTuning}
			onDraftChange={(d) => runtimeTuningDraft = d}
		/>

		<CompressionPanel
			{compressionConfig}
			{compressionMetrics}
			{compressionLoading}
			{compressionError}
			onRefresh={refreshCompressionPanel}
			onResetMetrics={resetCompressionPanelMetrics}
		/>

		<TailcatPanel canManageAdmin={canManageRoles} />
	{/if}
	{:else if section === 'branding'}
	{#if canManageRoles}
		<FrontendMetadataPanel
			{frontendAppMetadata}
			{publishedFrontendAppMetadata}
			{frontendMetadataLoading}
			{frontendMetadataSaving}
			{frontendMetadataError}
			{frontendMetadataSaveStatus}
			{frontendMetadataUploadTarget}
			onMetadataChange={(m) => frontendAppMetadata = m}
			onSave={saveFrontendMetadata}
			onDiscard={discardFrontendMetadataDraft}
			onUploadAsset={uploadFrontendMetadataAsset}
			{resolveFrontendMetadataAssetUrl}
		/>
	{/if}
	{:else if section === 'settings'}
	{#if canManageRoles}
		<ServerPolicyPanel canManageAdmin={canManageRoles} />

		<PaymentAccessPanel
			{paymentPolicy}
			{paymentUserBlocks}
			{paymentPolicyLoading}
			{paymentPolicySaving}
			{paymentPolicyError}
			{paymentPolicySaveStatus}
			roleDefinitions={roleDefinitions}
			{getRoleLabel}
			onPolicyChange={(p) => paymentPolicy = p}
			onRefresh={refreshPaymentControls}
			onSave={savePaymentPolicy}
		/>
	{/if}
{/if}
