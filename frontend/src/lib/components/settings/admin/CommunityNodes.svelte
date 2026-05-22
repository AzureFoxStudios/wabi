<script lang="ts">
	import type {
		AdminRelayNode,
		CommunityNodeAccessPolicy,
		CommunityNodeAllowedUser,
		CommunityNodeAnnouncementsPolicy
	} from '$lib/api';

	export let canManageAdmin: boolean;
	export let adminRelayRoster: AdminRelayNode[];
	export let adminRelayRosterLoading: boolean;
	export let adminRelayRosterLoaded: boolean;
	export let adminRelayApproveBusyId: number | null;
	export let adminRelayDeleteBusyId: number | null;
	export let communityNodeAccess: CommunityNodeAccessPolicy;
	export let communityNodeAccessLoaded: boolean;
	export let communityNodeAccessLoading: boolean;
	export let communityNodeAccessSaving: boolean;
	export let communityNodeAccessStatus: string;
	export let communityNodeWhitelistSelectedUserId: string;
	export let communityNodeWhitelistUsernameInput: string;
	export let communityNodeWhitelistPendingUsernames: string[];
	export let communityNodeWhitelistCandidates: Array<{ dbUserId?: number; username: string }>;
	export let communityNodeAnnouncements: CommunityNodeAnnouncementsPolicy;
	export let communityNodeAnnouncementsLoaded: boolean;
	export let communityNodeAnnouncementsLoading: boolean;
	export let communityNodeAnnouncementsSaving: boolean;
	export let communityNodeAnnouncementsStatus: string;
	export let communityAnnouncementChannelOptions: Array<{ id: string; name: string; type: string }>;
	export let onRefreshRelayRoster: () => void;
	export let onApproveRelay: (relay: AdminRelayNode) => void;
	export let onDeleteRelay: (relay: AdminRelayNode) => void;
	export let onSaveNodeAccess: () => void;
	export let onSaveNodeAnnouncements: () => void;
	export let onAddSelectedWhitelistUser: () => void;
	export let onAddTypedWhitelistUser: () => void;
	export let onRemoveWhitelistUser: (userId: number) => void;
	export let onRemovePendingWhitelistUsername: (username: string) => void;
	export let onAccessModeChange: (mode: string) => void;
	export let onWhitelistSelectedUserIdChange: (id: string) => void;
	export let onWhitelistUsernameInput: (value: string) => void;
	export let onAnnouncementsEnabledChange: (enabled: boolean) => void;
	export let onAnnouncementsChannelIdChange: (id: string | null) => void;
	export let onAnnouncementsOnlineTemplateChange: (value: string) => void;
	export let onAnnouncementsOfflineTemplateChange: (value: string) => void;
	export let getAdminRelayKindLabel: (relay: AdminRelayNode) => string;
	export let getAdminRelayCapabilitiesSummary: (relay: AdminRelayNode) => string;
	export let formatRelaySeenAt: (unixSeconds: number | null) => string;
	export let getAdminRelayOwnerLabel: (relay: AdminRelayNode) => string | null;
</script>

<div class="donation-audit-panel">
	<div class="donation-audit-header">
		<div>
			<h5>Community Nodes</h5>
			<p class="admin-help">See which relay-style nodes are up, down, pending, or degraded. This is the live server roster, not a private admin notification.</p>
		</div>
		<button
			class="action-btn"
			on:click={onRefreshRelayRoster}
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
				value={communityNodeAccess.mode}
				on:change={(e) => onAccessModeChange((e.currentTarget as HTMLSelectElement).value)}
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
						value={communityNodeWhitelistSelectedUserId}
						on:change={(e) => onWhitelistSelectedUserIdChange((e.currentTarget as HTMLSelectElement).value)}
						disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
					>
						<option value="">Select a user</option>
						{#each communityNodeWhitelistCandidates as user}
							<option value={String(user.dbUserId)}>#{user.username}</option>
						{/each}
					</select>
					<button
						class="action-btn"
						on:click={onAddSelectedWhitelistUser}
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
						value={communityNodeWhitelistUsernameInput}
						on:input={(e) => onWhitelistUsernameInput((e.currentTarget as HTMLInputElement).value)}
						disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
					/>
					<button
						class="action-btn"
						on:click={onAddTypedWhitelistUser}
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
									on:click={() => onRemoveWhitelistUser(entry.userId)}
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
									on:click={() => onRemovePendingWhitelistUsername(username)}
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
			on:click={onSaveNodeAccess}
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
				checked={communityNodeAnnouncements.enabled}
				on:change={(e) => onAnnouncementsEnabledChange((e.currentTarget as HTMLInputElement).checked)}
				disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
			/>
			<span>Post community node status messages</span>
		</label>
		<div class="setting-item">
			<label for="community-node-announcement-channel">Announcement Channel</label>
			<select
				id="community-node-announcement-channel"
				value={communityNodeAnnouncements.channelId || ''}
				on:change={(e) => onAnnouncementsChannelIdChange((e.currentTarget as HTMLSelectElement).value || null)}
				disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
			>
				<option value="">No channel selected</option>
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
				value={communityNodeAnnouncements.onlineTemplate}
				maxlength="280"
				on:input={(e) => onAnnouncementsOnlineTemplateChange((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
			/>
		</div>
		<div class="setting-item">
			<label for="community-node-announcement-offline">Offline Message</label>
			<input
				id="community-node-announcement-offline"
				type="text"
				value={communityNodeAnnouncements.offlineTemplate}
				maxlength="280"
				on:input={(e) => onAnnouncementsOfflineTemplateChange((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
			/>
		</div>
		{#if communityNodeAnnouncementsStatus}
			<p class="admin-help">{communityNodeAnnouncementsStatus}</p>
		{/if}
		<button
			class="action-btn"
			on:click={onSaveNodeAnnouncements}
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
							on:click={() => onApproveRelay(relay)}
						>
							{adminRelayApproveBusyId === relay.relay_id ? 'Approving...' : (relay.approved === 1 ? 'Approved' : 'Approve')}
						</button>
						<button
							class="action-btn danger"
							disabled={adminRelayDeleteBusyId !== null}
							on:click={() => onDeleteRelay(relay)}
						>
							{adminRelayDeleteBusyId === relay.relay_id ? 'Removing...' : 'Remove'}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
