<script lang="ts">
	import { onMount } from 'svelte';
import { get } from 'svelte/store';
	import { channels, currentUser, assignRole, removeUserRole, type User, updateChannelSettings, sendMessage, channelMessages, connected } from '$lib/socket';
	import { users } from '$lib/socket';
	import { getSocket } from '$lib/socket';
	import { getWabiDB } from '$lib/wabidb';
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
	import RoleGatePanel from './admin/RoleGatePanel.svelte';
	import EmojiRoleRulesPanel from './admin/EmojiRoleRulesPanel.svelte';
	import PaymentAccessPanel from './admin/PaymentAccessPanel.svelte';
	import CompressionPanel from './admin/CompressionPanel.svelte';
	import RuntimeTuningPanel from './admin/RuntimeTuningPanel.svelte';
	import FrontendMetadataPanel from './admin/FrontendMetadataPanel.svelte';
	import AdminUserList from './admin/AdminUserList.svelte';
	import ServerPolicyPanel from './admin/ServerPolicyPanel.svelte';

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

	type RoleDefinition = {
		roleName: string;
		displayName: string;
		priority: number;
		color: string | null;
		isHoisted: boolean;
	};

	type EmojiRoleRule = {
		id: number;
		channelId: string;
		messageId: string;
		emojiId: string;
		roleName: string;
		removeOnUnreact: boolean;
		enabled: boolean;
	};

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
	let roleDefinitions: RoleDefinition[] = [];
	let roleLabelDrafts: Record<string, string> = {};
	let emojiRoleRules: EmojiRoleRule[] = [];
	let roleGateChannelId = '';
	let roleGateTitle = '';
	let roleGateDescription = '';
	let roleGatePersist = true;
	let selectedRuleChannelId = '';
	let selectedRuleMessageId = '';
	let selectedRuleEmojiId = '';
	let selectedRuleRoleName = '';
	let selectedRuleRemoveOnUnreact = false;
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
	$: channelRoleOptions = roleDefinitions.filter((role) => role.roleName !== 'owner');
	$: assignableRoleOptions = roleDefinitions.filter((role) => !['owner', 'guest'].includes(role.roleName));
	$: manageableUserRoleOptions = (roleDefinitions.filter((role) =>
		['member', 'mod', 'admin'].includes(role.roleName)
	).map((role) => role.roleName) as ManagedUserRole[]).length > 0
		? (roleDefinitions
				.filter((role) => ['member', 'mod', 'admin'].includes(role.roleName))
				.map((role) => role.roleName) as ManagedUserRole[])
		: (['member', 'mod', 'admin'] as ManagedUserRole[]);
	$: customChannels = $channels.filter((ch) => ch.type === 'text' || ch.type === 'voice' || ch.type === 'public');
	$: gateChannels = customChannels.filter((ch) => ch.type === 'text' || ch.type === 'public');
	$: if (!roleGateChannelId && gateChannels.length > 0) roleGateChannelId = gateChannels[0].id;
	$: if (!selectedRuleChannelId && gateChannels.length > 0) selectedRuleChannelId = gateChannels[0].id;
	$: availableRoleGatePosts = (($channelMessages[selectedRuleChannelId] || [])
		.filter((message) => message.type === 'role_gate')
		.slice(-40)
		.reverse());
	$: if (!selectedRuleMessageId && availableRoleGatePosts.length > 0) {
		selectedRuleMessageId = availableRoleGatePosts[0].id;
	}
	$: if (selectedRuleMessageId && !availableRoleGatePosts.some((message) => message.id === selectedRuleMessageId)) {
		selectedRuleMessageId = availableRoleGatePosts[0]?.id || '';
	}
	$: visibleUsers = $users.filter((u) => {
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

	$: ownerCount = $users.filter((u) => u.highestRole === 'owner').length;
	$: adminCount = $users.filter((u) => u.highestRole === 'admin').length;
	$: modCount = $users.filter((u) => u.highestRole === 'mod').length;
	$: guestCount = $users.filter((u) => !u.dbUserId).length;
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
		if (!user.dbUserId) return false;
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

	function setUserRoleLevel(user: User, nextRole: ManagedUserRole) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;
		const currentRole = getManagedUserRole(user);
		if (currentRole === nextRole) return;
		removeUserRole(user.dbUserId, 'admin');
		removeUserRole(user.dbUserId, 'mod');
		if (nextRole === 'admin' || nextRole === 'mod') {
			assignRole(user.dbUserId, nextRole);
		}
	}

	function refreshRoleDrafts() {
		const next: Record<string, string> = {};
		for (const role of roleDefinitions) {
			next[role.roleName] = role.displayName;
		}
		roleLabelDrafts = next;
	}

	function saveRoleDisplayName(roleName: string) {
		const sock = getSocket();
		const draft = (roleLabelDrafts[roleName] || '').trim();
		if (!sock || !draft) return;
		sock.emit('set-role-display-name', { roleName, displayName: draft });
	}

	function setChannelMinRole(channelId: string, roleName: string) {
		if (!canManageRoles) return;
		updateChannelSettings(channelId, { minRole: roleName });
	}

	function addEmojiRoleRule() {
		const sock = getSocket();
		if (!sock || !canManageRoles) return;
		if (!selectedRuleChannelId || !selectedRuleMessageId || !selectedRuleEmojiId || !selectedRuleRoleName) return;
		sock.emit('set-emoji-role-rule', {
			channelId: selectedRuleChannelId,
			messageId: selectedRuleMessageId,
			emojiId: selectedRuleEmojiId,
			roleName: selectedRuleRoleName,
			removeOnUnreact: selectedRuleRemoveOnUnreact
		});
	}

	async function createRoleGatePost() {
		if (!canManageRoles) return;
		if (!roleGateChannelId) return;
		const title = roleGateTitle.trim();
		const description = roleGateDescription.trim();
		if (!title) return;
		const content = description ? `${title}\n${description}` : title;
		await sendMessage(roleGateChannelId, content, 'role_gate', { roleGatePersist: roleGatePersist });
		roleGateTitle = '';
		roleGateDescription = '';
		selectedRuleChannelId = roleGateChannelId;
	}

	function getChannelName(channelId: string): string {
		return $channels.find((channel) => channel.id === channelId)?.name || channelId;
	}

	async function deleteEmojiRoleRule(ruleId: number) {
		const sock = getSocket();
		if (!sock || !canManageRoles) return;
		const db = getWabiDB();
		const online = get(connected);
		if (db && !online) {
			await db.enqueue({ scopeId: 'corechat', type: 'delete-emoji-role-rule', payload: { ruleId } });
			return;
		}
		sock.emit('delete-emoji-role-rule', { ruleId });
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
		const sock = getSocket();
		if (!sock) return;
		const onRoleDefs = (data: { roles: RoleDefinition[] }) => {
			roleDefinitions = data.roles || [];
			refreshRoleDrafts();
			if (!selectedRuleRoleName && roleDefinitions.length > 0) {
				selectedRuleRoleName = roleDefinitions.find((r) => r.roleName === 'member')?.roleName || roleDefinitions[0].roleName;
			}
		};
		const onEmojiRules = (data: { rules: EmojiRoleRule[] }) => {
			emojiRoleRules = data.rules || [];
		};
		sock.on('role-definitions-updated', onRoleDefs);
		sock.on('emoji-role-rules-updated', onEmojiRules);
		sock.emit('get-role-definitions');
		sock.emit('get-emoji-role-rules');
		return () => {
			sock.off('role-definitions-updated', onRoleDefs);
			sock.off('emoji-role-rules-updated', onEmojiRules);
		};
	});
