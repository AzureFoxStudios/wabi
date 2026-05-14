<script lang="ts">
	import { onMount } from 'svelte';
	import { channels, currentUser, createDM, assignRole, removeUserRole, type User, updateChannelSettings, sendMessage, channelMessages } from '$lib/socket';
	import { users } from '$lib/socket';
	import { emojis } from '$lib/emoji-store';
	import { getSocket } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { _ } from '$lib/i18n';
	import { getAuthToken } from '$lib/authSession';
	import { refreshSavedServer } from '$lib/savedServers';
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
			launchPageFallbackEnabled: true
		};
	}

	function cloneFrontendAppMetadata(
		metadata: FrontendAppMetadataPolicy
	): FrontendAppMetadataPolicy {
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

	function frontendMetadataMatches(
		left: FrontendAppMetadataPolicy,
		right: FrontendAppMetadataPolicy
	): boolean {
		return (
			left.displayName === right.displayName &&
			left.iconUrl === right.iconUrl &&
			left.bannerUrl === right.bannerUrl &&
			left.accentColor === right.accentColor &&
			left.description === right.description &&
			left.launchPageFallbackEnabled === right.launchPageFallbackEnabled
		);
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
	let frontendIconInput: HTMLInputElement | null = null;
	let frontendBannerInput: HTMLInputElement | null = null;
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
		createDM(user.id);
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

	function deleteEmojiRoleRule(ruleId: number) {
		const sock = getSocket();
		if (!sock || !canManageRoles) return;
		sock.emit('delete-emoji-role-rule', { ruleId });
	}

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	function formatRatio(value: number | null): string {
		if (value == null || !Number.isFinite(value)) return 'n/a';
		return value.toFixed(3);
	}

	function formatNumber(value: number | null, digits = 2): string {
		if (value == null || !Number.isFinite(value)) return 'n/a';
		return Number(value).toFixed(digits);
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

	function triggerFrontendMetadataUpload(target: 'icon' | 'banner'): void {
		if (target === 'icon') {
			frontendIconInput?.click();
			return;
		}
		frontendBannerInput?.click();
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
				headers: {
					Authorization: `Bearer ${token}`
				},
				body: formData
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload?.fileUrl) {
				throw new Error(payload?.error || `Failed to upload ${target}.`);
			}

			if (target === 'icon') {
				frontendAppMetadata = {
					...frontendAppMetadata,
					iconUrl: String(payload.fileUrl)
				};
			} else {
				frontendAppMetadata = {
					...frontendAppMetadata,
					bannerUrl: String(payload.fileUrl)
				};
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
		if (enabled) {
			current.add(roleName.toLowerCase());
		} else {
			current.delete(roleName.toLowerCase());
		}
		paymentPolicy = {
			...paymentPolicy,
			allowedRoleNames: [...current]
		};
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
				await setAdminPaymentUserBlock(token, user.dbUserId, {
					reason: 'Blocked by admin policy'
				});
				paymentPolicySaveStatus = `Blocked payments for ${user.username}.`;
			}
			paymentUserBlocks = await getAdminPaymentUserBlocks(token);
		} catch (error) {
			paymentPolicyError = (error as Error).message || 'Failed to update payment block';
		} finally {
			paymentBlockBusyUserId = null;
		}
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

<div class="admin-tab">
	<div class="admin-header">
		<div class="admin-title-row">
			<h3>{$_('admin.title')}</h3>
			<span class="admin-role-indicator">{$_('admin.you')}: {getRoleLabel($currentUser?.highestRole || 'member')}</span>
		</div>
		<p class="admin-subtitle">
			{#if canManageRoles}
				{$_('admin.subtitle.manage')}
			{:else if canModerate}
				{$_('admin.subtitle.moderate')}
			{:else}
				{$_('admin.subtitle.none')}
			{/if}
		</p>
	</div>

	<div class="admin-stats">
		<div class="admin-stat"><span class="k">{$_('admin.stats.users')}</span><span class="v">{$users.length}</span></div>
		<div class="admin-stat"><span class="k">{$_('admin.stats.owners')}</span><span class="v">{ownerCount}</span></div>
		<div class="admin-stat"><span class="k">{$_('admin.stats.admins')}</span><span class="v">{adminCount}</span></div>
		<div class="admin-stat"><span class="k">{$_('admin.stats.mods')}</span><span class="v">{modCount}</span></div>
		<div class="admin-stat"><span class="k">{$_('admin.stats.guests')}</span><span class="v">{guestCount}</span></div>
	</div>

	{#if canManageRoles}
		<div class="admin-section">
			<h4>{$_('admin.sections.role_names')}</h4>
			<div class="role-list">
				{#each roleDefinitions as role (role.roleName)}
					<div class="role-item">
						<span class="role-key">{role.roleName}</span>
						<input class="role-input" bind:value={roleLabelDrafts[role.roleName]} />
						<button class="admin-btn" on:click={() => saveRoleDisplayName(role.roleName)}>{$_('common.save')}</button>
					</div>
				{/each}
			</div>
		</div>

		<div class="admin-section">
			<h4>{$_('admin.sections.channel_access')}</h4>
			<div class="channel-role-list">
				{#each customChannels as channel (channel.id)}
					<div class="channel-role-item">
						<div class="channel-role-meta">
							<span class="channel-name">#{channel.name}</span>
							<span class="channel-type">{channel.type}</span>
						</div>
						<select
							class="channel-role-select"
							value={channel.minRole || 'guest'}
							on:change={(e) => setChannelMinRole(channel.id, e.currentTarget.value)}
						>
							<option value="guest">{getRoleLabel('guest')}</option>
							{#each channelRoleOptions as role (role.roleName)}
								<option value={role.roleName}>{getRoleLabel(role.roleName)}</option>
							{/each}
						</select>
					</div>
				{/each}
			</div>
		</div>

		<div class="admin-section">
			<h4>{$_('admin.sections.role_gate_posts')}</h4>
			<div class="emoji-rule-create">
				<select bind:value={roleGateChannelId} class="admin-select">
					<option value="" disabled selected>{$_('admin.select.channel')}</option>
					{#each gateChannels as channel (channel.id)}
						<option value={channel.id}>#{channel.name}</option>
					{/each}
				</select>
				<input
					class="role-input"
					placeholder={$_('admin.placeholders.role_gate_title')}
					bind:value={roleGateTitle}
				/>
				<input
					class="role-input"
					placeholder={$_('admin.placeholders.role_gate_description')}
					bind:value={roleGateDescription}
				/>
				<label class="rule-checkbox">
					<input type="checkbox" bind:checked={roleGatePersist} />
					{$_('admin.role_gate.persist')}
				</label>
				<button class="admin-btn" on:click={createRoleGatePost}>{$_('admin.role_gate.create')}</button>
			</div>
			<div class="admin-empty">{$_('admin.role_gate.note')}</div>
		</div>

		<div class="admin-section">
			<h4>{$_('admin.sections.emoji_role_automation')}</h4>
			<div class="emoji-rule-create">
				<select bind:value={selectedRuleChannelId} class="admin-select">
					<option value="" disabled selected>{$_('admin.select.gate_channel')}</option>
					{#each gateChannels as channel (channel.id)}
						<option value={channel.id}>#{channel.name}</option>
					{/each}
				</select>
				<select bind:value={selectedRuleMessageId} class="admin-select">
					<option value="" disabled selected>{$_('admin.select.role_gate_message')}</option>
					{#each availableRoleGatePosts as post (post.id)}
						<option value={post.id}>{post.id.slice(0, 18)}... | {post.text.slice(0, 42)}</option>
					{/each}
				</select>
				<select bind:value={selectedRuleEmojiId} class="admin-select">
					<option value="" disabled selected>{$_('admin.select.emoji')}</option>
					{#each $emojis as emoji (emoji.id)}
						<option value={emoji.id}>{emoji.name}</option>
					{/each}
				</select>
				<select bind:value={selectedRuleRoleName} class="admin-select">
					<option value="" disabled selected>{$_('admin.select.role')}</option>
					{#each assignableRoleOptions as role (role.roleName)}
						<option value={role.roleName}>{getRoleLabel(role.roleName)}</option>
					{/each}
				</select>
				<label class="rule-checkbox">
					<input type="checkbox" bind:checked={selectedRuleRemoveOnUnreact} />
					{$_('admin.emoji_rules.remove_on_unreact')}
				</label>
				<button class="admin-btn" on:click={addEmojiRoleRule}>{$_('admin.emoji_rules.add_rule')}</button>
			</div>
			<div class="emoji-rule-list">
				{#each emojiRoleRules as rule (rule.id)}
					<div class="emoji-rule-item">
						<span>#{getChannelName(rule.channelId)} | {rule.messageId.slice(0, 18)}... | {rule.emojiId} -> {getRoleLabel(rule.roleName)}{rule.removeOnUnreact ? ` (${$_('admin.emoji_rules.reversible')})` : ''}</span>
						<button class="admin-btn danger" on:click={() => deleteEmojiRoleRule(rule.id)}>{$_('admin.actions.delete')}</button>
					</div>
				{:else}
					<div class="admin-empty">{$_('admin.emoji_rules.empty')}</div>
				{/each}
			</div>
		</div>

		<div class="admin-section">
			<div class="compression-header">
				<h4>Payments Access Control</h4>
				<div class="compression-actions">
					<button class="admin-btn" disabled={paymentPolicyLoading || paymentPolicySaving} on:click={refreshPaymentControls}>
						{paymentPolicyLoading ? 'Loading...' : 'Refresh'}
					</button>
					<button class="admin-btn" disabled={paymentPolicyLoading || paymentPolicySaving} on:click={savePaymentPolicy}>
						{paymentPolicySaving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>

			{#if paymentPolicyError}
				<div class="admin-empty">{paymentPolicyError}</div>
			{/if}
			{#if paymentPolicySaveStatus}
				<div class="runtime-hint">{paymentPolicySaveStatus}</div>
			{/if}

			<label class="rule-checkbox">
				<input type="checkbox" bind:checked={paymentPolicy.enabled} />
				Enable payments server-wide
			</label>
			<label class="rule-checkbox">
				<input type="checkbox" bind:checked={paymentPolicy.allowGuest} />
				Allow guests to create payments
			</label>

			<div class="payment-role-grid">
				{#each roleDefinitions as role (role.roleName)}
					<label class="rule-checkbox payment-role-toggle">
						<input
							type="checkbox"
							checked={paymentPolicy.allowedRoleNames.includes(role.roleName.toLowerCase())}
							on:change={(e) => setRolePaymentAllowed(role.roleName, (e.currentTarget as HTMLInputElement).checked)}
						/>
						<span>{getRoleLabel(role.roleName)} can create payments</span>
					</label>
				{/each}
			</div>

			<div class="admin-empty">
				User-level payment blocks: {paymentUserBlocks.length}
			</div>
		</div>

		<div class="admin-section">
			<div class="compression-header">
				<h4>Compression Observability</h4>
				<div class="compression-actions">
					<button class="admin-btn" disabled={compressionLoading} on:click={refreshCompressionPanel}>
						{compressionLoading ? 'Loading...' : 'Refresh'}
					</button>
					<button class="admin-btn danger" disabled={compressionLoading} on:click={resetCompressionPanelMetrics}>
						Reset Metrics
					</button>
				</div>
			</div>
			{#if compressionError}
				<div class="admin-empty">{compressionError}</div>
			{:else if compressionConfig && compressionMetrics}
				<div class="compression-grid">
					<div class="compression-stat">
						<span class="k">HTTP Text</span>
						<span class="v">{compressionConfig.httpTextCompression.enabled ? 'Enabled' : 'Disabled'}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Upload Compression</span>
						<span class="v">{compressionConfig.uploadCompression.enabled ? 'Enabled' : 'Disabled'}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Upload Rollout</span>
						<span class="v">{compressionConfig.uploadCompression.rolloutPercent}%</span>
					</div>
					<div class="compression-stat">
						<span class="k">Uploads</span>
						<span class="v">{compressionMetrics.counters.uploadCount}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Downloads</span>
						<span class="v">{compressionMetrics.counters.downloadCount}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Upload Ratio</span>
						<span class="v">{formatRatio(compressionMetrics.counters.uploadStoredToOriginalRatio)}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Download Ratio</span>
						<span class="v">{formatRatio(compressionMetrics.counters.downloadResponseToStoredRatio)}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Upload Bytes</span>
						<span class="v">{formatBytes(compressionMetrics.counters.uploadStoredBytes)} / {formatBytes(compressionMetrics.counters.uploadOriginalBytes)}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Download Bytes</span>
						<span class="v">{formatBytes(compressionMetrics.counters.downloadResponseBytes)} / {formatBytes(compressionMetrics.counters.downloadStoredBytes)}</span>
					</div>
					{#if compressionMetrics.clientVideoCompression}
						<div class="compression-stat">
							<span class="k">Client Attempts</span>
							<span class="v">{compressionMetrics.clientVideoCompression.counters.attemptCount}</span>
						</div>
						<div class="compression-stat">
							<span class="k">Client Success Rate</span>
							<span class="v">{formatRatio(compressionMetrics.clientVideoCompression.counters.successRate)}</span>
						</div>
						<div class="compression-stat">
							<span class="k">Client Timeouts</span>
							<span class="v">{compressionMetrics.clientVideoCompression.counters.timeoutCount}</span>
						</div>
						<div class="compression-stat">
							<span class="k">Client Output Ratio</span>
							<span class="v">{formatRatio(compressionMetrics.clientVideoCompression.counters.outputToInputRatio)}</span>
						</div>
					{/if}
				</div>
				{#if compressionMetrics.clientVideoCompression}
					{#if compressionMetrics.clientVideoCompression.summaryByRuntime.length > 0}
						<div class="compression-grid">
							{#each compressionMetrics.clientVideoCompression.summaryByRuntime as runtimeSummary (runtimeSummary.runtime)}
								<div class="compression-stat">
									<span class="k">Client {runtimeSummary.runtime}</span>
									<span class="v">
										{runtimeSummary.successCount} ok / {runtimeSummary.failureCount} fail / {runtimeSummary.cancelledCount} cancel
									</span>
								</div>
							{/each}
						</div>
					{/if}
					{#if compressionMetrics.clientVideoCompression.topFailureCodes.length > 0}
						<div class="compression-failure-tags">
							{#each compressionMetrics.clientVideoCompression.topFailureCodes as item (item.failureCode)}
								<span class="compression-failure-tag">{item.failureCode}: {item.count}</span>
							{/each}
						</div>
					{/if}
				{/if}
			{:else}
				<div class="admin-empty">No compression metrics yet.</div>
			{/if}
		</div>

		<div class="admin-section">
			<div class="compression-header">
				<h4>Runtime Tuning (Restart Applied)</h4>
				<div class="compression-actions">
					<button class="admin-btn" disabled={runtimeLoading || runtimeSaving} on:click={refreshRuntimePanel}>
						{runtimeLoading ? 'Loading...' : 'Refresh'}
					</button>
					<button class="admin-btn" disabled={runtimeLoading || runtimeSaving} on:click={saveRuntimeTuning}>
						{runtimeSaving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>

			{#if runtimeError}
				<div class="admin-empty">{runtimeError}</div>
			{:else if runtimePanel}
				<div class="runtime-form-grid">
					<label>
						Thread Pool Size
						<input
							type="number"
							min="1"
							max="64"
							placeholder="auto"
							bind:value={runtimeTuningDraft.threadPoolSize}
						/>
					</label>
					<label>
						Heavy Profiling Sample Rate
						<input
							type="number"
							min="0.01"
							max="1"
							step="0.01"
							bind:value={runtimeTuningDraft.heavyProfilingSampleRate}
						/>
					</label>
					<label class="runtime-checkbox">
						<input type="checkbox" bind:checked={runtimeTuningDraft.heavyProfilingEnabled} />
						Enable heavy profiling
					</label>
				</div>

				<div class="runtime-hint">
					Restart required after save. Lightweight counters stay active; heavy profiling loads only when enabled.
				</div>
				{#if runtimeSaveStatus}
					<div class="runtime-hint">{runtimeSaveStatus}</div>
				{/if}

				<div class="compression-grid">
					<div class="compression-stat">
						<span class="k">Restart Required</span>
						<span class="v">{runtimePanel.runtimeTuning.restartRequired ? 'Yes' : 'No'}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Effective UV Pool</span>
						<span class="v">{runtimePanel.runtimeTuning.effective.uvThreadpoolSize ?? 'auto'}</span>
					</div>
					<div class="compression-stat">
						<span class="k">RSS</span>
						<span class="v">{formatBytes(runtimePanel.guardrails.memory.rssBytes)}</span>
					</div>
					<div class="compression-stat">
						<span class="k">Heap Used</span>
						<span class="v">{formatBytes(runtimePanel.guardrails.memory.heapUsedBytes)}</span>
					</div>
					<div class="compression-stat">
						<span class="k">CPU User (ms)</span>
						<span class="v">{formatNumber(runtimePanel.guardrails.cpu.userMicros / 1000)}</span>
					</div>
					<div class="compression-stat">
						<span class="k">EL Delay P95 (ms)</span>
						<span class="v">{formatNumber(runtimePanel.guardrails.heavyProfiling.eventLoopDelayP95Ms)}</span>
					</div>
				</div>
			{:else}
				<div class="admin-empty">No runtime tuning data yet.</div>
			{/if}
		</div>
	{/if}

	{#if canManageRoles}
		<div class="admin-section">
			<div class="compression-header">
				<h4>Frontend App Metadata</h4>
				<div class="compression-actions">
					{#if frontendMetadataDirty}
						<button class="admin-btn" disabled={frontendMetadataSaving} on:click={discardFrontendMetadataDraft}>Discard</button>
					{/if}
					<button class="admin-btn" disabled={frontendMetadataSaving} on:click={saveFrontendMetadata}>
						{frontendMetadataSaving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>

			{#if frontendMetadataError}
				<div class="admin-empty">{frontendMetadataError}</div>
			{:else}
				<div class="runtime-hint frontend-metadata-status">
					{#if frontendMetadataDirty}
						Preview is showing your unsaved changes. Save to publish them, or discard them.
					{:else}
						Preview is showing the current live shell branding.
					{/if}
				</div>

				<div class="runtime-form-grid">
					<label>
						Display Name
						<input type="text" bind:value={frontendAppMetadata.displayName} placeholder="What users see in the app shell" />
					</label>
					<label>
						Accent Color
						<input type="text" bind:value={frontendAppMetadata.accentColor} placeholder="#2dd4bf" />
					</label>
					<label class="frontend-metadata-wide">
						Description
						<input type="text" bind:value={frontendAppMetadata.description} placeholder="Short line for the server switcher banner" />
					</label>
					<details class="frontend-metadata-manual frontend-metadata-wide">
						<summary>Advanced asset URLs</summary>
						<div class="frontend-metadata-manual-grid">
							<label>
								Icon URL
								<input type="text" bind:value={frontendAppMetadata.iconUrl} placeholder="/uploads/server-icon.webp" />
							</label>
							<label>
								Banner URL
								<input type="text" bind:value={frontendAppMetadata.bannerUrl} placeholder="/uploads/server-banner.webp" />
							</label>
						</div>
					</details>
					<label class="runtime-checkbox frontend-metadata-wide">
						<input type="checkbox" bind:checked={frontendAppMetadata.launchPageFallbackEnabled} />
						Use login launch-page branding as fallback when metadata fields are empty
					</label>
				</div>

				<div class="frontend-metadata-upload-row">
					<input
						bind:this={frontendIconInput}
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						class="frontend-metadata-hidden-input"
						on:change={(event) => void uploadFrontendMetadataAsset('icon', event)}
					/>
					<input
						bind:this={frontendBannerInput}
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						class="frontend-metadata-hidden-input"
						on:change={(event) => void uploadFrontendMetadataAsset('banner', event)}
					/>
					<button
						type="button"
						class="admin-btn"
						disabled={frontendMetadataUploadTarget !== null}
						on:click={() => triggerFrontendMetadataUpload('icon')}
					>
						{frontendMetadataUploadTarget === 'icon' ? 'Uploading Icon...' : 'Upload Icon'}
					</button>
					<button
						type="button"
						class="admin-btn"
						disabled={frontendMetadataUploadTarget !== null}
						on:click={() => triggerFrontendMetadataUpload('banner')}
					>
						{frontendMetadataUploadTarget === 'banner' ? 'Uploading Banner...' : 'Upload Banner'}
					</button>
				</div>

				{#if frontendMetadataSaveStatus}
					<div class="runtime-hint">{frontendMetadataSaveStatus}</div>
				{/if}

				<div class="frontend-metadata-preview-shell">
					<div class="frontend-metadata-preview-label">
						<strong>Preview</strong>
						<span>
							{frontendMetadataDirty
								? 'This is what will publish when you save.'
								: 'This is what the shell is showing right now.'}
						</span>
					</div>

					<div class="frontend-metadata-preview" style:--metadata-accent={frontendAppMetadata.accentColor || '#2dd4bf'}>
						{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl)}
							<img
								src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.bannerUrl) || undefined}
								alt={frontendAppMetadata.displayName || 'Server banner'}
								class="frontend-metadata-preview-banner"
							/>
						{/if}
						<div class="frontend-metadata-preview-copy">
							<div class="frontend-metadata-preview-avatar">
								{#if resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl)}
									<img src={resolveFrontendMetadataAssetUrl(frontendAppMetadata.iconUrl) || undefined} alt={frontendAppMetadata.displayName || 'Server icon'} />
								{:else}
									<span>{(frontendAppMetadata.displayName || 'W').charAt(0).toUpperCase()}</span>
								{/if}
							</div>
							<div>
								<strong>{frontendAppMetadata.displayName || 'Client display name preview'}</strong>
								<span>{frontendAppMetadata.description || 'This controls what the Wabi frontend shows in the rail, header, and switcher.'}</span>
							</div>
						</div>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<div class="admin-section">
		<h4>{$_('admin.sections.users')}</h4>
		<div class="admin-search-wrap">
			<input
				type="text"
				class="admin-search"
				placeholder={$_('admin.placeholders.search_users')}
				bind:value={searchQuery}
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
						<button class="admin-icon-btn" on:click={() => handleMessage(user)} title={$_('admin.actions.message')} aria-label={$_('admin.actions.message')}>
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
									on:change={(event) =>
										setUserRoleLevel(
											user,
											(event.currentTarget as HTMLSelectElement).value as ManagedUserRole
										)}
								>
									{#each manageableUserRoleOptions as roleName (roleName)}
										<option value={roleName}>{getRoleLabel(roleName)}</option>
									{/each}
								</select>
							</label>
							<button
								class="admin-btn warning admin-pay-toggle"
								disabled={!canManageTargetUser(user) || !user.dbUserId || paymentBlockBusyUserId === user.dbUserId}
								on:click={() => toggleUserPaymentBlock(user)}
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
</div>

<style>
	.admin-tab { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 0.6rem; gap: 0.6rem; overflow-y: auto; }
	.admin-header { padding: 0.1rem 0.2rem 0.15rem; }
	.admin-title-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
	.admin-title-row h3 { margin: 0; font-size: 0.92rem; }
	.admin-role-indicator { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-secondary); }
	.admin-subtitle { margin: 0.25rem 0 0; font-size: 0.76rem; color: var(--text-secondary); }
	.admin-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.35rem; }
	.admin-stat { display: flex; flex-direction: column; padding: 0.4rem; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-raised); }
	.admin-stat .k { font-size: 0.65rem; text-transform: uppercase; color: var(--text-secondary); }
	.admin-stat .v { font-size: 0.9rem; font-weight: 700; color: var(--text-heading); }
	.admin-section { border: 1px solid var(--border-subtle); border-radius: 10px; padding: 0.55rem; background: var(--surface-base); display: flex; flex-direction: column; gap: 0.45rem; }
	.admin-section h4 { margin: 0; font-size: 0.8rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; }
	.compression-header { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; }
	.compression-actions { display: inline-flex; gap: 0.35rem; }
	.compression-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.35rem; }
	.compression-stat { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.4rem; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-raised); }
	.compression-stat .k { font-size: 0.64rem; text-transform: uppercase; color: var(--text-secondary); letter-spacing: 0.03em; }
	.compression-stat .v { font-size: 0.78rem; color: var(--text-heading); font-weight: 600; }
	.compression-failure-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
	.compression-failure-tag {
		font-size: 0.66rem;
		color: var(--text-secondary);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0.12rem 0.4rem;
		background: var(--surface-raised);
	}
	.runtime-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.45rem; }
	.runtime-form-grid label { display: flex; flex-direction: column; gap: 0.28rem; font-size: 0.72rem; color: var(--text-secondary); }
	.runtime-form-grid input[type='number'] { height: 28px; border: 1px solid var(--border-subtle); background: var(--surface-app); color: var(--text-heading); border-radius: 7px; padding: 0 0.45rem; font-size: 0.76rem; }
	.runtime-form-grid input[type='text'] { height: 28px; border: 1px solid var(--border-subtle); background: var(--surface-app); color: var(--text-heading); border-radius: 7px; padding: 0 0.45rem; font-size: 0.76rem; }
	.runtime-checkbox { grid-column: 1 / -1; flex-direction: row !important; align-items: center; gap: 0.45rem !important; }
	.runtime-hint { font-size: 0.72rem; color: var(--text-secondary); }
	.frontend-metadata-status { margin-bottom: 0.5rem; }
	.frontend-metadata-wide { grid-column: 1 / -1; }
	.frontend-metadata-manual { display: grid; gap: 0.45rem; }
	.frontend-metadata-manual summary { cursor: pointer; font-size: 0.72rem; color: var(--text-secondary); }
	.frontend-metadata-manual-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.45rem; }
	.frontend-metadata-upload-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.frontend-metadata-hidden-input { display: none; }
	.frontend-metadata-preview-shell { display: grid; gap: 0.55rem; }
	.frontend-metadata-preview-label {
		display: flex;
		flex-direction: column;
		gap: 0.14rem;
		font-size: 0.72rem;
		color: var(--text-secondary);
	}
	.frontend-metadata-preview-label strong {
		font-size: 0.75rem;
		color: var(--text-heading);
	}
	.frontend-metadata-preview {
		position: relative;
		min-height: 148px;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		overflow: hidden;
		background: linear-gradient(135deg, color-mix(in srgb, var(--metadata-accent) 18%, var(--surface-raised)), var(--surface-base));
	}
	.frontend-metadata-preview-banner {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0.32;
	}
	.frontend-metadata-preview-copy {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 1.1rem;
		min-height: 148px;
		background: linear-gradient(180deg, var(--shadow-sm, rgba(0, 0, 0, 0.03)), var(--shadow-md, rgba(0, 0, 0, 0.36)));
	}
	.frontend-metadata-preview-avatar {
		width: 52px;
		height: 52px;
		border-radius: 16px;
		overflow: hidden;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		color: var(--text-inverse, #fff);
		background: rgba(var(--text-inverse-rgb, 255, 255, 255), 0.12);
		border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.12);
	}
	.frontend-metadata-preview-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.frontend-metadata-preview-copy strong,
	.frontend-metadata-preview-copy span {
		display: block;
	}
	.frontend-metadata-preview-copy strong {
		font-size: 0.9rem;
		color: var(--text-inverse, #f8fafc);
	}
	.frontend-metadata-preview-copy span {
		margin-top: 0.18rem;
		font-size: 0.75rem;
		color: rgba(248, 250, 252, 0.8);
	}
	.role-list, .channel-role-list, .emoji-rule-list, .admin-user-list { display: flex; flex-direction: column; gap: 0.35rem; }
	.role-item, .channel-role-item, .emoji-rule-item, .admin-user-item { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; padding: 0.45rem; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-raised); }
	.role-key { width: 80px; font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; }
	.role-input, .channel-role-select, .admin-select, .admin-search { border: 1px solid var(--border-subtle); background: var(--surface-app); color: var(--text-heading); border-radius: 7px; font-size: 0.78rem; }
	.role-input { flex: 1; height: 28px; padding: 0 0.5rem; }
	.channel-role-meta { display: inline-flex; gap: 0.5rem; align-items: center; }
	.channel-name { font-weight: 600; font-size: 0.8rem; color: var(--text-heading); }
	.channel-type { font-size: 0.68rem; color: var(--text-secondary); text-transform: uppercase; }
	.channel-role-select, .admin-select { height: 28px; padding: 0 0.45rem; }
	.emoji-rule-create { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.rule-checkbox { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.74rem; color: var(--text-secondary); }
	.payment-role-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.35rem; }
	.payment-role-toggle { border: 1px solid var(--border-subtle); border-radius: 8px; padding: 0.35rem 0.45rem; background: var(--surface-raised); }
	.admin-user-meta { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; min-width: 0; }
	.admin-user-name { font-size: 0.84rem; font-weight: 600; color: var(--text-heading); }
	.admin-role-badge, .admin-guest-badge { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.12rem 0.35rem; border-radius: 999px; border: 1px solid var(--border-subtle); color: var(--text-secondary); }
	.admin-guest-badge { background: var(--accent-warning-soft, rgba(var(--color-warning-rgb, 255, 193, 7), 0.12)); border-color: rgba(var(--color-warning-rgb, 255, 193, 7), 0.35); }
	.admin-payment-block-badge { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.12rem 0.35rem; border-radius: 999px; border: 1px solid rgba(var(--color-danger-rgb, 244, 67, 54), 0.45); color: var(--text-danger, #ff8a80); background: rgba(var(--color-danger-rgb, 244, 67, 54), 0.12); }
	.admin-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 0.45rem; }
	.admin-btn { height: 26px; padding: 0 0.5rem; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--surface-base); color: var(--text-secondary); font-size: 0.72rem; font-weight: 600; cursor: pointer; }
	.admin-btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-heading); }
	.admin-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.admin-btn.danger:hover:not(:disabled) { color: var(--color-danger, #f44336); border-color: rgba(var(--color-danger-rgb, 244, 67, 54), 0.4); background: rgba(var(--color-danger-rgb, 244, 67, 54), 0.08); }
	.admin-btn.warning:hover:not(:disabled) { color: var(--text-warning, #ffb74d); border-color: rgba(255, 183, 77, 0.45); background: rgba(255, 183, 77, 0.12); }
	.admin-icon-btn {
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		flex-shrink: 0;
		padding: 0;
	}
	.admin-icon-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-primary) 10%, transparent); color: var(--text-heading); }
	.admin-icon-btn svg { width: 14px; height: 14px; display: block; }
	.admin-role-control {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-secondary);
	}
	.admin-user-role-select {
		min-width: 112px;
	}
	.admin-pay-toggle {
		min-width: 96px;
	}
	.admin-search-wrap { padding: 0.1rem 0; }
	.admin-search { width: 100%; height: 30px; padding: 0 0.55rem; }
	.admin-empty { padding: 0.8rem; text-align: center; color: var(--text-secondary); font-size: 0.78rem; }
	@media (max-width: 768px) {
		.admin-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
		.runtime-form-grid { grid-template-columns: 1fr; }
		.payment-role-grid { grid-template-columns: 1fr; }
		.admin-user-item { align-items: flex-start; }
		.admin-actions { width: 100%; justify-content: flex-start; }
	}
</style>
