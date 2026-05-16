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
	<div class="upload-limits-panel">
		<h4>Upload Limits (MB)</h4>
		<p class="admin-help">Leave a field blank for unlimited. These limits are enforced on the backend.</p>
		<div class="upload-limit-grid">
			{#each uploadRoleOrder as tier}
				<label class="upload-limit-row">
					<span>{uploadRoleLabels[tier]}</span>
					<input
						type="number"
						min="1"
						step="1"
						placeholder="Unlimited"
						bind:value={uploadLimitInputs[tier]}
						disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}
					/>
				</label>
			{/each}
			<label class="upload-limit-row">
				<span>Global Cap</span>
				<input
					type="number"
					min="1"
					step="1"
					placeholder="Unlimited"
					bind:value={globalUploadLimitInput}
					disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}
				/>
			</label>
		</div>
		<button class="action-btn" on:click={saveUploadLimits} disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}>
			{savingUploadLimits ? 'Saving...' : 'Save Upload Limits'}
		</button>
	</div>
	<div class="upload-limits-panel">
		<h4>Server Donations</h4>
		<p class="admin-help">Configure a single server donation route. Users will see transparency totals and a donate flow based on this setup.</p>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Enable Donations</span>
				<span class="setting-description">Show the server donation entry and allow donation-tagged payment requests.</span>
			</div>
			<button
				class="toggle-btn"
				class:active={adminDonationConfig.enabled}
				on:click={() => adminDonationConfig = { ...adminDonationConfig, enabled: !adminDonationConfig.enabled }}
			>
				{adminDonationConfig.enabled ? 'ON' : 'OFF'}
			</button>
		</div>
		<div class="quality-mode-row">
			<label for="donation-provider-select">Donation Provider</label>
			<select
				id="donation-provider-select"
				class="theme-select"
				value={adminDonationConfig.providerPluginId || ''}
				on:change={(event) => {
					const providerPluginId = event.currentTarget.value || null;
					const selectedProvider = paymentProviderCapabilities.find((provider) => provider.pluginId === providerPluginId) || null;
					adminDonationConfig = {
						...adminDonationConfig,
						providerPluginId,
						methodId: selectedProvider?.methods[0]?.id || null
					};
				}}
			>
				<option value="">Select provider</option>
				{#each paymentProviderCapabilities as provider}
					<option value={provider.pluginId}>{provider.providerName} ({provider.pluginId})</option>
				{/each}
			</select>
		</div>
		<div class="quality-mode-row">
			<label for="donation-method-select">Donation Method</label>
			<select
				id="donation-method-select"
				class="theme-select"
				value={adminDonationConfig.methodId || ''}
				on:change={(event) => adminDonationConfig = { ...adminDonationConfig, methodId: event.currentTarget.value || null }}
			>
				<option value="">Select method</option>
				{#each adminDonationMethods as method}
					<option value={method.id}>{method.label}</option>
				{/each}
			</select>
		</div>
		<div class="quality-mode-row">
			<label for="donation-currency-select">Currency</label>
			{#if adminDonationCurrencyOptions.length > 0}
				<select
					id="donation-currency-select"
					class="theme-select"
					value={adminDonationConfig.currency}
					on:change={(event) => adminDonationConfig = { ...adminDonationConfig, currency: event.currentTarget.value.toUpperCase() }}
				>
					{#each adminDonationCurrencyOptions as option}
						<option value={option}>{option}</option>
					{/each}
				</select>
			{:else}
				<input
					id="donation-currency-select"
					class="emoji-name-input"
					maxlength="3"
					value={adminDonationConfig.currency}
					on:input={(event) => adminDonationConfig = { ...adminDonationConfig, currency: event.currentTarget.value.toUpperCase() }}
				/>
			{/if}
		</div>
		<div class="quality-mode-row">
			<label for="donation-country-select">Country</label>
			{#if adminDonationCountryOptions.length > 0}
				<select
					id="donation-country-select"
					class="theme-select"
					value={adminDonationConfig.countryCode || ''}
					on:change={(event) => adminDonationConfig = { ...adminDonationConfig, countryCode: event.currentTarget.value.toUpperCase() || null }}
				>
					{#each adminDonationCountryOptions as option}
						<option value={option}>{option}</option>
					{/each}
				</select>
			{:else}
				<input
					id="donation-country-select"
					class="emoji-name-input"
					maxlength="2"
					value={adminDonationConfig.countryCode || ''}
					on:input={(event) => adminDonationConfig = { ...adminDonationConfig, countryCode: event.currentTarget.value.toUpperCase() || null }}
				/>
			{/if}
		</div>
		<div class="donation-audit-panel">
			<div class="donation-audit-header">
				<div>
					<h5>Public Donation Route Preview</h5>
					<p class="admin-help">This is the exact route the public donation sheet will use.</p>
				</div>
				<button class="action-btn" on:click={openServerDonation}>
					Preview Public View
				</button>
			</div>
			<div class="donation-audit-list">
				<div class="donation-audit-item">
					<div class="donation-audit-copy">
						<strong>{adminDonationSelectedProvider?.providerName || 'No provider selected'}</strong>
						<span>{adminDonationSelectedMethod?.label || 'No method selected'}</span>
						<small>{adminDonationConfig.countryCode || 'Any country'} - {adminDonationConfig.currency || 'Any currency'}</small>
						<small>Suggested amounts: {getDonationRouteSummaryList(parseSuggestedAmountsInput(donationSuggestedAmountsInput))}</small>
						{#if adminDonationSelectedProvider?.notes}
							<small>{adminDonationSelectedProvider.notes}</small>
						{/if}
						{#if adminDonationSelectedMethod?.notes}
							<small>{adminDonationSelectedMethod.notes}</small>
						{/if}
					</div>
					<button
						class="action-btn"
						disabled={!donationRoutePreviewReady}
						on:click={openServerDonation}
					>
						{donationRoutePreviewReady ? 'Route Ready' : 'Needs Setup'}
					</button>
				</div>
			</div>
		</div>
		<div class="quality-mode-row">
			<label for="donation-headline-input">Headline</label>
			<input
				id="donation-headline-input"
				class="emoji-name-input"
				maxlength="120"
				value={adminDonationConfig.headline}
				on:input={(event) => adminDonationConfig = { ...adminDonationConfig, headline: event.currentTarget.value }}
			/>
		</div>
		<div class="quality-mode-row">
			<label for="donation-description-input">Description</label>
			<input
				id="donation-description-input"
				class="emoji-name-input"
				maxlength="500"
				value={adminDonationConfig.description}
				on:input={(event) => adminDonationConfig = { ...adminDonationConfig, description: event.currentTarget.value }}
			/>
		</div>
		<div class="quality-mode-row">
			<label for="donation-amounts-input">Suggested Amounts</label>
			<input
				id="donation-amounts-input"
				class="emoji-name-input"
				placeholder="5, 10, 25"
				bind:value={donationSuggestedAmountsInput}
			/>
		</div>
		<button class="action-btn" on:click={saveDonationConfig} disabled={!canManageAdmin || adminDonationConfigLoading || adminDonationConfigSaving}>
			{adminDonationConfigSaving ? 'Saving...' : 'Save Donation Settings'}
		</button>
		<div class="donation-audit-panel">
			<div class="donation-audit-header">
				<div>
					<h5>Donation Audit Trail</h5>
					<p class="admin-help">This covers server donations only. Direct user-to-user payments stay private.</p>
				</div>
				<button
					class="action-btn"
					on:click={() => {
						adminDonationAuditLoaded = false;
						void loadAdminDonationAudit();
					}}
					disabled={adminDonationAuditLoading || adminDonationRefundingIntentId !== ''}
				>
					{adminDonationAuditLoading ? 'Refreshing...' : 'Refresh Audit'}
				</button>
			</div>
			{#if adminDonationAuditLoading && adminDonationAudit.length === 0}
				<p class="admin-help">Loading donation audit trail...</p>
			{:else if adminDonationAudit.length === 0}
				<p class="admin-help">No donation activity yet.</p>
			{:else}
				<div class="donation-audit-list">
					{#each adminDonationAudit as entry (entry.intentId)}
						<div class="donation-audit-item">
							<div class="donation-audit-copy">
								<strong>{entry.donorLabel}</strong>
								<span>{formatDonationAuditAmount(entry.amountMinor, entry.currency)}</span>
								<small>{formatDonationAuditWhen(entry)} | {entry.status}</small>
							</div>
							<button
								class="action-btn"
								disabled={!entry.canRefund || adminDonationRefundingIntentId !== '' || !canManageAdmin}
								on:click={() => refundDonation(entry)}
							>
								{adminDonationRefundingIntentId === entry.intentId ? 'Refunding...' : (entry.canRefund ? 'Refund' : 'Closed')}
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		<div class="donation-audit-panel">
			<div class="donation-audit-header">
				<div>
					<h5>Offline / Manual Donations</h5>
					<p class="admin-help">Record in-person cash or off-platform donations here. These are visible in server donation transparency, but they are not provider-verified.</p>
				</div>
				<button
					class="action-btn"
					on:click={() => {
						adminOfflineDonationAuditLoaded = false;
						void loadAdminOfflineDonationAudit();
					}}
					disabled={adminOfflineDonationAuditLoading || adminOfflineDonationVoidingSettlementId !== '' || adminOfflineDonationSaving}
				>
					{adminOfflineDonationAuditLoading ? 'Refreshing...' : 'Refresh Offline Log'}
				</button>
			</div>
			<div class="offline-donation-form">
				<label class="upload-limit-row">
					<span>Amount</span>
					<input
						type="text"
						placeholder="10.00"
						bind:value={offlineDonationAmountInput}
						disabled={!canManageAdmin || adminOfflineDonationSaving}
					/>
				</label>
				<label class="upload-limit-row">
					<span>Currency</span>
					<input
						type="text"
						maxlength="3"
						placeholder="USD"
						bind:value={offlineDonationCurrency}
						disabled={!canManageAdmin || adminOfflineDonationSaving}
					/>
				</label>
				<label class="upload-limit-row">
					<span>Masked Donor Label</span>
					<input
						type="text"
						maxlength="120"
						placeholder="Dot"
						bind:value={offlineDonationDonorLabel}
						disabled={!canManageAdmin || adminOfflineDonationSaving}
					/>
				</label>
				<label class="upload-limit-row">
					<span>Note</span>
					<input
						type="text"
						maxlength="280"
						placeholder="Paid in cash after local meetup"
						bind:value={offlineDonationDescription}
						disabled={!canManageAdmin || adminOfflineDonationSaving}
					/>
				</label>
			</div>
			<button class="action-btn" on:click={createOfflineDonationRecord} disabled={!canManageAdmin || adminOfflineDonationSaving}>
				{adminOfflineDonationSaving ? 'Recording...' : 'Record Offline Donation'}
			</button>
			{#if adminOfflineDonationAuditLoading && adminOfflineDonationAudit.length === 0}
				<p class="admin-help">Loading offline donation log...</p>
			{:else if adminOfflineDonationAudit.length === 0}
				<p class="admin-help">No offline donations recorded yet.</p>
			{:else}
				<div class="donation-audit-list">
					{#each adminOfflineDonationAudit as entry (entry.settlementId)}
						<div class="donation-audit-item">
							<div class="donation-audit-copy">
								<strong>{entry.donorLabel}</strong>
								<span>{formatDonationAuditAmount(entry.amountMinor, entry.currency)}</span>
								<small>{formatDonationAuditWhen(entry)} | {entry.status} | {entry.recordedByLabel || 'Admin record'}</small>
								{#if entry.description}
									<small>{entry.description}</small>
								{/if}
							</div>
							<button
								class="action-btn"
								disabled={!entry.canVoid || adminOfflineDonationVoidingSettlementId !== '' || !canManageAdmin}
								on:click={() => voidOfflineDonation(entry)}
							>
								{adminOfflineDonationVoidingSettlementId === entry.settlementId ? 'Voiding...' : (entry.canVoid ? 'Void' : 'Closed')}
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		<div class="donation-audit-panel">
			<div class="donation-audit-header">
				<div>
					<h5>Community Nodes</h5>
					<p class="admin-help">See which relay-style nodes are up, down, pending, or degraded. This is the live server roster, not a private admin notification.</p>
				</div>
				<button
					class="action-btn"
					on:click={() => {
						adminRelayRosterLoaded = false;
						void loadAdminRelayRoster();
					}}
					disabled={adminRelayRosterLoading || adminRelayApproveBusyId !== null || adminRelayDeleteBusyId !== null}
				>
					{adminRelayRosterLoading ? 'Refreshing...' : 'Refresh Nodes'}
				</button>
			</div>
			<div class="upload-limits-panel">
				<h4>Node Access Policy</h4>
				<p class="admin-help">Control who can activate desktop helper mode on this server.</p>
				<div class="setting-item">
					<label for="community-node-access-mode">Access Mode</label>
					<select
						id="community-node-access-mode"
						bind:value={communityNodeAccess.mode}
						disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
					>
						<option value="open">Open</option>
						<option value="approval_required">Approval Required</option>
						<option value="whitelist_only">Whitelist Only</option>
					</select>
				</div>
				{#if communityNodeAccess.mode === 'whitelist_only'}
					<div class="setting-item">
						<label for="community-node-whitelist-online">Add Online User</label>
						<div class="input-with-button">
							<select
								id="community-node-whitelist-online"
								bind:value={communityNodeWhitelistSelectedUserId}
								disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
							>
								<option value="">Select a user</option>
								{#each communityNodeWhitelistCandidates as user}
									<option value={String(user.dbUserId)}>#{user.username}</option>
								{/each}
							</select>
							<button
								class="action-btn"
								on:click={addSelectedCommunityNodeWhitelistUser}
								disabled={!communityNodeWhitelistSelectedUserId || !canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
							>
								Add
							</button>
						</div>
					</div>
					<div class="setting-item">
						<label for="community-node-whitelist-username">Add By Username</label>
						<div class="input-with-button">
							<input
								id="community-node-whitelist-username"
								type="text"
								placeholder="Exact registered username"
								bind:value={communityNodeWhitelistUsernameInput}
								disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
							/>
							<button
								class="action-btn"
								on:click={addTypedCommunityNodeWhitelistUser}
								disabled={!communityNodeWhitelistUsernameInput.trim() || !canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
							>
								Stage
							</button>
						</div>
						<p class="admin-help">Typed usernames are validated when you save the policy.</p>
					</div>
					<div class="setting-item">
						<div class="setting-label">Allowed Users</div>
						{#if communityNodeAccess.allowedUsers.length === 0 && communityNodeWhitelistPendingUsernames.length === 0}
							<p class="admin-help">No users are currently whitelisted.</p>
						{:else}
							<div class="quick-reaction-custom-list">
								{#each communityNodeAccess.allowedUsers as entry (entry.userId)}
									<div class="quick-reaction-custom-item">
										<span>#{entry.username}</span>
										<button
											class="action-btn danger"
											on:click={() => removeCommunityNodeWhitelistUser(entry.userId)}
											disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
										>
											Remove
										</button>
									</div>
								{/each}
								{#each communityNodeWhitelistPendingUsernames as username (username)}
									<div class="quick-reaction-custom-item">
										<span>#{username} (pending)</span>
										<button
											class="action-btn danger"
											on:click={() => removePendingCommunityNodeWhitelistUsername(username)}
											disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
										>
											Remove
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
				{#if communityNodeAccessStatus}
					<p class="admin-help">{communityNodeAccessStatus}</p>
				{/if}
				<button
					class="action-btn"
					on:click={saveCommunityNodeAccess}
					disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
				>
					{communityNodeAccessSaving ? 'Saving...' : 'Save Node Access Policy'}
				</button>
			</div>
			<div class="upload-limits-panel">
				<h4>Node Announcements</h4>
				<p class="admin-help">Optionally post helper up/down events into one channel. Placeholders: {'{node}'}, {'{user}'}, {'{mode}'}, {'{status}'}.</p>
				<label class="setting-toggle">
					<input
						type="checkbox"
						bind:checked={communityNodeAnnouncements.enabled}
						disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
					/>
					<span>Post community node status messages</span>
				</label>
				<div class="setting-item">
					<label for="community-node-announcement-channel">Announcement Channel</label>
					<select
						id="community-node-announcement-channel"
						bind:value={communityNodeAnnouncements.channelId}
						disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
					>
						<option value={null}>No channel selected</option>
						{#each communityAnnouncementChannelOptions as channel}
							<option value={channel.id}>#{channel.name}</option>
						{/each}
					</select>
				</div>
				<div class="setting-item">
					<label for="community-node-announcement-online">Online Message</label>
					<input
						id="community-node-announcement-online"
						type="text"
						bind:value={communityNodeAnnouncements.onlineTemplate}
						maxlength="280"
						disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
					/>
				</div>
				<div class="setting-item">
					<label for="community-node-announcement-offline">Offline Message</label>
					<input
						id="community-node-announcement-offline"
						type="text"
						bind:value={communityNodeAnnouncements.offlineTemplate}
						maxlength="280"
						disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
					/>
				</div>
				{#if communityNodeAnnouncementsStatus}
					<p class="admin-help">{communityNodeAnnouncementsStatus}</p>
				{/if}
				<button
					class="action-btn"
					on:click={saveCommunityNodeAnnouncements}
					disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
				>
					{communityNodeAnnouncementsSaving ? 'Saving...' : 'Save Node Announcement Settings'}
				</button>
			</div>
			{#if adminRelayRosterLoading && adminRelayRoster.length === 0}
				<p class="admin-help">Loading community nodes...</p>
			{:else if adminRelayRoster.length === 0}
				<p class="admin-help">No community nodes have registered yet.</p>
			{:else}
				<div class="donation-audit-list">
					{#each adminRelayRoster as relay (relay.relay_id)}
						<div class="donation-audit-item">
							<div class="donation-audit-copy">
								<strong>{relay.name}</strong>
								<span>{getAdminRelayKindLabel(relay)} - {relay.status}</span>
								{#if getAdminRelayOwnerLabel(relay)}
									<small>{getAdminRelayOwnerLabel(relay)}</small>
								{/if}
								<small>{relay.region} - {getAdminRelayCapabilitiesSummary(relay)}</small>
								<small>Last seen: {formatRelaySeenAt(relay.last_health_ping)}</small>
								<small>{relay.url}</small>
								{#if relay.metadata?.reason}
									<small>{relay.metadata.reason}</small>
								{/if}
							</div>
							<div class="admin-user-actions">
								<button
									class="action-btn"
									disabled={relay.approved === 1 || adminRelayApproveBusyId !== null}
									on:click={() => approveRelayNode(relay)}
								>
									{adminRelayApproveBusyId === relay.relay_id ? 'Approving...' : (relay.approved === 1 ? 'Approved' : 'Approve')}
								</button>
								<button
									class="action-btn danger"
									disabled={adminRelayDeleteBusyId !== null}
									on:click={() => deleteRelayNode(relay)}
								>
									{adminRelayDeleteBusyId === relay.relay_id ? 'Removing...' : 'Remove'}
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
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
						on:click={() => promoteUser(user, 'admin')}
					>
						Make Admin
					</button>
					<button
						class="action-btn"
						disabled={!canManageTargetUser(user) || !userHasRole(user, 'admin')}
						on:click={() => removeRoleFromUser(user, 'admin')}
					>
						Remove Admin
					</button>
					<button
						class="action-btn"
						disabled={!canManageTargetUser(user) || userHasRole(user, 'mod')}
						on:click={() => promoteUser(user, 'mod')}
					>
						Make Mod
					</button>
					<button
						class="action-btn"
						disabled={!canManageTargetUser(user) || !userHasRole(user, 'mod')}
						on:click={() => removeRoleFromUser(user, 'mod')}
					>
						Remove Mod
					</button>
					<button
						class="action-btn danger"
						disabled={!canManageTargetUser(user) || (!userHasRole(user, 'admin') && !userHasRole(user, 'mod'))}
						on:click={() => resetUserToMember(user)}
					>
						Reset to Member
					</button>
					<button
						class="action-btn"
						disabled={!canManageTargetUser(user)}
						on:click={() => promptAdminPasswordReset(user)}
					>
						Reset Password
					</button>
					<button
						class="action-btn"
						disabled={!canManageTargetUser(user)}
						on:click={() => clearUserLoginLockout(user)}
					>
						Clear Lockout
					</button>
				</div>
			</div>
		{/each}
	</div>
</div>