</script>

{#if section === 'all'}
	<div class="admin-tab">
		<AdminHeader
			currentUserHighestRole={$currentUser?.highestRole}
			{canManageRoles}
			{canModerate}
			usersLength={$users.length}
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
				{roleLabelDrafts}
				{canManageRoles}
				onDraftChange={(name, val) => roleLabelDrafts[name] = val}
				onSave={saveRoleDisplayName}
			/>

			<ChannelAccessPanel
				customChannels={customChannels as any}
				channelRoleOptions={channelRoleOptions}
				{canManageRoles}
				{getRoleLabel}
				onChannelMinRoleChange={setChannelMinRole}
			/>

			<RoleGatePanel
				{canManageRoles}
				{roleGateChannelId}
				{roleGateTitle}
				{roleGateDescription}
				{roleGatePersist}
				gateChannels={gateChannels as any}
				onChannelChange={(id) => roleGateChannelId = id}
				onTitleInput={(v) => roleGateTitle = v}
				onDescriptionInput={(v) => roleGateDescription = v}
				onPersistChange={(v) => roleGatePersist = v}
				onCreatePost={createRoleGatePost}
			/>

			<EmojiRoleRulesPanel
				{canManageRoles}
				{emojiRoleRules}
				{selectedRuleChannelId}
				{selectedRuleMessageId}
				{selectedRuleEmojiId}
				{selectedRuleRoleName}
				{selectedRuleRemoveOnUnreact}
				gateChannels={gateChannels as any}
				{availableRoleGatePosts}
				assignableRoleOptions={assignableRoleOptions}
				{getRoleLabel}
				{getChannelName}
				onRuleChannelChange={(id) => selectedRuleChannelId = id}
				onRuleMessageChange={(id) => selectedRuleMessageId = id}
				onRuleEmojiChange={(id) => selectedRuleEmojiId = id}
				onRuleRoleChange={(name) => selectedRuleRoleName = name}
				onRuleRemoveOnUnreactChange={(v) => selectedRuleRemoveOnUnreact = v}
				onAddRule={addEmojiRoleRule}
				onDeleteRule={deleteEmojiRoleRule}
			/>

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

	<AdminUserList
			{sortedUsers}
			{searchQuery}
			{canManageRoles}
			{canManageTargetUser}
			{getRoleLabel}
			{getManagedUserRole}
			{manageableUserRoleOptions}
			{isUserPaymentBlocked}
			{paymentBlockBusyUserId}
			onSearchInput={(v) => searchQuery = v}
			onMessage={handleMessage}
			onUserRoleChange={setUserRoleLevel}
			onTogglePaymentBlock={toggleUserPaymentBlock}
		/>
	</div>
{:else if section === 'users'}
	<AdminUserList
		{sortedUsers}
		{searchQuery}
		{canManageRoles}
		{canManageTargetUser}
		{getRoleLabel}
		{getManagedUserRole}
		{manageableUserRoleOptions}
		{isUserPaymentBlocked}
		{paymentBlockBusyUserId}
		onSearchInput={(v) => searchQuery = v}
		onMessage={handleMessage}
		onUserRoleChange={setUserRoleLevel}
		onTogglePaymentBlock={toggleUserPaymentBlock}
	/>
{:else if section === 'roles'}
	{#if canManageRoles}
		<RoleNamesPanel
			{roleDefinitions}
			{roleLabelDrafts}
			{canManageRoles}
			onDraftChange={(name, val) => roleLabelDrafts[name] = val}
			onSave={saveRoleDisplayName}
		/>
	{/if}
{:else if section === 'channels'}
	{#if canManageRoles}
		<ChannelAccessPanel
			customChannels={customChannels as any}
			channelRoleOptions={channelRoleOptions}
			{canManageRoles}
			{getRoleLabel}
			onChannelMinRoleChange={setChannelMinRole}
		/>
	{/if}
{:else if section === 'gates'}
	{#if canManageRoles}
		<RoleGatePanel
			{canManageRoles}
			{roleGateChannelId}
			{roleGateTitle}
			{roleGateDescription}
			{roleGatePersist}
			gateChannels={gateChannels as any}
			onChannelChange={(id) => roleGateChannelId = id}
			onTitleInput={(v) => roleGateTitle = v}
			onDescriptionInput={(v) => roleGateDescription = v}
			onPersistChange={(v) => roleGatePersist = v}
			onCreatePost={createRoleGatePost}
		/>

		<EmojiRoleRulesPanel
			{canManageRoles}
			{emojiRoleRules}
			{selectedRuleChannelId}
			{selectedRuleMessageId}
			{selectedRuleEmojiId}
			{selectedRuleRoleName}
			{selectedRuleRemoveOnUnreact}
			gateChannels={gateChannels as any}
			{availableRoleGatePosts}
			assignableRoleOptions={assignableRoleOptions}
			{getRoleLabel}
			{getChannelName}
			onRuleChannelChange={(id) => selectedRuleChannelId = id}
			onRuleMessageChange={(id) => selectedRuleMessageId = id}
			onRuleEmojiChange={(id) => selectedRuleEmojiId = id}
			onRuleRoleChange={(name) => selectedRuleRoleName = name}
			onRuleRemoveOnUnreactChange={(v) => selectedRuleRemoveOnUnreact = v}
			onAddRule={addEmojiRoleRule}
			onDeleteRule={deleteEmojiRoleRule}
		/>
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
