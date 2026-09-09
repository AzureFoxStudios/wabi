<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { channels, currentUser, badgeCatalog, type User, connected } from '$lib/socket';
	import { assignRole } from '$lib/presenceStore';
	import { socket as socketState } from '$lib/socketConnectionState';
	import { createAdminBadgeMutation, type AdminBadgeMutationState } from '$lib/adminBadgeMutation';
	import { createAdminRoleCatalog, type AdminRoleDefinition } from '$lib/adminRoleCatalog';
	import { users, serverMembers } from '$lib/socket';
	import { getSocket } from '$lib/socket';
	import { createDM, joinChannel } from '$lib/socket';
	import { createAdminUserMessaging } from '$lib/adminUserMessaging';
	import { adminPaymentPoliciesMatch, canSaveAdminPaymentPolicy, cloneAdminPaymentPolicy, readAdminPaymentPolicy } from '$lib/adminPaymentPolicy';
	import { uploadAdminBrandingAsset } from '$lib/adminBrandingUpload';
	import { fetchWithTimeout } from '$lib/api/utils';
	import { openAdminSection } from '$lib/adminNavigationState';
	import { adminChannelDirectory, createAdminChannelOpener } from '$lib/adminChannelNavigation';
	import { switchChannel } from '$lib/channelStore';
	import { selectWorkspaceView } from '$lib/workspaceNavigationState';
	import { layoutStore } from '$lib/layoutStore';
	import { getAuthToken, authSessionGeneration, onAuthSessionCleared } from '$lib/authSession';
	import { refreshSavedServer, currentSavedServer } from '$lib/savedServers';
	import { getServerUrl, resolveServerUrl, activeServerUrl } from '$lib/serverUrl';
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
	import AdminPasswordReset from './admin/AdminPasswordReset.svelte';
	import TailcatPanel from './admin/TailcatPanel.svelte';
	import TailcatCallout from './admin/TailcatCallout.svelte';

	let { section = 'all' }: { section?: 'all' | 'users' | 'roles' | 'channels' | 'gates' | 'payments' | 'runtime' | 'branding' | 'settings' } = $props();

	type ManagedUserRole = 'member' | 'mod' | 'admin';
	let disposed = false;
	let brandingUpload: AbortController | null = null;
	function captureAdminWork() {
		const server = $activeServerUrl;
		const actor = $currentUser?.dbUserId;
		const generation = authSessionGeneration(server);
		return () => !disposed && canManageRoles && $activeServerUrl === server && $currentUser?.dbUserId === actor && authSessionGeneration(server) === generation;
	}

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

	let searchQuery = $state('');
	let passwordResetTarget: User | null = $state(null);
	let messagePendingUserId: string | null = $state(null);
	let messageActionError = $state('');
	const userMessaging = createAdminUserMessaging({
		context: () => ({ server: $activeServerUrl, generation: authSessionGeneration($activeServerUrl), self: $currentUser, online: $connected, active: !disposed && canModerate && ['all', 'users'].includes(section), channels: $channels }),
		create: createDM,
		open: (channelId, user) => layoutStore.openDM(channelId, user),
		join: joinChannel,
		openNotes: () => layoutStore.openNotes(),
		leaveAdmin: () => layoutStore.setCenterPanelView('chat'),
		changed: ({ pendingUserId, error }) => { messagePendingUserId = pendingUserId; messageActionError = error; }
	});
	let roleBusyUserIds: number[] = $state([]);
	let roleActionError = $state('');
	let roleActionStatus = $state('');
	let badgeMutationState: AdminBadgeMutationState = $state({ pending: null, error: '', status: '' });
	const badgeMutation = createAdminBadgeMutation({
		context: () => ({ server: $activeServerUrl, actorId: $currentUser?.dbUserId ?? null, generation: authSessionGeneration($activeServerUrl), online: $connected, active: !disposed && canManageRoles && ['all', 'users'].includes(section), socket: getSocket() }),
		canManageTarget: (id) => { const user = rosterUsers.find(entry => entry.dbUserId === id); return Boolean(user && canManageTargetUser(user)); },
		changed: (next) => { badgeMutationState = next; }
	});
	let roleDefinitions: AdminRoleDefinition[] = $state([]);
	let rolesLoading = $state(true);
	let rolesError = $state('');
	const roleCatalog = createAdminRoleCatalog((state) => {
		roleDefinitions = state.roles;
		rolesLoading = state.loading;
		rolesError = state.error;
	});
	let compressionConfig: AdminCompressionConfig | null = $state(null);
	let compressionMetrics: AdminCompressionMetrics | null = $state(null);
	let compressionLoading = $state(false);
	let compressionLoaded = $state(false);
	let compressionAttempted = $state(false);
	let compressionError = $state('');
	let runtimePanel: AdminRuntimeGuardrailsResponse | null = $state(null);
	let runtimeTuningDraft: RuntimeTuningConfig = $state({
		applyOnRestart: true,
		threadPoolSize: null,
		heavyProfilingEnabled: false,
		heavyProfilingSampleRate: 0.1
	});
	let runtimeLoading = $state(false);
	let runtimeSaving = $state(false);
	let runtimeLoaded = $state(false);
	let runtimeAttempted = $state(false);
	let runtimeError = $state('');
	let runtimeSaveStatus = $state('');
	let paymentPolicy: PaymentAccessPolicy = $state({
		enabled: false,
		allowGuest: false,
		allowedRoleNames: ['owner', 'admin', 'mod', 'member']
	});
	let publishedPaymentPolicy: PaymentAccessPolicy | null = $state(null);
	let frontendAppMetadata: FrontendAppMetadataPolicy = $state(createEmptyFrontendAppMetadata());
	let publishedFrontendAppMetadata: FrontendAppMetadataPolicy = $state(createEmptyFrontendAppMetadata());
	let frontendMetadataLoading = $state(false);
	let frontendMetadataLoaded = $state(false);
	let frontendMetadataAttempted = $state(false);
	let frontendMetadataSaving = $state(false);
	let frontendMetadataError = $state('');
	let frontendMetadataSaveStatus = $state('');
	let frontendMetadataUploadTarget: 'icon' | 'banner' | null = $state(null);
	let paymentPolicyLoading = $state(false);
	let paymentPolicyLoaded = $state(false);
	let paymentPolicyAttempted = $state(false);
	let paymentPolicySaving = $state(false);
	let paymentPolicyError = $state('');
	let paymentPolicySaveStatus = $state('');
	let paymentUserBlocks: PaymentUserBlock[] = $state([]);
	let paymentBlockBusyUserId: number | null = $state(null);
	let paymentBlocksAttempted = $state(false);
	let paymentBlocksLoaded = $state(false);
	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};

	const canManageRoles = $derived($currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin');
	const canModerate = $derived(canManageRoles || $currentUser?.highestRole === 'mod');
	const manageableUserRoleOptions = $derived.by((): ManagedUserRole[] => {
		const roles = roleDefinitions.filter((role) => ['member', 'mod', 'admin'].includes(role.roleName)).map((role) => role.roleName as ManagedUserRole);
		return roles.length > 0 ? roles : ['member', 'mod', 'admin'];
	});
	const customChannels = $derived(adminChannelDirectory($channels));
	const openAdminChannel = createAdminChannelOpener({
		channels: () => $channels,
		canOpen: () => !disposed && canManageRoles,
		selectChannel: switchChannel,
		showChannelSurface: () => selectWorkspaceView('messages'),
		closeCenterConversation: () => layoutStore.closeCenterDm(),
		leaveAdmin: () => layoutStore.setCenterPanelView('chat'),
		navigate: (detail) => window.dispatchEvent(new CustomEvent('wabi:navigate', { detail }))
	});
	// Keep offline registered members visible. Online entries provide current presence.
	const rosterUsers = $derived.by(() => {
		const byId = new Map<string, User>();
		for (const user of $serverMembers) byId.set(String(user.dbUserId ?? user.id), user);
		for (const user of $users) byId.set(String(user.dbUserId ?? user.id), user);
		return [...byId.values()];
	});
	const sortedUsers = $derived(rosterUsers.filter((user) => {
		const query = searchQuery.trim().toLowerCase();
		return !query || user.username.toLowerCase().includes(query) || (user.handle || '').toLowerCase().includes(query);
	}).sort((a, b) => {
		const priority = getRolePriority(b.highestRole) - getRolePriority(a.highestRole);
		return priority || a.username.localeCompare(b.username);
	}));
	const ownerCount = $derived(rosterUsers.filter((u) => u.highestRole === 'owner').length);
	const adminCount = $derived(rosterUsers.filter((u) => u.highestRole === 'admin').length);
	const modCount = $derived(rosterUsers.filter((u) => u.highestRole === 'mod').length);
	const guestCount = $derived(rosterUsers.filter((u) => !u.dbUserId || u.isRegistered === false).length);
	$effect(() => {
		if (canManageRoles && ['all', 'runtime'].includes(section) && !compressionLoaded && !compressionLoading && !compressionAttempted) untrack(() => void refreshCompressionPanel());
	});
	$effect(() => {
		if (canManageRoles && ['all', 'runtime'].includes(section) && !runtimeLoaded && !runtimeLoading && !runtimeAttempted) untrack(() => void refreshRuntimePanel());
	});
	$effect(() => {
		if (canManageRoles && ['all', 'branding'].includes(section) && !frontendMetadataLoaded && !frontendMetadataLoading && !frontendMetadataAttempted) untrack(() => void refreshFrontendMetadata());
	});
	$effect(() => {
		if (canManageRoles && ['all', 'payments'].includes(section) && !paymentPolicyLoaded && !paymentPolicyLoading && !paymentPolicyAttempted) untrack(() => void refreshPaymentControls());
	});
	$effect(() => {
		if (canManageRoles && section === 'users' && !paymentBlocksAttempted) untrack(() => void refreshUserPaymentBlocks());
	});
	$effect(() => {
		// These are lifecycle/authority inputs, not a subscription to pending UI state.
		$activeServerUrl; $currentUser; $connected; rosterUsers; section;
		untrack(() => badgeMutation.reconcile());
	});
	const paymentBlockedUserIds = $derived(new Set(paymentUserBlocks.map((block) => block.userId)));
	const paymentPolicyDirty = $derived(paymentPolicyLoaded && !adminPaymentPoliciesMatch(paymentPolicy, publishedPaymentPolicy));

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
		if (!$currentUser || isCurrentUserEntry(user)) return false;
		if (!user.dbUserId || user.isRegistered === false) return false;
		const latest = rosterUsers.find((entry) => entry.dbUserId === user.dbUserId) ?? user;
		if (latest.highestRole === 'owner' || latest.isRegistered === false) return false;
		return true;
	}

	function openPasswordReset(user: User) {
		if (canManageTargetUser(user)) passwordResetTarget = user;
	}

	function isCurrentUserEntry(user: User): boolean {
		if (!$currentUser) return false;
		if (user.id === $currentUser.id) return true;
		if (user.dbUserId && $currentUser.dbUserId && user.dbUserId === $currentUser.dbUserId) return true;
		return false;
	}

	function handleMessage(user: User) { void userMessaging.open(user); }

	function getManagedUserRole(user: User): ManagedUserRole {
		if (userHasRole(user, 'admin')) return 'admin';
		if (userHasRole(user, 'mod')) return 'mod';
		return 'member';
	}

	async function setUserRoleLevel(user: User, nextRole: ManagedUserRole) {
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
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
			if (!isCurrent()) return;
			roleActionStatus = `${user.username} is now ${getRoleLabel(nextRole)}.`;
		} catch (error) {
			if (!isCurrent()) return;
			roleActionError = error instanceof Error ? error.message : 'Could not change this member’s role.';
		} finally {
			if (!isCurrent()) return;
			roleBusyUserIds = roleBusyUserIds.filter((id) => id !== userId);
		}
	}

	function handleAssignBadge(user: User, badgeId: string) {
		if (!canManageTargetUser(user) || !user.dbUserId || !$badgeCatalog.some(badge => badge.id === badgeId)) return;
		badgeMutation.change('assign', { dbUserId: user.dbUserId, username: user.username }, badgeId);
	}

	function handleRemoveBadge(user: User, badgeId: string) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;
		badgeMutation.change('remove', { dbUserId: user.dbUserId, username: user.username }, badgeId);
	}

	async function refreshCompressionPanel() {
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
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
			if (!isCurrent()) return;
			compressionConfig = config;
			compressionMetrics = metrics;
			compressionLoaded = true;
		} catch (error) {
			if (!isCurrent()) return;
			compressionError = (error as Error).message || 'Failed to load compression panel';
		} finally {
			if (!isCurrent()) return;
			compressionLoading = false;
		}
	}

	async function resetCompressionPanelMetrics() {
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		const token = getAuthToken();
		if (!token) return;
		compressionLoading = true;
		compressionError = '';
		try {
			await resetAdminCompressionMetrics(token);
			if (!isCurrent()) return;
			await refreshCompressionPanel();
		} catch (error) {
			if (!isCurrent()) return;
			compressionError = (error as Error).message || 'Failed to reset compression metrics';
			compressionLoading = false;
		}
	}

	async function refreshRuntimePanel() {
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
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
			if (!isCurrent()) return;
			runtimeTuningDraft = { ...policy.config };
			runtimePanel = guardrails;
			runtimeLoaded = true;
		} catch (error) {
			if (!isCurrent()) return;
			runtimeError = (error as Error).message || 'Failed to load runtime settings';
		} finally {
			if (!isCurrent()) return;
			runtimeLoading = false;
		}
	}

	async function saveRuntimeTuning() {
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		const token = getAuthToken();
		if (!token) return;
		runtimeSaving = true;
		runtimeSaveStatus = '';
		runtimeError = '';
		try {
			const saved = await saveAdminPolicy<RuntimeTuningConfig>(token, 'runtime_tuning', runtimeTuningDraft);
			if (!isCurrent()) return;
			runtimeTuningDraft = { ...saved };
			runtimeSaveStatus = 'Saved. Restart required to apply.';
			await refreshRuntimePanel();
		} catch (error) {
			if (!isCurrent()) return;
			runtimeError = (error as Error).message || 'Failed to save runtime settings';
		} finally {
			if (!isCurrent()) return;
			runtimeSaving = false;
		}
	}

	async function refreshFrontendMetadata() {
		if (frontendMetadataLoading || frontendMetadataSaving || frontendMetadataUploadTarget || (frontendMetadataLoaded && !frontendMetadataMatches(frontendAppMetadata, publishedFrontendAppMetadata))) return;
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		const token = getAuthToken();
		if (!token) return;
		frontendMetadataAttempted = true;
		frontendMetadataLoading = true;
		frontendMetadataError = '';
		try {
			const loadedMetadata = await getAdminFrontendAppMetadataPolicy(token);
			if (!isCurrent()) return;
			frontendAppMetadata = cloneFrontendAppMetadata(loadedMetadata);
			publishedFrontendAppMetadata = cloneFrontendAppMetadata(loadedMetadata);
			frontendMetadataLoaded = true;
		} catch (error) {
			if (!isCurrent()) return;
			frontendMetadataError = (error as Error).message || 'Failed to load frontend app metadata';
		} finally {
			if (!isCurrent()) return;
			frontendMetadataLoading = false;
		}
	}

	async function saveFrontendMetadata() {
		if (!frontendMetadataLoaded || frontendMetadataSaving || frontendMetadataUploadTarget || frontendMetadataMatches(frontendAppMetadata, publishedFrontendAppMetadata)) return;
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		const token = getAuthToken();
		if (!token) return;
		frontendMetadataSaving = true;
		frontendMetadataError = '';
		frontendMetadataSaveStatus = '';
		try {
			const savedMetadata = await saveAdminFrontendAppMetadataPolicy(token, frontendAppMetadata);
			if (!isCurrent()) return;
			frontendAppMetadata = cloneFrontendAppMetadata(savedMetadata);
			publishedFrontendAppMetadata = cloneFrontendAppMetadata(savedMetadata);
			frontendMetadataSaveStatus = 'Server identity published.';
			refreshSavedServer(resolveServerUrl().url);
		} catch (error) {
			if (!isCurrent()) return;
			frontendMetadataError = (error as Error).message || 'Failed to save frontend app metadata';
		} finally {
			if (!isCurrent()) return;
			frontendMetadataSaving = false;
		}
	}

	async function uploadFrontendMetadataAsset(target: 'icon' | 'banner', source: Event | File): Promise<void> {
		if (!frontendMetadataLoaded || frontendMetadataSaving || frontendMetadataUploadTarget) return;
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		const input = source instanceof File ? null : source.currentTarget as HTMLInputElement;
		const file = source instanceof File ? source : input?.files?.[0];
		if (!file) return;
		const token = getAuthToken();
		if (!token) {
			frontendMetadataError = 'Authentication required to upload branding assets.';
			if (input) input.value = '';
			return;
		}
		frontendMetadataUploadTarget = target;
		frontendMetadataError = '';
		frontendMetadataSaveStatus = '';
		const upload = new AbortController();
		brandingUpload = upload;
		try {
			const fileUrl = await uploadAdminBrandingAsset({
				server: getServerUrl(), token, file, signal: upload.signal,
				request: (url, options) => fetchWithTimeout(url, { ...options, timeoutMs: 60_000 })
			});
			if (!isCurrent()) return;
			if (target === 'icon') {
				frontendAppMetadata = { ...frontendAppMetadata, iconUrl: fileUrl };
			} else {
				frontendAppMetadata = { ...frontendAppMetadata, bannerUrl: fileUrl };
			}
			frontendMetadataSaveStatus = `${target === 'icon' ? 'Icon' : 'Banner'} uploaded to the draft. Publish changes to make it visible.`;
		} catch (error) {
			if (!isCurrent()) return;
			frontendMetadataError = (error as Error).message || `Failed to upload ${target}.`;
		} finally {
			if (brandingUpload === upload) brandingUpload = null;
			if (!isCurrent()) return;
			frontendMetadataUploadTarget = null;
			if (input) input.value = '';
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
		if (paymentPolicyLoading || paymentPolicySaving || paymentPolicyDirty) return;
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
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
			if (!isCurrent()) return;
			const loadedPolicy = readAdminPaymentPolicy(policy);
			paymentPolicy = cloneAdminPaymentPolicy(loadedPolicy);
			publishedPaymentPolicy = cloneAdminPaymentPolicy(loadedPolicy);
			paymentUserBlocks = blocks;
			paymentBlocksLoaded = true;
			paymentPolicyLoaded = true;
		} catch (error) {
			if (!isCurrent()) return;
			paymentPolicyError = (error as Error).message || 'Failed to load payment controls';
		} finally {
			if (!isCurrent()) return;
			paymentPolicyLoading = false;
		}
	}

	async function refreshUserPaymentBlocks() {
		const token = getAuthToken();
		if (!token || !canManageRoles) return;
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		paymentBlocksAttempted = true;
		paymentPolicyLoading = true;
		paymentPolicyError = '';
		try {
			const blocks = await getAdminPaymentUserBlocks(token);
			if (!isCurrent()) return;
			paymentUserBlocks = blocks;
			paymentBlocksLoaded = true;
		} catch {
			if (isCurrent()) paymentPolicyError = 'Payment restrictions could not be loaded.';
		} finally {
			if (isCurrent()) paymentPolicyLoading = false;
		}
	}

	async function savePaymentPolicy() {
		if (!canSaveAdminPaymentPolicy({ loaded: paymentPolicyLoaded, loading: paymentPolicyLoading, saving: paymentPolicySaving, draft: paymentPolicy, published: publishedPaymentPolicy })) return;
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		const token = getAuthToken();
		if (!token) return;
		paymentPolicySaving = true;
		paymentPolicyError = '';
		paymentPolicySaveStatus = '';
		try {
			const saved = await saveAdminPaymentAccessPolicy(token, cloneAdminPaymentPolicy(paymentPolicy));
			if (!isCurrent()) return;
			const savedPolicy = readAdminPaymentPolicy(saved);
			paymentPolicy = cloneAdminPaymentPolicy(savedPolicy);
			publishedPaymentPolicy = cloneAdminPaymentPolicy(savedPolicy);
			paymentPolicySaveStatus = 'Saved payment access policy.';
		} catch (error) {
			if (!isCurrent()) return;
			paymentPolicyError = (error as Error).message || 'Failed to save payment policy';
		} finally {
			if (!isCurrent()) return;
			paymentPolicySaving = false;
		}
	}

	function changePaymentPolicy(next: PaymentAccessPolicy) {
		if (!paymentPolicyLoaded || paymentPolicyLoading || paymentPolicySaving) return;
		paymentPolicy = cloneAdminPaymentPolicy(next);
		paymentPolicySaveStatus = '';
		paymentPolicyError = '';
	}

	function discardPaymentPolicy() {
		if (!publishedPaymentPolicy || paymentPolicyLoading || paymentPolicySaving) return;
		paymentPolicy = cloneAdminPaymentPolicy(publishedPaymentPolicy);
		paymentPolicySaveStatus = '';
		paymentPolicyError = '';
	}

	async function toggleUserPaymentBlock(user: User) {
		const isCurrent = captureAdminWork();
		if (!isCurrent()) return;
		if (!user.dbUserId || !canManageTargetUser(user) || !paymentBlocksLoaded || paymentBlockBusyUserId !== null) return;
		const token = getAuthToken();
		if (!token) return;
		paymentBlockBusyUserId = user.dbUserId;
		paymentPolicyError = '';
		paymentPolicySaveStatus = '';
		try {
			if (isUserPaymentBlocked(user)) {
				await clearAdminPaymentUserBlock(token, user.dbUserId);
				if (!isCurrent()) return;
				paymentPolicySaveStatus = `Unblocked payments for ${user.username}.`;
			} else {
				await setAdminPaymentUserBlock(token, user.dbUserId, { reason: 'Blocked by admin policy' });
				if (!isCurrent()) return;
				paymentPolicySaveStatus = `Blocked payments for ${user.username}.`;
			}
			const blocks = await getAdminPaymentUserBlocks(token);
			if (!isCurrent()) return;
			paymentUserBlocks = blocks;
		} catch (error) {
			if (!isCurrent()) return;
			paymentPolicyError = (error as Error).message || 'Failed to update payment block';
		} finally {
			if (!isCurrent()) return;
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
			badgeMutation.reconcile();
		});
		const unsubscribeBadgeSocket = socketState.subscribe(() => badgeMutation.reconcile());
		const unsubscribeBadgeAuth = onAuthSessionCleared(() => badgeMutation.reconcile());
		return () => {
			disposed = true;
			brandingUpload?.abort();
			userMessaging.dispose();
			badgeMutation.dispose();
			unsubscribeBadgeSocket();
			unsubscribeBadgeAuth();
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
				onOpenPeople={() => openAdminSection('users')}
			/>

			<ChannelAccessPanel
				{customChannels}
				onOpenChannel={openAdminChannel}
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
				onPolicyChange={changePaymentPolicy}
				onRefresh={refreshPaymentControls}
				onSave={savePaymentPolicy}
				{publishedPaymentPolicy}
				{paymentPolicyLoaded}
				{rolesLoading}
				{rolesError}
				onRoleRetry={roleCatalog.refresh}
				onDiscard={discardPaymentPolicy}
				onOpenPeople={() => openAdminSection('users')}
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
				{frontendMetadataLoaded}
				onRefresh={refreshFrontendMetadata}
		/>
	{/if}

	{#if roleActionError}<p role="alert">{roleActionError}</p>{/if}
	{#if roleActionStatus}<p role="status">{roleActionStatus}</p>{/if}
	{#if messageActionError}<p role="alert">{messageActionError}</p>{/if}
	<AdminUserList
			{badgeMutationState}
			badgeControlsOnline={$connected}
			{messagePendingUserId}
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
			paymentControlsReady={paymentBlocksLoaded && !paymentPolicyLoading}
				badgeCatalog={$badgeCatalog}
			onAssignBadge={handleAssignBadge}
			onRemoveBadge={handleRemoveBadge}
			onSearchInput={(v) => searchQuery = v}
			onMessage={handleMessage}
			onResetPassword={openPasswordReset}
			onUserRoleChange={setUserRoleLevel}
			onTogglePaymentBlock={toggleUserPaymentBlock}
		/>
	</div>
{:else if section === 'users'}
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
	{#if roleActionError}<p role="alert">{roleActionError}</p>{/if}
	{#if roleActionStatus}<p role="status">{roleActionStatus}</p>{/if}
	{#if messageActionError}<p role="alert">{messageActionError}</p>{/if}
	{#if paymentPolicyError}<p role="alert">{paymentPolicyError} <button type="button" onclick={refreshUserPaymentBlocks} disabled={paymentPolicyLoading}>Retry payment restrictions</button></p>{/if}
	{#if paymentPolicySaveStatus}<p role="status">{paymentPolicySaveStatus}</p>{/if}
	<AdminUserList
		{badgeMutationState}
		badgeControlsOnline={$connected}
		{messagePendingUserId}
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
		paymentControlsReady={paymentBlocksLoaded && !paymentPolicyLoading}
		badgeCatalog={$badgeCatalog}
		onAssignBadge={handleAssignBadge}
		onRemoveBadge={handleRemoveBadge}
		onSearchInput={(v) => searchQuery = v}
		onMessage={handleMessage}
		onResetPassword={openPasswordReset}
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
			onOpenPeople={() => openAdminSection('users')}
		/>
	{/if}
{:else if section === 'channels'}
	{#if canManageRoles}
		<ChannelAccessPanel
			{customChannels}
			onOpenChannel={openAdminChannel}
		/>
	{/if}
{:else if section === 'gates'}
	{#if canManageRoles}
		<RoleGatesUnavailable />
	{/if}
{:else if section === 'payments'}
	{#if canManageRoles}
		<PaymentAccessPanel
			{paymentPolicy}
			{paymentUserBlocks}
			{paymentPolicyLoading}
			{paymentPolicySaving}
			{paymentPolicyError}
			{paymentPolicySaveStatus}
			roleDefinitions={roleDefinitions}
			{getRoleLabel}
			onPolicyChange={changePaymentPolicy}
			onRefresh={refreshPaymentControls}
			onSave={savePaymentPolicy}
			{publishedPaymentPolicy}
			{paymentPolicyLoaded}
			{rolesLoading}
			{rolesError}
			onRoleRetry={roleCatalog.refresh}
			onDiscard={discardPaymentPolicy}
			onOpenPeople={() => openAdminSection('users')}
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
			{frontendMetadataLoaded}
			onRefresh={refreshFrontendMetadata}
		/>
	{/if}

{/if}

{#if passwordResetTarget && canManageTargetUser(passwordResetTarget)}
	<AdminPasswordReset user={passwordResetTarget} {canManageTargetUser} onClose={() => passwordResetTarget = null} />
{/if}
