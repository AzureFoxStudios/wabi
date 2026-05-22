<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
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
	import { subscribePaymentRealtimeEvent } from '$lib/payments/paymentRealtime';
	import {
		formatMinorAmount as formatPaymentMinorAmount,
		minorToMajorInput as minorAmountToInput,
		parseMajorAmountInput as parsePaymentMajorAmount
	} from '$lib/payments/paymentAmounts';
	import {
		approveAdminRelay,
		deleteAdminRelay,
		createAdminOfflineDonation,
		adminClearUserLoginLockout,
		getAdminCommunityNodeAccessPolicy,
		getAdminCommunityNodeAnnouncementsPolicy,
		getAdminPaymentDonationConfig,
		listAdminPaymentDonationAudit,
		listAdminRelays,
		listAdminOfflineDonations,
		listPaymentProviders,
		adminResetUserPassword,
		getAdminUploadLimits,
		refundAdminPaymentDonation,
		saveAdminCommunityNodeAccessPolicy,
		saveAdminPaymentDonationConfig,
		saveAdminCommunityNodeAnnouncementsPolicy,
		saveAdminUploadLimits,
		voidAdminOfflineDonation,
		type AdminRelayNode,
		type CommunityNodeAccessPolicy,
		type CommunityNodeAllowedUser,
		type CommunityNodeAnnouncementsPolicy,
		type OfflineDonationLedgerEntry,
		type PaymentDonationConfig,
		type PaymentDonationLedgerEntry,
		type PaymentMethodCapability,
		type PaymentProviderCapability,
		type UploadLimitConfig,
		type UploadRoleTier
	} from '$lib/api';
	import UploadLimitsPanel from './admin/UploadLimitsPanel.svelte';
	import DonationConfig from './admin/DonationConfig.svelte';
	import OfflineDonations from './admin/OfflineDonations.svelte';
	import CommunityNodes from './admin/CommunityNodes.svelte';
	import AdminUserList from './admin/AdminUserList.svelte';

	const dispatch = createEventDispatcher<{ openServerDonation: void }>();
	const MB = 1024 * 1024;
	const uploadRoleOrder: UploadRoleTier[] = ['new', 'trusted', 'moderator', 'admin', 'owner'];
	const uploadRoleLabels: Record<UploadRoleTier, string> = {
		new: 'New',
		trusted: 'Trusted',
		moderator: 'Moderator',
		admin: 'Admin',
		owner: 'Owner'
	};
	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};

	let adminDonationConfigLoaded = false;
	let adminDonationConfigLoading = false;
	let adminDonationConfigSaving = false;
	let adminDonationAuditLoaded = false;
	let adminDonationAuditLoading = false;
	let adminDonationRefundingIntentId = '';
	let adminDonationAudit: PaymentDonationLedgerEntry[] = [];
	let adminRelayRosterLoaded = false;
	let adminRelayRosterLoading = false;
	let adminRelayApproveBusyId: number | null = null;
	let adminRelayDeleteBusyId: number | null = null;
	let adminRelayRoster: AdminRelayNode[] = [];
	let communityNodeAccessLoaded = false;
	let communityNodeAccessLoading = false;
	let communityNodeAccessSaving = false;
	let communityNodeAccessStatus = '';
	let communityNodeWhitelistSelectedUserId = '';
	let communityNodeWhitelistUsernameInput = '';
	let communityNodeWhitelistPendingUsernames: string[] = [];
	let communityNodeAccess: CommunityNodeAccessPolicy = { mode: 'open', allowedUsers: [] };
	let communityNodeAnnouncementsLoaded = false;
	let communityNodeAnnouncementsLoading = false;
	let communityNodeAnnouncementsSaving = false;
	let communityNodeAnnouncementsStatus = '';
	let communityNodeAnnouncements: CommunityNodeAnnouncementsPolicy = {
		enabled: false,
		channelId: null,
		onlineTemplate: '[{node}] is now online and helping this server. Thank you, {user}.',
		offlineTemplate: '[{node}] went offline.'
	};
	let adminOfflineDonationAuditLoaded = false;
	let adminOfflineDonationAuditLoading = false;
	let adminOfflineDonationSaving = false;
	let adminOfflineDonationVoidingSettlementId = '';
	let adminOfflineDonationAudit: OfflineDonationLedgerEntry[] = [];
	let offlineDonationAmountInput = '10.00';
	let offlineDonationCurrency = 'USD';
	let offlineDonationDonorLabel = '';
	let offlineDonationDescription = '';
	let adminDonationConfig: PaymentDonationConfig = {
		enabled: false,
		providerPluginId: null,
		methodId: null,
		currency: 'USD',
		countryCode: null,
		suggestedAmountsMinor: [500, 1000, 2500],
		headline: 'Support This Server',
		description: 'Contribute to server hosting and maintenance.'
	};
	let donationSuggestedAmountsInput = '5, 10, 25';
	let paymentProviderCapabilities: PaymentProviderCapability[] = [];
	let paymentProviderCapabilitiesLoaded = false;
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
		(user) =>
			typeof user.dbUserId === 'number' &&
			!communityNodeAccess.allowedUsers.some((entry) => entry.userId === user.dbUserId)
	);
	$: adminDonationSelectedProvider =
		paymentProviderCapabilities.find((provider) => provider.pluginId === adminDonationConfig.providerPluginId) || null;
	$: adminDonationMethods = adminDonationSelectedProvider?.methods || [];
	$: adminDonationSelectedMethod =
		adminDonationMethods.find((method) => method.id === adminDonationConfig.methodId) || null;
	$: adminDonationCurrencyOptions = getDonationRouteOptions(
		adminDonationSelectedProvider?.currencies || [],
		adminDonationSelectedMethod?.currencies || []
	);
	$: adminDonationCountryOptions = getDonationRouteOptions(
		adminDonationSelectedProvider?.countries || [],
		adminDonationSelectedMethod?.countries || []
	);
	$: donationRoutePreviewReady = Boolean(
		adminDonationConfig.enabled &&
		adminDonationConfig.providerPluginId &&
		adminDonationConfig.methodId
	);
	$: if (adminDonationSelectedProvider || adminDonationConfig.providerPluginId === null) {
		reconcileAdminDonationRouteSelection();
	}
	$: if (canManageAdmin && !uploadLimitsLoaded && !loadingUploadLimits) void loadUploadLimits();
	$: if (canManageAdmin && !adminDonationConfigLoaded) void loadAdminDonationConfig();
	$: if (canManageAdmin && !adminDonationAuditLoaded) void loadAdminDonationAudit();
	$: if (canManageAdmin && !adminRelayRosterLoaded) void loadAdminRelayRoster();
	$: if (canManageAdmin && !communityNodeAccessLoaded) void loadCommunityNodeAccessPolicy();
	$: if (canManageAdmin && !communityNodeAnnouncementsLoaded) void loadCommunityNodeAnnouncementsPolicy();
	$: if (canManageAdmin && !adminOfflineDonationAuditLoaded) void loadAdminOfflineDonationAudit();

	onMount(() => {
		const unsubscribeDonationRealtime = subscribePaymentRealtimeEvent('payments:donations-admin-updated', () => {
			if (!canManageAdmin) return;
			adminDonationAuditLoaded = false;
			adminOfflineDonationAuditLoaded = false;
			void loadAdminDonationAudit();
			void loadAdminOfflineDonationAudit();
		});
		const unsubscribeAccessRealtime = subscribePaymentRealtimeEvent('payments:access-updated', () => {
			if (!canManageAdmin) return;
			adminDonationConfigLoaded = false;
			void loadAdminDonationConfig();
		});
		return () => {
			unsubscribeDonationRealtime();
			unsubscribeAccessRealtime();
		};
	});

	function openServerDonation(): void {
		dispatch('openServerDonation');
	}

	function bytesToMbInput(bytes: number | null): string {
		if (bytes === null) return '';
		const mb = Math.floor(bytes / MB);
		return mb > 0 ? String(mb) : '1';
	}

	function syncUploadLimitInputsFromConfig(config: UploadLimitConfig) {
		uploadLimitConfig = config;
		uploadLimitInputs = {
			new: bytesToMbInput(config.perRoleBytes.new),
			trusted: bytesToMbInput(config.perRoleBytes.trusted),
			moderator: bytesToMbInput(config.perRoleBytes.moderator),
			admin: bytesToMbInput(config.perRoleBytes.admin),
			owner: bytesToMbInput(config.perRoleBytes.owner)
		};
		globalUploadLimitInput = bytesToMbInput(config.globalUploadCapBytes);
	}

	function parseMbInput(value: string): number | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const mb = Number(trimmed);
		if (!Number.isFinite(mb) || mb <= 0) {
			throw new Error('Limits must be positive MB values or blank for unlimited.');
		}
		return Math.floor(mb * MB);
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

	function userHasRole(user: { roles?: string[]; highestRole?: string }, role: 'admin' | 'mod' | 'owner'): boolean {
		return user.highestRole === role || (user.roles || []).includes(role);
	}

	function isProtectedOwner(user: { highestRole?: string }): boolean {
		return user.highestRole === 'owner';
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

	function minorToMajorInput(amountMinor: number, currency = adminDonationConfig.currency || 'USD'): string {
		return minorAmountToInput(amountMinor, currency);
	}

	function formatDonationAuditAmount(amountMinor: number, currency: string): string {
		return formatPaymentMinorAmount(amountMinor, currency);
	}

	function formatDonationAuditWhen(entry: PaymentDonationLedgerEntry | OfflineDonationLedgerEntry): string {
		const timestamp = 'refundedAt' in entry
			? entry.refundedAt || entry.completedAt || entry.createdAt
			: entry.voidedAt || entry.completedAt || entry.createdAt;
		if (!timestamp || !Number.isFinite(timestamp)) return 'n/a';
		return new Date(timestamp).toLocaleString();
	}

	function parseSuggestedAmountsInput(value: string): number[] {
		return value
			.split(',')
			.map((entry) => parsePaymentMajorAmount(entry.trim(), adminDonationConfig.currency || 'USD'))
			.filter((amount) => Number.isFinite(amount) && amount > 0);
	}

	function parseMajorAmountInput(value: string, currency = adminDonationConfig.currency || 'USD'): number {
		return parsePaymentMajorAmount(value, currency);
	}

	function normalizeDonationRouteOptionValues(values: string[]): string[] {
		const seen = new Set<string>();
		const normalized: string[] = [];
		for (const value of values) {
			const upper = String(value || '').trim().toUpperCase();
			if (!upper || seen.has(upper)) continue;
			seen.add(upper);
			normalized.push(upper);
		}
		return normalized;
	}

	function getDonationRouteOptions(providerValues: string[], methodValues: string[]): string[] {
		const providerOptions = normalizeDonationRouteOptionValues(providerValues);
		const methodOptions = normalizeDonationRouteOptionValues(methodValues);
		if (providerOptions.length === 0) return methodOptions;
		if (methodOptions.length === 0) return providerOptions;
		const intersection = providerOptions.filter((value) => methodOptions.includes(value));
		return intersection.length > 0 ? intersection : providerOptions;
	}

	function getDonationRouteSummaryList(values: number[]): string {
		if (values.length === 0) return 'No suggested amounts';
		return values.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD')).join(', ');
	}

	function reconcileAdminDonationRouteSelection(): void {
		let nextConfig = adminDonationConfig;
		let changed = false;
		if (!adminDonationSelectedProvider) {
			if (adminDonationConfig.methodId !== null) {
				nextConfig = { ...nextConfig, methodId: null };
				changed = true;
			}
			if (changed) adminDonationConfig = nextConfig;
			return;
		}
		const nextMethodId = adminDonationMethods.some((method) => method.id === nextConfig.methodId)
			? nextConfig.methodId
			: (adminDonationMethods[0]?.id || null);
		if (nextMethodId !== nextConfig.methodId) {
			nextConfig = { ...nextConfig, methodId: nextMethodId };
			changed = true;
		}
		const selectedMethod: PaymentMethodCapability | null =
			adminDonationMethods.find((method) => method.id === nextConfig.methodId) || null;
		const nextCurrencyOptions = getDonationRouteOptions(adminDonationSelectedProvider.currencies, selectedMethod?.currencies || []);
		const normalizedCurrency = String(nextConfig.currency || '').trim().toUpperCase();
		const nextCurrency = nextCurrencyOptions.length > 0
			? (nextCurrencyOptions.includes(normalizedCurrency) ? normalizedCurrency : nextCurrencyOptions[0])
			: (normalizedCurrency || 'USD');
		if (nextCurrency !== nextConfig.currency) {
			nextConfig = { ...nextConfig, currency: nextCurrency };
			changed = true;
		}
		const nextCountryOptions = getDonationRouteOptions(adminDonationSelectedProvider.countries, selectedMethod?.countries || []);
		const normalizedCountry = String(nextConfig.countryCode || '').trim().toUpperCase();
		const nextCountryCode = nextCountryOptions.length > 0
			? (nextCountryOptions.includes(normalizedCountry) ? normalizedCountry : nextCountryOptions[0])
			: (normalizedCountry || null);
		if (nextCountryCode !== nextConfig.countryCode) {
			nextConfig = { ...nextConfig, countryCode: nextCountryCode };
			changed = true;
		}
		if (changed) adminDonationConfig = nextConfig;
	}

	function normalizeAdminDonationMethodSelection(): void {
		if (!adminDonationConfig.providerPluginId) {
			if (adminDonationConfig.methodId !== null) adminDonationConfig = { ...adminDonationConfig, methodId: null };
			return;
		}
		const selectedProvider = paymentProviderCapabilities.find((provider) => provider.pluginId === adminDonationConfig.providerPluginId) || null;
		const methods = selectedProvider?.methods || [];
		const currentMethodValid = methods.some((method) => method.id === adminDonationConfig.methodId);
		const nextMethodId = currentMethodValid ? adminDonationConfig.methodId : (methods[0]?.id || null);
		if (nextMethodId !== adminDonationConfig.methodId) adminDonationConfig = { ...adminDonationConfig, methodId: nextMethodId };
	}

	async function loadPaymentProviderCapabilities(): Promise<void> {
		if (paymentProviderCapabilitiesLoaded) return;
		try {
			paymentProviderCapabilities = await listPaymentProviders();
			paymentProviderCapabilitiesLoaded = true;
			normalizeAdminDonationMethodSelection();
		} catch (error) {
			console.error('[Payments] Failed to load provider capabilities for settings:', error);
		}
	}

	async function loadAdminDonationConfig(): Promise<void> {
		if (adminDonationConfigLoaded || adminDonationConfigLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminDonationConfigLoading = true;
		try {
			adminDonationConfig = await getAdminPaymentDonationConfig(token);
			donationSuggestedAmountsInput = adminDonationConfig.suggestedAmountsMinor
				.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD'))
				.join(', ');
			offlineDonationCurrency = adminDonationConfig.currency || offlineDonationCurrency;
			adminDonationConfigLoaded = true;
			await loadPaymentProviderCapabilities();
			normalizeAdminDonationMethodSelection();
		} catch (error) {
			console.error('[Payments] Failed to load donation config:', error);
		} finally {
			adminDonationConfigLoading = false;
		}
	}

	async function loadAdminDonationAudit(): Promise<void> {
		if (adminDonationAuditLoaded || adminDonationAuditLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminDonationAuditLoading = true;
		try {
			const response = await listAdminPaymentDonationAudit(token, 100);
			adminDonationAudit = response.donations;
			adminDonationAuditLoaded = true;
		} catch (error) {
			console.error('[Payments] Failed to load donation audit trail:', error);
		} finally {
			adminDonationAuditLoading = false;
		}
	}

	function getAdminRelayKindLabel(relay: AdminRelayNode): string {
		const kind = relay.metadata?.kind;
		if (kind === 'booster-relay') return 'Booster Relay';
		if (kind === 'desktop-helper') return 'Desktop Helper';
		if (relay.metadata?.capabilities?.selfHosted) return 'Self-Hosted Node';
		return 'Relay Node';
	}

	function getAdminRelayCapabilitiesSummary(relay: AdminRelayNode): string {
		const capabilities = relay.metadata?.capabilities;
		if (!capabilities) return 'No capabilities advertised';
		const labels: string[] = [];
		if (capabilities.fileRelay) labels.push('Files');
		if (capabilities.turn) labels.push('TURN');
		if (capabilities.sfu) labels.push('SFU');
		if (capabilities.gateway) labels.push('Gateway');
		return labels.length > 0 ? labels.join(' / ') : 'No capabilities advertised';
	}

	function formatRelaySeenAt(unixSeconds: number | null): string {
		if (!unixSeconds) return 'Never';
		try {
			return new Date(unixSeconds * 1000).toLocaleString();
		} catch {
			return 'Unknown';
		}
	}

	function getAdminRelayOwnerLabel(relay: AdminRelayNode): string | null {
		return relay.metadata?.ownerUsername ? 'Owner: ' + relay.metadata.ownerUsername : null;
	}

	async function loadAdminRelayRoster(): Promise<void> {
		if (adminRelayRosterLoaded || adminRelayRosterLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminRelayRosterLoading = true;
		try {
			const relays = await listAdminRelays(token);
			adminRelayRoster = relays.sort((a, b) => {
				const statusOrder = (value: string) =>
					value === 'active' ? 0 : value === 'degraded' ? 1 : value === 'pending' ? 2 : value === 'offline' ? 3 : 4;
				return statusOrder(a.status) - statusOrder(b.status) || a.name.localeCompare(b.name);
			});
			adminRelayRosterLoaded = true;
		} catch (error) {
			console.error('[Relay] Failed to load admin relay roster:', error);
		} finally {
			adminRelayRosterLoading = false;
		}
	}

	async function loadCommunityNodeAnnouncementsPolicy(): Promise<void> {
		if (communityNodeAnnouncementsLoaded || communityNodeAnnouncementsLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		communityNodeAnnouncementsLoading = true;
		try {
			communityNodeAnnouncements = await getAdminCommunityNodeAnnouncementsPolicy(token);
			communityNodeAnnouncementsLoaded = true;
			communityNodeAnnouncementsStatus = '';
		} catch (error) {
			console.error('[CommunityNodes] Failed to load announcement policy:', error);
			communityNodeAnnouncementsStatus = error instanceof Error ? error.message : 'Failed to load node announcement settings.';
		} finally {
			communityNodeAnnouncementsLoading = false;
		}
	}

	async function loadCommunityNodeAccessPolicy(): Promise<void> {
		if (communityNodeAccessLoaded || communityNodeAccessLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		communityNodeAccessLoading = true;
		try {
			communityNodeAccess = await getAdminCommunityNodeAccessPolicy(token);
			communityNodeAccessLoaded = true;
			communityNodeAccessStatus = '';
		} catch (error) {
			console.error('[CommunityNodes] Failed to load access policy:', error);
			communityNodeAccessStatus = error instanceof Error ? error.message : 'Failed to load community node access policy.';
		} finally {
			communityNodeAccessLoading = false;
		}
	}

	function addCommunityNodeWhitelistEntry(entry: CommunityNodeAllowedUser): void {
		if (communityNodeAccess.allowedUsers.some((item) => item.userId === entry.userId)) return;
		communityNodeAccess = {
			...communityNodeAccess,
			allowedUsers: [...communityNodeAccess.allowedUsers, entry].sort((a, b) => a.username.localeCompare(b.username))
		};
	}

	function addSelectedCommunityNodeWhitelistUser(): void {
		const numericId = Number(communityNodeWhitelistSelectedUserId);
		if (!Number.isFinite(numericId)) return;
		const user = communityNodeWhitelistCandidates.find((entry) => entry.dbUserId === numericId);
		if (!user?.dbUserId) return;
		addCommunityNodeWhitelistEntry({ userId: user.dbUserId, username: user.username });
		communityNodeWhitelistSelectedUserId = '';
	}

	function addTypedCommunityNodeWhitelistUser(): void {
		const username = communityNodeWhitelistUsernameInput.trim();
		if (!username) return;
		if (communityNodeAccess.allowedUsers.some((entry) => entry.username.toLowerCase() === username.toLowerCase())) {
			communityNodeWhitelistUsernameInput = '';
			return;
		}
		if (!communityNodeWhitelistPendingUsernames.some((entry) => entry.toLowerCase() === username.toLowerCase())) {
			communityNodeWhitelistPendingUsernames = [...communityNodeWhitelistPendingUsernames, username].sort((a, b) => a.localeCompare(b));
		}
		communityNodeWhitelistUsernameInput = '';
	}

	function removeCommunityNodeWhitelistUser(userId: number): void {
		communityNodeAccess = {
			...communityNodeAccess,
			allowedUsers: communityNodeAccess.allowedUsers.filter((entry) => entry.userId !== userId)
		};
	}

	function removePendingCommunityNodeWhitelistUsername(username: string): void {
		communityNodeWhitelistPendingUsernames = communityNodeWhitelistPendingUsernames.filter((entry) => entry !== username);
	}

	async function saveCommunityNodeAccess(): Promise<void> {
		if (!canManageAdmin || communityNodeAccessSaving) return;
		const token = getAuthToken();
		if (!token) return;
		communityNodeAccessSaving = true;
		try {
			const payload = { ...communityNodeAccess, allowedUsers: [...communityNodeAccess.allowedUsers, ...communityNodeWhitelistPendingUsernames] };
			communityNodeAccess = await saveAdminCommunityNodeAccessPolicy(token, payload as unknown as CommunityNodeAccessPolicy);
			communityNodeWhitelistPendingUsernames = [];
			communityNodeAccessLoaded = true;
			communityNodeAccessStatus = 'Community node access policy saved.';
		} catch (error) {
			communityNodeAccessStatus = error instanceof Error ? error.message : 'Failed to save community node access policy.';
		} finally {
			communityNodeAccessSaving = false;
		}
	}

	async function saveCommunityNodeAnnouncements(): Promise<void> {
		if (!canManageAdmin || communityNodeAnnouncementsSaving) return;
		const token = getAuthToken();
		if (!token) return;
		if (communityNodeAnnouncements.enabled && !communityNodeAnnouncements.channelId) {
			communityNodeAnnouncementsStatus = 'Pick a channel before enabling community node announcements.';
			return;
		}
		communityNodeAnnouncementsSaving = true;
		try {
			communityNodeAnnouncements = await saveAdminCommunityNodeAnnouncementsPolicy(token, communityNodeAnnouncements);
			communityNodeAnnouncementsLoaded = true;
			communityNodeAnnouncementsStatus = 'Community node announcement settings saved.';
		} catch (error) {
			communityNodeAnnouncementsStatus = error instanceof Error ? error.message : 'Failed to save node announcement settings.';
		} finally {
			communityNodeAnnouncementsSaving = false;
		}
	}

	async function approveRelayNode(relay: AdminRelayNode): Promise<void> {
		if (!canManageAdmin || adminRelayApproveBusyId !== null) return;
		const token = getAuthToken();
		if (!token) return;
		adminRelayApproveBusyId = relay.relay_id;
		try {
			await approveAdminRelay(token, relay.relay_id);
			adminRelayRosterLoaded = false;
			await loadAdminRelayRoster();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to approve relay node');
		} finally {
			adminRelayApproveBusyId = null;
		}
	}

	async function deleteRelayNode(relay: AdminRelayNode): Promise<void> {
		if (!canManageAdmin || adminRelayDeleteBusyId !== null) return;
		const token = getAuthToken();
		if (!token) return;
		if (!confirm(`Delete node "${relay.name}" from the server roster?`)) return;
		adminRelayDeleteBusyId = relay.relay_id;
		try {
			await deleteAdminRelay(token, relay.relay_id);
			adminRelayRoster = adminRelayRoster.filter((entry) => entry.relay_id !== relay.relay_id);
			adminRelayRosterLoaded = true;
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to delete relay node');
		} finally {
			adminRelayDeleteBusyId = null;
		}
	}

	async function loadAdminOfflineDonationAudit(): Promise<void> {
		if (adminOfflineDonationAuditLoaded || adminOfflineDonationAuditLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminOfflineDonationAuditLoading = true;
		try {
			const response = await listAdminOfflineDonations(token, 100);
			adminOfflineDonationAudit = response.donations;
			adminOfflineDonationAuditLoaded = true;
		} catch (error) {
			console.error('[Payments] Failed to load offline donation audit trail:', error);
		} finally {
			adminOfflineDonationAuditLoading = false;
		}
	}

	async function saveDonationConfig(): Promise<void> {
		if (adminDonationConfigSaving) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const nextConfig: PaymentDonationConfig = {
			...adminDonationConfig,
			suggestedAmountsMinor: parseSuggestedAmountsInput(donationSuggestedAmountsInput)
		};
		adminDonationConfigSaving = true;
		try {
			adminDonationConfig = await saveAdminPaymentDonationConfig(token, nextConfig);
			donationSuggestedAmountsInput = adminDonationConfig.suggestedAmountsMinor
				.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD'))
				.join(', ');
			alert('Donation settings saved.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to save donation settings.');
		} finally {
			adminDonationConfigSaving = false;
		}
	}

	async function createOfflineDonationRecord(): Promise<void> {
		if (adminOfflineDonationSaving) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const amountMinor = parseMajorAmountInput(offlineDonationAmountInput, offlineDonationCurrency);
		if (amountMinor <= 0) {
			alert('Enter a valid offline donation amount.');
			return;
		}
		const currency = offlineDonationCurrency.trim().toUpperCase();
		if (!/^[A-Z]{3}$/.test(currency)) {
			alert('Enter a valid 3-letter currency code.');
			return;
		}
		adminOfflineDonationSaving = true;
		try {
			const donation = await createAdminOfflineDonation(token, {
				amountMinor,
				currency,
				donorLabel: offlineDonationDonorLabel.trim() || undefined,
				description: offlineDonationDescription.trim() || undefined,
				metadata: { source: 'settings_admin_manual_entry' }
			});
			adminOfflineDonationAudit = [donation, ...adminOfflineDonationAudit.filter((entry) => entry.settlementId !== donation.settlementId)];
			adminOfflineDonationAuditLoaded = true;
			offlineDonationAmountInput = minorToMajorInput(amountMinor, currency);
			offlineDonationCurrency = currency;
			offlineDonationDonorLabel = '';
			offlineDonationDescription = '';
			alert('Offline donation recorded.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to record offline donation.');
		} finally {
			adminOfflineDonationSaving = false;
		}
	}

	async function refundDonation(entry: PaymentDonationLedgerEntry): Promise<void> {
		if (!canManageAdmin || adminDonationRefundingIntentId || !entry.canRefund) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const reason = window.prompt(`Refund ${formatDonationAuditAmount(entry.amountMinor, entry.currency)} from ${entry.donorLabel}.`, 'Refund requested by donor');
		if (reason === null) return;
		const normalizedReason = reason.trim() || 'Refund requested by donor';
		const confirmed = window.confirm(`Issue a donation refund for ${entry.donorLabel}?\n\n${formatDonationAuditAmount(entry.amountMinor, entry.currency)}\nReason: ${normalizedReason}`);
		if (!confirmed) return;
		adminDonationRefundingIntentId = entry.intentId;
		try {
			await refundAdminPaymentDonation(token, entry.intentId, normalizedReason);
			adminDonationAuditLoaded = false;
			await loadAdminDonationAudit();
			alert('Donation refund submitted.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to refund donation.');
		} finally {
			adminDonationRefundingIntentId = '';
		}
	}

	async function voidOfflineDonation(entry: OfflineDonationLedgerEntry): Promise<void> {
		if (!canManageAdmin || adminOfflineDonationVoidingSettlementId || !entry.canVoid) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const reason = window.prompt(`Void offline donation from ${entry.donorLabel}?`, 'Recorded in error');
		if (reason === null) return;
		const normalizedReason = reason.trim() || 'Recorded in error';
		const confirmed = window.confirm(`Void offline donation for ${entry.donorLabel}?\n\n${formatDonationAuditAmount(entry.amountMinor, entry.currency)}\nReason: ${normalizedReason}`);
		if (!confirmed) return;
		adminOfflineDonationVoidingSettlementId = entry.settlementId;
		try {
			const updated = await voidAdminOfflineDonation(token, entry.settlementId, normalizedReason);
			adminOfflineDonationAudit = adminOfflineDonationAudit.map((item) => item.settlementId === entry.settlementId ? updated : item);
			alert('Offline donation voided.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to void offline donation.');
		} finally {
			adminOfflineDonationVoidingSettlementId = '';
		}
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

	<DonationConfig
		{adminDonationConfig}
		{canManageAdmin}
		{adminDonationConfigLoading}
		{adminDonationConfigSaving}
		{paymentProviderCapabilities}
		{donationSuggestedAmountsInput}
		{adminDonationSelectedProvider}
		{adminDonationMethods}
		{adminDonationSelectedMethod}
		{adminDonationCurrencyOptions}
		{adminDonationCountryOptions}
		{donationRoutePreviewReady}
		{adminDonationAudit}
		{adminDonationAuditLoading}
		{adminDonationAuditLoaded}
		{adminDonationRefundingIntentId}
		onConfigChange={(cfg) => adminDonationConfig = cfg}
		onDonationAmountsInput={(v) => donationSuggestedAmountsInput = v}
		onSaveDonationConfig={saveDonationConfig}
		onOpenServerDonation={openServerDonation}
		onRefreshAudit={() => { adminDonationAuditLoaded = false; void loadAdminDonationAudit(); }}
		onRefund={refundDonation}
		{formatDonationAuditAmount}
		{formatDonationAuditWhen}
		{getDonationRouteSummaryList}
		{parseSuggestedAmountsInput}
		{minorToMajorInput}
	/>

	<OfflineDonations
		{canManageAdmin}
		{adminOfflineDonationAudit}
		{adminOfflineDonationAuditLoading}
		{adminOfflineDonationAuditLoaded}
		{adminOfflineDonationVoidingSettlementId}
		{adminOfflineDonationSaving}
		{offlineDonationAmountInput}
		{offlineDonationCurrency}
		{offlineDonationDonorLabel}
		{offlineDonationDescription}
		onCreateOfflineDonation={createOfflineDonationRecord}
		onRefreshAudit={() => { adminOfflineDonationAuditLoaded = false; void loadAdminOfflineDonationAudit(); }}
		onVoid={voidOfflineDonation}
		onAmountInput={(v) => offlineDonationAmountInput = v}
		onCurrencyInput={(v) => offlineDonationCurrency = v}
		onDonorLabelInput={(v) => offlineDonationDonorLabel = v}
		onDescriptionInput={(v) => offlineDonationDescription = v}
		{formatDonationAuditAmount}
		{formatDonationAuditWhen}
	/>

	<CommunityNodes
		{canManageAdmin}
		{adminRelayRoster}
		{adminRelayRosterLoading}
		{adminRelayRosterLoaded}
		{adminRelayApproveBusyId}
		{adminRelayDeleteBusyId}
		{communityNodeAccess}
		{communityNodeAccessLoaded}
		{communityNodeAccessLoading}
		{communityNodeAccessSaving}
		{communityNodeAccessStatus}
		{communityNodeWhitelistSelectedUserId}
		{communityNodeWhitelistUsernameInput}
		{communityNodeWhitelistPendingUsernames}
		{communityNodeWhitelistCandidates}
		{communityNodeAnnouncements}
		{communityNodeAnnouncementsLoaded}
		{communityNodeAnnouncementsLoading}
		{communityNodeAnnouncementsSaving}
		{communityNodeAnnouncementsStatus}
		{communityAnnouncementChannelOptions}
		onRefreshRelayRoster={() => { adminRelayRosterLoaded = false; void loadAdminRelayRoster(); }}
		onApproveRelay={approveRelayNode}
		onDeleteRelay={deleteRelayNode}
		onSaveNodeAccess={saveCommunityNodeAccess}
		onSaveNodeAnnouncements={saveCommunityNodeAnnouncements}
		onAddSelectedWhitelistUser={addSelectedCommunityNodeWhitelistUser}
		onAddTypedWhitelistUser={addTypedCommunityNodeWhitelistUser}
		onRemoveWhitelistUser={removeCommunityNodeWhitelistUser}
		onRemovePendingWhitelistUsername={removePendingCommunityNodeWhitelistUsername}
		onAccessModeChange={(mode) => communityNodeAccess = { ...communityNodeAccess, mode: mode as typeof communityNodeAccess.mode }}
		onWhitelistSelectedUserIdChange={(id) => communityNodeWhitelistSelectedUserId = id}
		onWhitelistUsernameInput={(v) => communityNodeWhitelistUsernameInput = v}
		onAnnouncementsEnabledChange={(enabled) => communityNodeAnnouncements = { ...communityNodeAnnouncements, enabled }}
		onAnnouncementsChannelIdChange={(id) => communityNodeAnnouncements = { ...communityNodeAnnouncements, channelId: id }}
		onAnnouncementsOnlineTemplateChange={(v) => communityNodeAnnouncements = { ...communityNodeAnnouncements, onlineTemplate: v }}
		onAnnouncementsOfflineTemplateChange={(v) => communityNodeAnnouncements = { ...communityNodeAnnouncements, offlineTemplate: v }}
		{getAdminRelayKindLabel}
		{getAdminRelayCapabilitiesSummary}
		{formatRelaySeenAt}
		{getAdminRelayOwnerLabel}
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
