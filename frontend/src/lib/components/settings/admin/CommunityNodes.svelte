<script lang="ts">
	import { _ } from '$lib/i18n';
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
			<h5>{$_('cn.title')}</h5>
			<p class="admin-help">{$_('cn.help')}</p>
		</div>
		<button
			class="action-btn"
			on:click={onRefreshRelayRoster}
			disabled={adminRelayRosterLoading || adminRelayApproveBusyId !== null || adminRelayDeleteBusyId !== null}
		>
			{adminRelayRosterLoading ? $_('donation_config.refreshing') : $_('cn.refresh')}
		</button>
	</div>
	<div class="upload-limits-panel">
		<h4>{$_('cn.access_title')}</h4>
		<p class="admin-help">{$_('cn.access_help')}</p>
		<div class="setting-item">
			<label for="community-node-access-mode">{$_('cn.access_mode')}</label>
			<select
				id="community-node-access-mode"
				value={communityNodeAccess.mode}
				on:change={(e) => onAccessModeChange((e.currentTarget as HTMLSelectElement).value)}
				disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
			>
				<option value="open">{$_('common.open')}</option>
				<option value="approval_required">{$_('cn.approval')}</option>
				<option value="whitelist_only">{$_('cn.whitelist_only')}</option>
			</select>
		</div>
		{#if communityNodeAccess.mode === 'whitelist_only'}
			<div class="setting-item">
				<label for="community-node-whitelist-online">{$_('cn.add_online')}</label>
				<div class="input-with-button">
					<select
						id="community-node-whitelist-online"
						value={communityNodeWhitelistSelectedUserId}
						on:change={(e) => onWhitelistSelectedUserIdChange((e.currentTarget as HTMLSelectElement).value)}
						disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
					>
						<option value="">{$_('cn.select_user')}</option>
						{#each communityNodeWhitelistCandidates as user}
							<option value={String(user.dbUserId)}>#{user.username}</option>
						{/each}
					</select>
					<button
						class="action-btn"
						on:click={onAddSelectedWhitelistUser}
						disabled={!communityNodeWhitelistSelectedUserId || !canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
					>
						{$_('media_albums.add')}
					</button>
				</div>
			</div>
			<div class="setting-item">
				<label for="community-node-whitelist-username">{$_('cn.add_username')}</label>
				<div class="input-with-button">
					<input
						id="community-node-whitelist-username"
						type="text"
						placeholder={$_('cn.username_ph')}
						value={communityNodeWhitelistUsernameInput}
						on:input={(e) => onWhitelistUsernameInput((e.currentTarget as HTMLInputElement).value)}
						disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
					/>
					<button
						class="action-btn"
						on:click={onAddTypedWhitelistUser}
						disabled={!communityNodeWhitelistUsernameInput.trim() || !canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
					>
						{$_('cn.stage')}
					</button>
				</div>
				<p class="admin-help">{$_('cn.typed_help')}</p>
			</div>
			<div class="setting-item">
				<div class="setting-label">{$_('server_policy.allowed_users')}</div>
				{#if communityNodeAccess.allowedUsers.length === 0 && communityNodeWhitelistPendingUsernames.length === 0}
					<p class="admin-help">{$_('cn.no_whitelist')}</p>
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
									{$_('profile_settings.remove')}
								</button>
							</div>
						{/each}
						{#each communityNodeWhitelistPendingUsernames as username (username)}
							<div class="quick-reaction-custom-item">
								<span>#{username} ({$_('storage.offline.wabiDB.pending')})</span>
								<button
									class="action-btn danger"
									on:click={() => onRemovePendingWhitelistUsername(username)}
									disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
								>
									{$_('profile_settings.remove')}
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
			{communityNodeAccessSaving ? $_('donation_config.saving') : $_('cn.save_access')}
		</button>
	</div>
	<div class="upload-limits-panel">
		<h4>{$_('cn.announce_title')}</h4>
		<p class="admin-help">{$_('cn.announce_help')} {'{node}'}, {'{user}'}, {'{mode}'}, {'{status}'}.</p>
		<label class="setting-toggle">
			<input
				type="checkbox"
				checked={communityNodeAnnouncements.enabled}
				on:change={(e) => onAnnouncementsEnabledChange((e.currentTarget as HTMLInputElement).checked)}
				disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
			/>
			<span>{$_('cn.post_status')}</span>
		</label>
		<div class="setting-item">
			<label for="community-node-announcement-channel">{$_('cn.announce_channel')}</label>
			<select
				id="community-node-announcement-channel"
				value={communityNodeAnnouncements.channelId || ''}
				on:change={(e) => onAnnouncementsChannelIdChange((e.currentTarget as HTMLSelectElement).value || null)}
				disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
			>
				<option value="">{$_('cn.no_channel')}</option>
				{#each communityAnnouncementChannelOptions as channel}
					<option value={channel.id}>#{channel.name}</option>
				{/each}
			</select>
		</div>
		<div class="setting-item">
			<label for="community-node-announcement-online">{$_('cn.online_msg')}</label>
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
			<label for="community-node-announcement-offline">{$_('cn.offline_msg')}</label>
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
			{communityNodeAnnouncementsSaving ? $_('donation_config.saving') : $_('cn.save_announce')}
		</button>
	</div>
	{#if adminRelayRosterLoading && adminRelayRoster.length === 0}
		<p class="admin-help">{$_('cn.loading')}</p>
	{:else if adminRelayRoster.length === 0}
		<p class="admin-help">{$_('cn.none')}</p>
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
						<small>{$_('cn.last_seen', { values: { time: formatRelaySeenAt(relay.last_health_ping) } })}</small>
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
							{adminRelayApproveBusyId === relay.relay_id ? $_('cn.approving') : (relay.approved === 1 ? $_('cn.approved') : $_('yt.approve'))}
						</button>
						<button
							class="action-btn danger"
							disabled={adminRelayDeleteBusyId !== null}
							on:click={() => onDeleteRelay(relay)}
						>
							{adminRelayDeleteBusyId === relay.relay_id ? $_('cn.removing') : $_('profile_settings.remove')}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
