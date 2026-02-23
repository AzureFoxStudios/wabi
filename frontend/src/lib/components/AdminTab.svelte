<script lang="ts">
	import { onMount } from 'svelte';
	import { channels, currentUser, createDM, assignRole, removeUserRole, type User, updateChannelSettings, sendMessage, channelMessages } from '$lib/socket';
	import { users } from '$lib/socket';
	import { emojis } from '$lib/emoji-store';
	import { getSocket } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { _ } from '$lib/i18n';
	import {
		getAdminPolicy,
		getAdminCompressionConfig,
		getAdminCompressionMetrics,
		getAdminRuntimeGuardrails,
		resetAdminCompressionMetrics,
		saveAdminPolicy,
		type AdminCompressionConfig,
		type AdminCompressionMetrics,
		type AdminRuntimeGuardrailsResponse,
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

	function handleMessage(user: User) {
		createDM(user.id);
		layoutStore.showDMsTab();
	}

	function promoteUser(user: User, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		assignRole(user.dbUserId, role);
	}

	function removeRoleFromUser(user: User, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, role);
	}

	function resetToMember(user: User) {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, 'admin');
		removeUserRole(user.dbUserId, 'mod');
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
		const token = localStorage.getItem('authToken');
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
		const token = localStorage.getItem('authToken');
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
		const token = localStorage.getItem('authToken');
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
		const token = localStorage.getItem('authToken');
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
				</div>
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
					</div>
					<div class="admin-actions">
						<button class="admin-btn" on:click={() => handleMessage(user)}>{$_('admin.actions.message')}</button>
						{#if canManageRoles}
							<button
								class="admin-btn"
								disabled={!canManageTargetUser(user) || userHasRole(user, 'admin')}
								on:click={() => promoteUser(user, 'admin')}
							>
								{$_('admin.actions.make_admin')}
							</button>
							<button
								class="admin-btn"
								disabled={!canManageTargetUser(user) || !userHasRole(user, 'admin')}
								on:click={() => removeRoleFromUser(user, 'admin')}
							>
								{$_('admin.actions.remove_admin')}
							</button>
							<button
								class="admin-btn"
								disabled={!canManageTargetUser(user) || userHasRole(user, 'mod')}
								on:click={() => promoteUser(user, 'mod')}
							>
								{$_('admin.actions.make_mod')}
							</button>
							<button
								class="admin-btn"
								disabled={!canManageTargetUser(user) || !userHasRole(user, 'mod')}
								on:click={() => removeRoleFromUser(user, 'mod')}
							>
								{$_('admin.actions.remove_mod')}
							</button>
							<button
								class="admin-btn danger"
								disabled={!canManageTargetUser(user) || (!userHasRole(user, 'admin') && !userHasRole(user, 'mod'))}
								on:click={() => resetToMember(user)}
							>
								{$_('admin.actions.reset')}
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
	.admin-stat { display: flex; flex-direction: column; padding: 0.4rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-tertiary); }
	.admin-stat .k { font-size: 0.65rem; text-transform: uppercase; color: var(--text-secondary); }
	.admin-stat .v { font-size: 0.9rem; font-weight: 700; color: var(--text-primary); }
	.admin-section { border: 1px solid var(--border); border-radius: 10px; padding: 0.55rem; background: var(--bg-secondary); display: flex; flex-direction: column; gap: 0.45rem; }
	.admin-section h4 { margin: 0; font-size: 0.8rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; }
	.compression-header { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; }
	.compression-actions { display: inline-flex; gap: 0.35rem; }
	.compression-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.35rem; }
	.compression-stat { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.4rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-tertiary); }
	.compression-stat .k { font-size: 0.64rem; text-transform: uppercase; color: var(--text-secondary); letter-spacing: 0.03em; }
	.compression-stat .v { font-size: 0.78rem; color: var(--text-primary); font-weight: 600; }
	.runtime-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.45rem; }
	.runtime-form-grid label { display: flex; flex-direction: column; gap: 0.28rem; font-size: 0.72rem; color: var(--text-secondary); }
	.runtime-form-grid input[type='number'] { height: 28px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); border-radius: 7px; padding: 0 0.45rem; font-size: 0.76rem; }
	.runtime-checkbox { grid-column: 1 / -1; flex-direction: row !important; align-items: center; gap: 0.45rem !important; }
	.runtime-hint { font-size: 0.72rem; color: var(--text-secondary); }
	.role-list, .channel-role-list, .emoji-rule-list, .admin-user-list { display: flex; flex-direction: column; gap: 0.35rem; }
	.role-item, .channel-role-item, .emoji-rule-item, .admin-user-item { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; padding: 0.45rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-tertiary); }
	.role-key { width: 80px; font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; }
	.role-input, .channel-role-select, .admin-select, .admin-search { border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); border-radius: 7px; font-size: 0.78rem; }
	.role-input { flex: 1; height: 28px; padding: 0 0.5rem; }
	.channel-role-meta { display: inline-flex; gap: 0.5rem; align-items: center; }
	.channel-name { font-weight: 600; font-size: 0.8rem; color: var(--text-primary); }
	.channel-type { font-size: 0.68rem; color: var(--text-secondary); text-transform: uppercase; }
	.channel-role-select, .admin-select { height: 28px; padding: 0 0.45rem; }
	.emoji-rule-create { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.rule-checkbox { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.74rem; color: var(--text-secondary); }
	.admin-user-meta { display: inline-flex; align-items: center; gap: 0.35rem; }
	.admin-user-name { font-size: 0.84rem; font-weight: 600; color: var(--text-primary); }
	.admin-role-badge, .admin-guest-badge { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.03em; padding: 0.12rem 0.35rem; border-radius: 999px; border: 1px solid var(--border); color: var(--text-secondary); }
	.admin-guest-badge { background: rgba(255, 193, 7, 0.12); border-color: rgba(255, 193, 7, 0.35); }
	.admin-actions { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.admin-btn { height: 26px; padding: 0 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-secondary); color: var(--text-secondary); font-size: 0.72rem; font-weight: 600; cursor: pointer; }
	.admin-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
	.admin-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.admin-btn.danger:hover:not(:disabled) { color: #f44336; border-color: rgba(244, 67, 54, 0.4); background: rgba(244, 67, 54, 0.08); }
	.admin-search-wrap { padding: 0.1rem 0; }
	.admin-search { width: 100%; height: 30px; padding: 0 0.55rem; }
	.admin-empty { padding: 0.8rem; text-align: center; color: var(--text-secondary); font-size: 0.78rem; }
	@media (max-width: 768px) {
		.admin-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
		.runtime-form-grid { grid-template-columns: 1fr; }
	}
</style>
