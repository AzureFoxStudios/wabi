<script lang="ts">
	import {
		approveAdminRelay,
		deleteAdminRelay,
		getAdminCommunityNodeAccessPolicy,
		getAdminCommunityNodeAnnouncementsPolicy,
		listAdminRelays,
		saveAdminCommunityNodeAccessPolicy,
		saveAdminCommunityNodeAnnouncementsPolicy,
		type AdminRelayNode,
		type CommunityNodeAccessPolicy,
		type CommunityNodeAllowedUser,
		type CommunityNodeAnnouncementsPolicy
	} from '$lib/api';
	import { getAuthToken } from '$lib/authSession';
	import CommunityNodes from './CommunityNodes.svelte';
	import {
		formatRelaySeenAt,
		getAdminRelayCapabilitiesSummary,
		getAdminRelayKindLabel,
		getAdminRelayOwnerLabel
	} from './adminSettingsHelpers';

	export let canManageAdmin = false;
	export let communityNodeWhitelistCandidates: Array<{ dbUserId?: number; username: string }> = [];
	export let communityAnnouncementChannelOptions: Array<{ id: string; name: string; type: string }> = [];

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

	$: if (canManageAdmin && !adminRelayRosterLoaded) void loadAdminRelayRoster();
	$: if (canManageAdmin && !communityNodeAccessLoaded) void loadCommunityNodeAccessPolicy();
	$: if (canManageAdmin && !communityNodeAnnouncementsLoaded) void loadCommunityNodeAnnouncementsPolicy();

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
</script>

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
