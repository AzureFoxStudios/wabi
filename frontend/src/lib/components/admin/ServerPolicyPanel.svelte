<script lang="ts">
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import {
		getAdminUploadLimits,
		saveAdminUploadLimits,
		getAdminPolicy,
		saveAdminPolicy,
		type UploadLimitConfig,
		type DownloadLimitConfig,
		type UploadRoleTier,
		type CommunityNodeAnnouncementsPolicy,
		type CommunityNodeAccessPolicy
	} from '$lib/api';

	export let canManageAdmin = false;

	const MB = 1024 * 1024;
	const uploadRoleOrder: UploadRoleTier[] = ['new', 'trusted', 'moderator', 'admin', 'owner'];
	const uploadRoleLabels: Record<UploadRoleTier, string> = {
		new: 'New',
		trusted: 'Trusted',
		moderator: 'Moderator',
		admin: 'Admin',
		owner: 'Owner'
	};

	function bytesToMbInput(bytes: number | null): string {
		if (bytes === null) return '';
		const mb = Math.floor(bytes / MB);
		return mb > 0 ? String(mb) : '1';
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

	function token(): string | null {
		return getAuthToken();
	}

	// --- Upload limits ---
	let uploadConfig: UploadLimitConfig | null = null;
	let uploadLoading = false;
	let uploadSaving = false;
	let uploadError = '';
	let uploadStatus = '';
	let uploadLimitInputs: Record<UploadRoleTier, string> = {
		new: '',
		trusted: '',
		moderator: '',
		admin: '',
		owner: ''
	};
	let globalUploadLimitInput = '';

	function uploadInputsFrom(cfg: UploadLimitConfig): Record<UploadRoleTier, string> {
		return {
			new: bytesToMbInput(cfg.perRoleBytes.new),
			trusted: bytesToMbInput(cfg.perRoleBytes.trusted),
			moderator: bytesToMbInput(cfg.perRoleBytes.moderator),
			admin: bytesToMbInput(cfg.perRoleBytes.admin),
			owner: bytesToMbInput(cfg.perRoleBytes.owner)
		};
	}

	async function refreshUploadLimits() {
		const tk = token();
		if (!tk) return;
		uploadLoading = true;
		uploadError = '';
		try {
			const cfg = await getAdminUploadLimits(tk);
			uploadConfig = cfg.config;
			uploadLimitInputs = uploadInputsFrom(cfg.config);
			globalUploadLimitInput = bytesToMbInput(cfg.config.globalUploadCapBytes);
		} catch (e) {
			uploadError = (e as Error).message || 'Failed to load upload limits';
		} finally {
			uploadLoading = false;
		}
	}

	async function saveUploadLimits() {
		const tk = token();
		if (!tk) return;
		uploadSaving = true;
		uploadError = '';
		uploadStatus = '';
		try {
			const next: UploadLimitConfig = {
				perRoleBytes: {
					new: parseMbInput(uploadLimitInputs.new),
					trusted: parseMbInput(uploadLimitInputs.trusted),
					moderator: parseMbInput(uploadLimitInputs.moderator),
					admin: parseMbInput(uploadLimitInputs.admin),
					owner: parseMbInput(uploadLimitInputs.owner)
				},
				globalUploadCapBytes: parseMbInput(globalUploadLimitInput)
			};
			const saved = await saveAdminUploadLimits(tk, next);
			uploadConfig = saved;
			uploadLimitInputs = uploadInputsFrom(saved);
			globalUploadLimitInput = bytesToMbInput(saved.globalUploadCapBytes);
			uploadStatus = 'Saved upload limits.';
		} catch (e) {
			uploadError = (e as Error).message || 'Failed to save upload limits';
		} finally {
			uploadSaving = false;
		}
	}

	// --- Download limits (generic policy browser) ---
	let downloadConfig: DownloadLimitConfig | null = null;
	let downloadLoading = false;
	let downloadSaving = false;
	let downloadError = '';
	let downloadStatus = '';
	let downloadLimitInputs: Record<UploadRoleTier, string> = {
		new: '',
		trusted: '',
		moderator: '',
		admin: '',
		owner: ''
	};
	let globalDownloadLimitInput = '';

	function downloadInputsFrom(cfg: DownloadLimitConfig): Record<UploadRoleTier, string> {
		return {
			new: bytesToMbInput(cfg.perRoleBytes.new),
			trusted: bytesToMbInput(cfg.perRoleBytes.trusted),
			moderator: bytesToMbInput(cfg.perRoleBytes.moderator),
			admin: bytesToMbInput(cfg.perRoleBytes.admin),
			owner: bytesToMbInput(cfg.perRoleBytes.owner)
		};
	}

	async function refreshDownloadLimits() {
		const tk = token();
		if (!tk) return;
		downloadLoading = true;
		downloadError = '';
		try {
			const cfg = await getAdminPolicy<DownloadLimitConfig>(tk, 'download_limits');
			downloadConfig = cfg.config;
			downloadLimitInputs = downloadInputsFrom(cfg.config);
			globalDownloadLimitInput = bytesToMbInput(cfg.config.globalDownloadCapBytes);
		} catch (e) {
			downloadError = (e as Error).message || 'Failed to load download limits';
		} finally {
			downloadLoading = false;
		}
	}

	async function saveDownloadLimits() {
		const tk = token();
		if (!tk || !downloadConfig) return;
		downloadSaving = true;
		downloadError = '';
		downloadStatus = '';
		try {
			const next: DownloadLimitConfig = {
				perRoleBytes: {
					new: parseMbInput(downloadLimitInputs.new),
					trusted: parseMbInput(downloadLimitInputs.trusted),
					moderator: parseMbInput(downloadLimitInputs.moderator),
					admin: parseMbInput(downloadLimitInputs.admin),
					owner: parseMbInput(downloadLimitInputs.owner)
				},
				globalDownloadCapBytes: parseMbInput(globalDownloadLimitInput)
			};
			const saved = await saveAdminPolicy<DownloadLimitConfig>(tk, 'download_limits', next);
			downloadConfig = saved;
			downloadLimitInputs = downloadInputsFrom(saved);
			globalDownloadLimitInput = bytesToMbInput(saved.globalDownloadCapBytes);
			downloadStatus = 'Saved download limits.';
		} catch (e) {
			downloadError = (e as Error).message || 'Failed to save download limits';
		} finally {
			downloadSaving = false;
		}
	}

	// --- Community node announcements (generic policy browser) ---
	let announcementsConfig: CommunityNodeAnnouncementsPolicy | null = null;
	let announcementsLoading = false;
	let announcementsSaving = false;
	let announcementsError = '';
	let announcementsStatus = '';
	let announcementsDraft: CommunityNodeAnnouncementsPolicy = {
		enabled: false,
		channelId: null,
		onlineTemplate: '',
		offlineTemplate: ''
	};

	async function refreshAnnouncements() {
		const tk = token();
		if (!tk) return;
		announcementsLoading = true;
		announcementsError = '';
		try {
			const cfg = await getAdminPolicy<CommunityNodeAnnouncementsPolicy>(
				tk,
				'community_node_announcements'
			);
			announcementsConfig = cfg.config;
			announcementsDraft = { ...cfg.config };
		} catch (e) {
			announcementsError = (e as Error).message || 'Failed to load announcements policy';
		} finally {
			announcementsLoading = false;
		}
	}

	async function saveAnnouncements() {
		const tk = token();
		if (!tk) return;
		announcementsSaving = true;
		announcementsError = '';
		announcementsStatus = '';
		try {
			const next: CommunityNodeAnnouncementsPolicy = {
				enabled: announcementsDraft.enabled,
				channelId: announcementsDraft.channelId?.trim() ? announcementsDraft.channelId.trim() : null,
				onlineTemplate: announcementsDraft.onlineTemplate,
				offlineTemplate: announcementsDraft.offlineTemplate
			};
			const saved = await saveAdminPolicy<CommunityNodeAnnouncementsPolicy>(
				tk,
				'community_node_announcements',
				next
			);
			announcementsConfig = saved;
			announcementsDraft = { ...saved };
			announcementsStatus = 'Saved community node announcements policy.';
		} catch (e) {
			announcementsError = (e as Error).message || 'Failed to save announcements policy';
		} finally {
			announcementsSaving = false;
		}
	}

	// --- Community node access (generic policy browser) ---
	type AllowedUser = { userId: number; username: string };
	let accessConfig: CommunityNodeAccessPolicy | null = null;
	let accessLoading = false;
	let accessSaving = false;
	let accessError = '';
	let accessStatus = '';
	let accessDraft: CommunityNodeAccessPolicy = { mode: 'open', allowedUsers: [] };
	let newAllowedUserId = '';
	let newAllowedUsername = '';

	async function refreshAccess() {
		const tk = token();
		if (!tk) return;
		accessLoading = true;
		accessError = '';
		try {
			const cfg = await getAdminPolicy<CommunityNodeAccessPolicy>(tk, 'community_node_access');
			accessConfig = cfg.config;
			accessDraft = { mode: cfg.config.mode, allowedUsers: [...(cfg.config.allowedUsers || [])] };
		} catch (e) {
			accessError = (e as Error).message || 'Failed to load access policy';
		} finally {
			accessLoading = false;
		}
	}

	function addAllowedUser() {
		const id = Number(newAllowedUserId.trim());
		if (!Number.isFinite(id) || id <= 0) {
			accessError = 'User ID must be a positive number.';
			return;
		}
		accessError = '';
		if (accessDraft.allowedUsers.some((u) => u.userId === id)) {
			accessStatus = 'That user is already in the allow list.';
			return;
		}
		accessDraft.allowedUsers = [
			...accessDraft.allowedUsers,
			{ userId: id, username: newAllowedUsername.trim() || String(id) }
		];
		newAllowedUserId = '';
		newAllowedUsername = '';
	}

	function removeAllowedUser(id: number) {
		accessDraft.allowedUsers = accessDraft.allowedUsers.filter((u) => u.userId !== id);
	}

	async function saveAccess() {
		const tk = token();
		if (!tk) return;
		accessSaving = true;
		accessError = '';
		accessStatus = '';
		try {
			const next: CommunityNodeAccessPolicy = {
				mode: accessDraft.mode,
				allowedUsers: accessDraft.allowedUsers.map((u) => ({ ...u }))
			};
			const saved = await saveAdminPolicy<CommunityNodeAccessPolicy>(tk, 'community_node_access', next);
			accessConfig = saved;
			accessDraft = { mode: saved.mode, allowedUsers: [...(saved.allowedUsers || [])] };
			accessStatus = 'Saved community node access policy.';
		} catch (e) {
			accessError = (e as Error).message || 'Failed to save access policy';
		} finally {
			accessSaving = false;
		}
	}

	onMount(() => {
		void refreshUploadLimits();
		void refreshDownloadLimits();
		void refreshAnnouncements();
		void refreshAccess();
	});
</script>

<div class="server-policy">
	<section class="sp-section">
		<h3 class="sp-heading">Upload Limits</h3>
		<p class="sp-help">Maximum upload size per role in MB. Leave a field blank for unlimited. Enforced on the backend.</p>
		{#if uploadLoading}
			<p class="sp-muted">Loading…</p>
		{:else}
			<div class="sp-limit-grid">
				{#each uploadRoleOrder as tier}
					<label class="sp-limit-row">
						<span>{uploadRoleLabels[tier]}</span>
						<input
							class="sp-input"
							type="number"
							min="1"
							step="1"
							placeholder="Unlimited"
							value={uploadLimitInputs[tier]}
							on:input={(e) => (uploadLimitInputs[tier] = (e.currentTarget as HTMLInputElement).value)}
							disabled={!canManageAdmin || uploadLoading || uploadSaving}
						/>
					</label>
				{/each}
				<label class="sp-limit-row">
					<span>Global Cap</span>
					<input
						class="sp-input"
						type="number"
						min="1"
						step="1"
						placeholder="Unlimited"
						value={globalUploadLimitInput}
						on:input={(e) => (globalUploadLimitInput = (e.currentTarget as HTMLInputElement).value)}
						disabled={!canManageAdmin || uploadLoading || uploadSaving}
					/>
				</label>
			</div>
			<button class="sp-btn" on:click={saveUploadLimits} disabled={!canManageAdmin || uploadLoading || uploadSaving}>
				{uploadSaving ? 'Saving…' : 'Save Upload Limits'}
			</button>
		{/if}
		{#if uploadError}<p class="sp-error">{uploadError}</p>{/if}
		{#if uploadStatus}<p class="sp-status">{uploadStatus}</p>{/if}
	</section>

	<section class="sp-section">
		<h3 class="sp-heading">Download Limits</h3>
		<p class="sp-help">Maximum download size per role in MB. Leave a field blank for unlimited.</p>
		{#if downloadLoading}
			<p class="sp-muted">Loading…</p>
		{:else}
			<div class="sp-limit-grid">
				{#each uploadRoleOrder as tier}
					<label class="sp-limit-row">
						<span>{uploadRoleLabels[tier]}</span>
						<input
							class="sp-input"
							type="number"
							min="1"
							step="1"
							placeholder="Unlimited"
							value={downloadLimitInputs[tier]}
							on:input={(e) => (downloadLimitInputs[tier] = (e.currentTarget as HTMLInputElement).value)}
							disabled={!canManageAdmin || downloadLoading || downloadSaving}
						/>
					</label>
				{/each}
				<label class="sp-limit-row">
					<span>Global Cap</span>
					<input
						class="sp-input"
						type="number"
						min="1"
						step="1"
						placeholder="Unlimited"
						value={globalDownloadLimitInput}
						on:input={(e) => (globalDownloadLimitInput = (e.currentTarget as HTMLInputElement).value)}
						disabled={!canManageAdmin || downloadLoading || downloadSaving}
					/>
				</label>
			</div>
			<button class="sp-btn" on:click={saveDownloadLimits} disabled={!canManageAdmin || downloadLoading || downloadSaving}>
				{downloadSaving ? 'Saving…' : 'Save Download Limits'}
			</button>
		{/if}
		{#if downloadError}<p class="sp-error">{downloadError}</p>{/if}
		{#if downloadStatus}<p class="sp-status">{downloadStatus}</p>{/if}
	</section>

	<section class="sp-section">
		<h3 class="sp-heading">Community Node Announcements</h3>
		<p class="sp-help">Broadcast server online/offline status to a channel.</p>
		{#if announcementsLoading}
			<p class="sp-muted">Loading…</p>
		{:else}
			<label class="sp-toggle">
				<input
					type="checkbox"
					bind:checked={announcementsDraft.enabled}
					disabled={!canManageAdmin || announcementsSaving}
				/>
				<span>Enabled</span>
			</label>
			<label class="sp-field">
				<span>Channel ID</span>
				<input
					class="sp-input"
					type="text"
					placeholder="channel id"
					bind:value={announcementsDraft.channelId}
					disabled={!canManageAdmin || announcementsSaving}
				/>
			</label>
			<label class="sp-field">
				<span>Online Template</span>
				<textarea
					class="sp-input sp-textarea"
					rows="2"
					bind:value={announcementsDraft.onlineTemplate}
					disabled={!canManageAdmin || announcementsSaving}
				></textarea>
			</label>
			<label class="sp-field">
				<span>Offline Template</span>
				<textarea
					class="sp-input sp-textarea"
					rows="2"
					bind:value={announcementsDraft.offlineTemplate}
					disabled={!canManageAdmin || announcementsSaving}
				></textarea>
			</label>
			<button class="sp-btn" on:click={saveAnnouncements} disabled={!canManageAdmin || announcementsSaving}>
				{announcementsSaving ? 'Saving…' : 'Save Announcements Policy'}
			</button>
		{/if}
		{#if announcementsError}<p class="sp-error">{announcementsError}</p>{/if}
		{#if announcementsStatus}<p class="sp-status">{announcementsStatus}</p>{/if}
	</section>

	<section class="sp-section">
		<h3 class="sp-heading">Community Node Access</h3>
		<p class="sp-help">Control who may register community nodes.</p>
		{#if accessLoading}
			<p class="sp-muted">Loading…</p>
		{:else}
			<label class="sp-field">
				<span>Mode</span>
				<select class="sp-input" bind:value={accessDraft.mode} disabled={!canManageAdmin || accessSaving}>
					<option value="open">Open</option>
					<option value="approval_required">Approval required</option>
					<option value="whitelist_only">Whitelist only</option>
				</select>
			</label>
			<div class="sp-allowed">
				<span class="sp-sub">Allowed Users</span>
				{#if accessDraft.allowedUsers.length === 0}
					<p class="sp-muted">No users whitelisted.</p>
				{:else}
					<ul class="sp-allowed-list">
						{#each accessDraft.allowedUsers as user (user.userId)}
							<li class="sp-allowed-item">
								<span>{user.username} <span class="sp-muted">#{user.userId}</span></span>
								<button
									class="sp-btn-small"
									on:click={() => removeAllowedUser(user.userId)}
									disabled={!canManageAdmin || accessSaving}
								>
									Remove
								</button>
							</li>
						{/each}
					</ul>
				{/if}
				<div class="sp-add-row">
					<input
						class="sp-input sp-input-sm"
						type="number"
						min="1"
						placeholder="User ID"
						bind:value={newAllowedUserId}
						disabled={!canManageAdmin || accessSaving}
					/>
					<input
						class="sp-input sp-input-sm"
						type="text"
						placeholder="Username (optional)"
						bind:value={newAllowedUsername}
						disabled={!canManageAdmin || accessSaving}
					/>
					<button class="sp-btn-small" on:click={addAllowedUser} disabled={!canManageAdmin || accessSaving}>
						Add
					</button>
				</div>
			</div>
			<button class="sp-btn" on:click={saveAccess} disabled={!canManageAdmin || accessSaving}>
				{accessSaving ? 'Saving…' : 'Save Access Policy'}
			</button>
		{/if}
		{#if accessError}<p class="sp-error">{accessError}</p>{/if}
		{#if accessStatus}<p class="sp-status">{accessStatus}</p>{/if}
	</section>
</div>

<style>
	.server-policy {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}
	.sp-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px;
		background: var(--surface-raised, #302b63);
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		border-radius: var(--radius-md, 12px);
	}
	.sp-heading {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text-heading, #e0e0ff);
	}
	.sp-sub {
		font-size: 0.8rem;
		color: var(--text-secondary, #b3b3ff);
	}
	.sp-help {
		margin: 0;
		font-size: 0.72rem;
		color: var(--text-muted, #9999ff);
	}
	.sp-muted {
		font-size: 0.75rem;
		color: var(--text-muted, #9999ff);
		margin: 0;
	}
	.sp-limit-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 10px;
	}
	.sp-limit-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.75rem;
		color: var(--text-secondary, #b3b3ff);
	}
	.sp-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.75rem;
		color: var(--text-secondary, #b3b3ff);
	}
	.sp-input {
		background: var(--surface-base, #24243e);
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		border-radius: var(--radius-sm, 6px);
		color: var(--text-heading, #e0e0ff);
		padding: 6px 8px;
		font-size: 0.8rem;
	}
	.sp-input:focus {
		outline: 2px solid var(--accent-primary, #6366f1);
		outline-offset: 1px;
	}
	.sp-textarea {
		resize: vertical;
		font-family: inherit;
	}
	.sp-input-sm {
		flex: 1;
		min-width: 80px;
	}
	.sp-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		color: var(--text-secondary, #b3b3ff);
	}
	.sp-btn {
		align-self: flex-start;
		background: var(--accent-primary, #6366f1);
		color: #fff;
		border: none;
		border-radius: var(--radius-sm, 6px);
		padding: 8px 14px;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
	}
	.sp-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.sp-btn-small {
		background: var(--surface-base, #24243e);
		color: var(--text-secondary, #b3b3ff);
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		border-radius: var(--radius-sm, 6px);
		padding: 4px 8px;
		font-size: 0.72rem;
		cursor: pointer;
	}
	.sp-allowed {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.sp-allowed-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.sp-allowed-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 0.78rem;
		color: var(--text-heading, #e0e0ff);
		padding: 6px 8px;
		background: var(--surface-base, #24243e);
		border-radius: var(--radius-sm, 6px);
	}
	.sp-add-row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.sp-error {
		margin: 0;
		font-size: 0.74rem;
		color: var(--color-danger, #ef4444);
	}
	.sp-status {
		margin: 0;
		font-size: 0.74rem;
		color: var(--color-success, #22c55e);
	}
</style>
