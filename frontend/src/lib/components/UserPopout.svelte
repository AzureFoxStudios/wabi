<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import {
		channelMessages,
		channels,
		createDM,
		currentChannel,
		currentUser,
		dmPanelSignal,
		getDMChannelIdForUser,
		roleDefinitions,
		socket,
		type Message,
		type User
	} from '$lib/socket';
	import { startCall } from '$lib/calling';
	import { startScreenShare } from '$lib/calling';
	import { browser } from '$app/environment';
	import { get } from 'svelte/store';
	import { onMount, onDestroy } from 'svelte';
	import { _ } from '$lib/i18n';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import {
		MAX_USER_NOTE_LENGTH,
		clearUserNote as clearStoredUserNote,
		getUserNote,
		setUserNote
	} from '$lib/userNotes';
	import {
		MAX_LOCAL_NICKNAME_LENGTH,
		clearLocalNicknameForUser,
		getLocalNicknameForUser,
		getUserIdentityKey,
		localNicknamesStore,
		setLocalNicknameForUser
	} from '$lib/localNicknames';

	export let user: User | null = null;
	export let isOpen = false;
	export let anchorElement: HTMLElement | null = null;
	export let isOwnProfile = false;

	const dispatch = createEventDispatcher();

	let popoutElement: HTMLElement;
	let position = { top: 0, left: 0 };
	let userNote = '';
	let userNoteDraft = '';
	let userNoteStatus = '';
	let lastLoadedUserId = '';
	type ConnectionRow = { label: string; value: string; url?: string };
	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};

	$: roleLabelMap = (() => {
		const labels: Record<string, string> = { ...fallbackRoleLabels };
		for (const role of $roleDefinitions) {
			labels[role.roleName] = role.displayName;
		}
		return labels;
	})();

	function messageBelongsToUser(message: Message, candidate: User): boolean {
		if (!message || !candidate) return false;
		if (message.userId && candidate.id && message.userId === candidate.id) return true;
		if (
			message.userId &&
			candidate.dbUserId &&
			message.userId === `user-${candidate.dbUserId}`
		) {
			return true;
		}
		return message.user.trim().toLowerCase() === candidate.username.trim().toLowerCase();
	}

	function formatLastMessageTimestamp(timestamp: number | null): string {
		if (!timestamp) return get(_)('user.popout.no_recent_messages');
		return new Date(timestamp).toLocaleString();
	}

	function extractBioLinks(rawBio?: string): ConnectionRow[] {
		if (!rawBio) return [];
		const matches = rawBio.match(/https?:\/\/[^\s)]+/gi) || [];
		const deduped: string[] = [];
		for (const match of matches) {
			if (!deduped.includes(match)) deduped.push(match);
		}
		return deduped.slice(0, 4).map((link) => {
			let host = link;
			try {
				host = new URL(link).hostname.replace(/^www\./, '');
			} catch {
				// no-op
			}
			return {
				label: host,
				value: link,
				url: link
			};
		});
	}

	function buildConnectionsRows(candidate: User): ConnectionRow[] {
		const rows: ConnectionRow[] = [];
		if (candidate.handle) {
			rows.push({
				label: 'Wabi',
				value: `@${candidate.handle}`
			});
		}
		for (const row of extractBioLinks(candidate.bio)) {
			rows.push(row);
		}
		return rows;
	}

	$: activeChannelMessages = $channelMessages[$currentChannel] || [];
	$: lastMessageTimestamp =
		user && $displayEnhancementSettingsStore.lastMessageDateEnabled
			? (() => {
				for (let i = activeChannelMessages.length - 1; i >= 0; i -= 1) {
					const candidateMessage = activeChannelMessages[i];
					if (messageBelongsToUser(candidateMessage, user)) {
						return candidateMessage.timestamp;
					}
				}
				return null;
			})()
			: null;
	$: connectionRows =
		user && $displayEnhancementSettingsStore.showConnectionsEnabled
			? buildConnectionsRows(user)
			: [];
	$: localNickname = (() => {
		if (!user || !$displayEnhancementSettingsStore.localNicknamesEnabled) return '';
		const identityKey = getUserIdentityKey(user);
		return identityKey ? $localNicknamesStore[identityKey] || '' : '';
	})();
	$: popoutDisplayName = localNickname || user?.username || '';
	$: popoutTopRoleName = getUserTopRoleName(user ?? undefined);

	$: if (user?.id && browser && user.id !== lastLoadedUserId) {
		loadUserNote();
		lastLoadedUserId = user.id;
	}

	$: if (!user?.id) {
		lastLoadedUserId = '';
		userNote = '';
		userNoteDraft = '';
		userNoteStatus = '';
	}

	$: if (isOpen && anchorElement) {
		calculatePosition();
	}

	function loadUserNote() {
		if (!browser || !user) return;
		const note = getUserNote(user.id);
		userNote = note;
		userNoteDraft = note;
		userNoteStatus = '';
	}

	function saveUserNoteDraft() {
		if (!browser || !user) return;
		const saved = setUserNote(user.id, userNoteDraft);
		userNote = saved;
		userNoteDraft = saved;
		userNoteStatus = saved
			? 'Note saved locally on this device.'
			: 'Note cleared.';
	}

	function clearUserNoteDraft() {
		if (!browser || !user) return;
		clearStoredUserNote(user.id);
		userNote = '';
		userNoteDraft = '';
		userNoteStatus = 'Note cleared.';
	}

	function promptSetLocalNickname(): void {
		if (!browser || !user || !$displayEnhancementSettingsStore.localNicknamesEnabled) return;
		const currentNickname = getLocalNicknameForUser(user);
		const draft = window.prompt(
			`Set local nickname (max ${MAX_LOCAL_NICKNAME_LENGTH} characters)`,
			currentNickname || user.username
		);
		if (draft === null) return;
		setLocalNicknameForUser(user, draft);
	}

	function clearLocalNickname(): void {
		if (!browser || !user) return;
		clearLocalNicknameForUser(user);
	}

	function calculatePosition() {
		if (!anchorElement) return;

		const rect = anchorElement.getBoundingClientRect();
		const popoutWidth = 340;
		const popoutHeight = 400; // approximate
		const padding = 8;

		// Default: position to the right of the anchor
		let left = rect.right + padding;
		let top = rect.top;

		// If it would overflow right, position to the left
		if (left + popoutWidth > window.innerWidth - padding) {
			left = rect.left - popoutWidth - padding;
		}

		// If it would overflow left, center it
		if (left < padding) {
			left = Math.max(padding, (window.innerWidth - popoutWidth) / 2);
		}

		// Vertical positioning - try to align with anchor, but keep in viewport
		if (top + popoutHeight > window.innerHeight - padding) {
			top = window.innerHeight - popoutHeight - padding;
		}
		if (top < padding) {
			top = padding;
		}

		position = { top, left };
	}

	function closePopout() {
		isOpen = false;
		dispatch('close');
	}

	function handleClickOutside(event: MouseEvent) {
		if (popoutElement && !popoutElement.contains(event.target as Node)) {
			closePopout();
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			closePopout();
		}
	}

	function openDM() {
		if (!user) return;
		const self = get(currentUser);
		if (!self || user.id === self.id) return;

		const dmId = getDMChannelIdForUser(self, user);

		const allChannels = get(channels);
		const existingDM = allChannels.find(ch => ch.id === dmId);

		if (existingDM) {
			if (existingDM.otherUser) {
				dmPanelSignal.set({ channelId: dmId, otherUser: existingDM.otherUser });
			}
		} else {
			createDM(user.id);
		}
		closePopout();
	}

	function openFullProfile() {
		dispatch('openFullProfile', { user, isOwnProfile });
		closePopout();
	}

	async function handleVoiceCall() {
		if (!user || !$socket || user.id === get(currentUser)?.id) return;
		try {
			await startCall($socket, getUserIdentityKey(user), false, { scope: 'dm', displayName: user.username });
			closePopout();
		} catch (error) {
			console.warn('[Call] Voice call failed to start:', error);
		}
	}

	async function handleVideoCall() {
		if (!user || !$socket || user.id === get(currentUser)?.id) return;
		try {
			await startCall($socket, getUserIdentityKey(user), true, { scope: 'dm', displayName: user.username });
			closePopout();
		} catch (error) {
			console.warn('[Call] Video call failed to start:', error);
		}
	}

	async function handleScreenShare() {
		if (!user || !$socket || user.id === get(currentUser)?.id) return;
		try {
			await startScreenShare($socket);
			closePopout();
		} catch (error) {
			alert(get(_)('user.errors.screen_share_failed'));
		}
	}

	function copyUserId() {
		if (user && browser) {
			navigator.clipboard.writeText(user.id);
		}
	}

	function getStatusColor(status: string) {
		switch (status) {
			case 'active': return 'var(--status-online)';
			case 'away': return 'var(--status-away)';
			case 'busy': return 'var(--status-busy)';
			default: return 'var(--status-offline)';
		}
	}

	function getStatusLabel(status: string) {
		switch (status) {
			case 'active': return get(_)('user.status.online');
			case 'away': return get(_)('user.status.away');
			case 'busy': return get(_)('user.status.busy');
			default: return get(_)('user.status.offline');
		}
	}

	function getUserTopRoleName(candidate?: User | null): string {
		if (!candidate) return 'guest';
		if (candidate.highestRole) return candidate.highestRole;
		return candidate.dbUserId ? 'member' : 'guest';
	}

	function getUserTopRoleLabel(candidate: User): string {
		const roleName = getUserTopRoleName(candidate);
		return roleLabelMap[roleName] || roleName;
	}

	function roleToneClass(roleName: string): 'owner' | 'admin' | 'mod' | 'default' {
		if (roleName === 'owner') return 'owner';
		if (roleName === 'admin') return 'admin';
		if (roleName === 'mod') return 'mod';
		return 'default';
	}

	function isStaffRole(roleName: string): boolean {
		return roleName === 'owner' || roleName === 'admin' || roleName === 'mod';
	}

	onMount(() => {
		if (browser) {
			document.addEventListener('click', handleClickOutside);
			document.addEventListener('keydown', handleKeydown);
		}
	});

	onDestroy(() => {
		if (browser) {
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleKeydown);
		}
	});
</script>

{#if isOpen && user}
	<div
		class="popout-container"
		bind:this={popoutElement}
		style="top: {position.top}px; left: {position.left}px;"
		on:click|stopPropagation
	>
		<!-- Banner/Header Area -->
		<div class="popout-banner" style="background-color: {user.color || 'var(--accent)'}">
			<div class="banner-gradient"></div>
		</div>

		<!-- Avatar overlapping banner -->
		<div class="avatar-section">
			<div class="avatar-ring">
				{#if user.profilePicture}
					<img src={user.profilePicture} alt={popoutDisplayName} class="popout-avatar" />
				{:else}
					<div class="popout-avatar-placeholder" style="background-color: {user.color}">
						{popoutDisplayName.charAt(0).toUpperCase()}
					</div>
				{/if}
				<div class="status-badge" style="background-color: {getStatusColor(user.status)}"></div>
			</div>
		</div>

		<!-- User Info Card -->
		<div class="popout-body">
			<div class="username-section">
				<h3 class="display-name">{popoutDisplayName}</h3>
				{#if localNickname}
					<span class="local-identity-note">@{user.username}</span>
				{/if}
				<span class="username-tag">#{user.id.slice(-4)}</span>
			</div>
			{#if $displayEnhancementSettingsStore.topRoleEverywhereEnabled || ($displayEnhancementSettingsStore.staffTagEnabled && isStaffRole(popoutTopRoleName))}
				<div class="popout-role-tags">
					{#if $displayEnhancementSettingsStore.topRoleEverywhereEnabled}
						<span class={`popout-role-badge tone-${roleToneClass(popoutTopRoleName)}`}>
							{getUserTopRoleLabel(user)}
						</span>
					{/if}
					{#if $displayEnhancementSettingsStore.staffTagEnabled && isStaffRole(popoutTopRoleName)}
						<span class="popout-staff-tag">Staff</span>
					{/if}
				</div>
			{/if}

			<div class="status-section">
				<span class="status-indicator" style="background-color: {getStatusColor(user.status)}"></span>
				<span class="status-label">{getStatusLabel(user.status)}</span>
			</div>

			<div class="divider"></div>

			<!-- About Me / Bio section -->
			{#if user.bio}
				<div class="section">
					<h4 class="section-title">{$_('user.popout.about_me')}</h4>
					<p class="section-content">{user.bio}</p>
				</div>
			{/if}

			<!-- Personal Note (for other users) -->
			{#if !isOwnProfile && $displayEnhancementSettingsStore.userNotesEnabled}
				<div class="section">
					<h4 class="section-title">{$_('user.popout.note')}</h4>
					<textarea
						class="note-input"
						rows="3"
						maxlength={MAX_USER_NOTE_LENGTH}
						bind:value={userNoteDraft}
						placeholder="Add a private note about this user (local only)."
					></textarea>
					<div class="note-actions">
						<button
							class="note-btn primary"
							on:click={saveUserNoteDraft}
							disabled={userNoteDraft.trim() === userNote}
						>
							Save
						</button>
						<button
							class="note-btn"
							on:click={clearUserNoteDraft}
							disabled={!userNote && !userNoteDraft.trim()}
						>
							Clear
						</button>
						<span class="note-count">{userNoteDraft.length}/{MAX_USER_NOTE_LENGTH}</span>
					</div>
					{#if userNoteStatus}
						<p class="note-status">{userNoteStatus}</p>
					{:else if userNote}
						<p class="section-content note-content">{userNote}</p>
					{/if}
				</div>
			{/if}

			<!-- Member Since -->
			<div class="section">
				<h4 class="section-title">{$_('user.popout.member_since')}</h4>
				<p class="section-content">{new Date(user.joinedAt || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
			</div>

			{#if $displayEnhancementSettingsStore.lastMessageDateEnabled}
				<div class="section">
					<h4 class="section-title">{$_('user.popout.last_message')}</h4>
					<p class="section-content">{formatLastMessageTimestamp(lastMessageTimestamp)}</p>
				</div>
			{/if}

			{#if $displayEnhancementSettingsStore.showConnectionsEnabled}
				<div class="section">
					<h4 class="section-title">{$_('user.popout.connections')}</h4>
					{#if connectionRows.length === 0}
						<p class="section-content note-content">{$_('user.popout.no_connections')}</p>
					{:else}
						<div class="connections-list">
							{#each connectionRows as row (row.label + row.value)}
								<div class="connection-row">
									<span class="connection-label">{row.label}</span>
									{#if row.url}
										<a
											class="connection-link"
											href={row.url}
											target="_blank"
											rel="noopener noreferrer"
										>
											{row.value}
										</a>
									{:else}
										<span class="connection-value">{row.value}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			<div class="divider"></div>

			<!-- Actions -->
			<div class="actions">
				{#if !isOwnProfile}
					<button class="action-btn primary" on:click={openDM}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
							<path d="M4.79805 3C3.80445 3 2.99805 3.8055 2.99805 4.8V15.6C2.99805 16.5936 3.80445 17.4 4.79805 17.4H7.49805V21L11.098 17.4H19.198C20.1925 17.4 20.998 16.5936 20.998 15.6V4.8C20.998 3.8055 20.1925 3 19.198 3H4.79805Z"/>
						</svg>
						{$_('user.popout.message')}
					</button>
				{/if}
				<button class="action-btn secondary" on:click={openFullProfile}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
						<path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z"/>
					</svg>
					{isOwnProfile ? $_('user.popout.edit_profile') : $_('user.popout.view_full_profile')}
				</button>
			</div>

			<!-- Call Actions (only for other users) -->
			{#if !isOwnProfile}
				<div class="call-actions">
					<button class="call-btn voice-call" on:click={handleVoiceCall} title={$_('user.voice_call')}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
							<path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
						</svg>
						{$_('user.voice_call')}
					</button>
					<button class="call-btn video-call" on:click={handleVideoCall} title={$_('user.video_call')}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
							<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
						</svg>
						{$_('user.video_call')}
					</button>
					<button class="call-btn screen-share" on:click={handleScreenShare} title={$_('user.screen_share')}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
							<path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/>
						</svg>
						{$_('user.screen_share')}
					</button>
				</div>
			{/if}

			<!-- Context Menu Actions -->
			<div class="context-actions">
				{#if !isOwnProfile && $displayEnhancementSettingsStore.localNicknamesEnabled}
					<button class="context-btn" on:click={promptSetLocalNickname}>
						Set Local Nickname
					</button>
					{#if localNickname}
						<button class="context-btn danger" on:click={clearLocalNickname}>
							Clear Local Nickname
						</button>
					{/if}
				{/if}
				<button class="context-btn" on:click={copyUserId}>
					{$_('user.popout.copy_user_id')}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.popout-container {
		position: fixed;
		width: 340px;
		background: var(--bg-secondary);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		z-index: var(--z-popout);
		overflow: hidden;
		animation: popoutIn 0.15s ease-out;
	}

	@keyframes popoutIn {
		from {
			opacity: 0;
			transform: scale(0.95);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}

	.popout-banner {
		height: 60px;
		position: relative;
	}

	.banner-gradient {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 30px;
		background: linear-gradient(transparent, var(--bg-secondary));
	}

	.avatar-section {
		display: flex;
		justify-content: flex-start;
		padding: 0 16px;
		margin-top: -40px;
		position: relative;
		z-index: 1;
	}

	.avatar-ring {
		position: relative;
		width: 80px;
		height: 80px;
		border-radius: 50%;
		background: var(--bg-secondary);
		padding: 6px;
	}

	.popout-avatar,
	.popout-avatar-placeholder {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		object-fit: cover;
	}

	.popout-avatar-placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 2rem;
		font-weight: bold;
		color: white;
	}

	.status-badge {
		position: absolute;
		bottom: 4px;
		right: 4px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 4px solid var(--bg-secondary);
		box-sizing: content-box;
	}

	.popout-body {
		padding: 12px 16px 16px;
	}

	.username-section {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 4px;
		margin-bottom: 4px;
	}

	.display-name {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.username-tag {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.local-identity-note {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.popout-role-tags {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0 0 0.55rem;
	}

	.popout-role-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.14rem 0.46rem;
		border-radius: 999px;
		font-size: 0.64rem;
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		border: 1px solid transparent;
	}

	.popout-role-badge.tone-owner {
		background: color-mix(in srgb, #f0b429 22%, var(--bg-secondary));
		border-color: color-mix(in srgb, #f0b429 58%, transparent);
		color: #f7d98c;
	}

	.popout-role-badge.tone-admin {
		background: color-mix(in srgb, #4f9cff 20%, var(--bg-secondary));
		border-color: color-mix(in srgb, #4f9cff 52%, transparent);
		color: #cde0ff;
	}

	.popout-role-badge.tone-mod {
		background: color-mix(in srgb, #18a999 19%, var(--bg-secondary));
		border-color: color-mix(in srgb, #18a999 48%, transparent);
		color: #b6f0e9;
	}

	.popout-role-badge.tone-default {
		background: color-mix(in srgb, var(--accent) 14%, var(--bg-secondary));
		border-color: color-mix(in srgb, var(--accent) 42%, transparent);
		color: var(--text-secondary);
	}

	.popout-staff-tag {
		display: inline-flex;
		align-items: center;
		padding: 0.14rem 0.42rem;
		border-radius: 999px;
		font-size: 0.62rem;
		font-weight: 700;
		line-height: 1;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		border: 1px solid color-mix(in srgb, #ef5f5f 42%, transparent);
		background: color-mix(in srgb, #ef5f5f 16%, var(--bg-secondary));
		color: #ffc6c6;
	}

	.status-section {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 12px;
	}

	.status-indicator {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.status-label {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.divider {
		height: 1px;
		background: var(--border-color);
		margin: 12px 0;
	}

	.section {
		margin-bottom: 12px;
	}

	.section-title {
		margin: 0 0 4px 0;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		color: var(--text-secondary);
		letter-spacing: 0.02em;
	}

	.section-content {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-primary);
		line-height: 1.4;
	}

	.note-content {
		font-style: italic;
		color: var(--text-secondary);
	}

	.note-input {
		width: 100%;
		min-height: 64px;
		padding: 0.45rem 0.55rem;
		border-radius: 8px;
		border: 1px solid var(--border-color);
		background: var(--bg-tertiary);
		color: var(--text-primary);
		font-size: 0.82rem;
		line-height: 1.35;
		resize: vertical;
		box-sizing: border-box;
	}

	.note-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.note-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}

	.note-btn {
		border: 1px solid var(--border-color);
		background: var(--bg-tertiary);
		color: var(--text-secondary);
		border-radius: 999px;
		padding: 0.16rem 0.5rem;
		font-size: 0.72rem;
		cursor: pointer;
	}

	.note-btn.primary {
		color: var(--text-primary);
		background: color-mix(in srgb, var(--accent) 20%, var(--bg-tertiary));
		border-color: color-mix(in srgb, var(--accent) 50%, var(--border-color));
	}

	.note-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.note-count {
		margin-left: auto;
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.note-status {
		margin: 0.32rem 0 0;
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.connections-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.connection-row {
		display: flex;
		align-items: baseline;
		gap: 0.45rem;
		min-width: 0;
	}

	.connection-label {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.connection-value,
	.connection-link {
		font-size: 0.82rem;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.connection-link:hover {
		color: var(--accent);
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-bottom: 8px;
	}

	.action-btn {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 10px 16px;
		border: none;
		border-radius: 4px;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.action-btn.primary {
		background: var(--accent);
		color: white;
	}

	.action-btn.primary:hover {
		background: var(--accent-hover);
	}

	.action-btn.secondary {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	.action-btn.secondary:hover {
		background: var(--bg-hover);
	}

	.context-actions {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.context-btn {
		display: block;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		border-radius: 4px;
		font-size: 0.8125rem;
		color: var(--text-secondary);
		text-align: left;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.context-btn:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	.context-btn.danger {
		color: color-mix(in srgb, #ef4444 76%, var(--text-secondary));
	}

	.context-btn.danger:hover {
		background: color-mix(in srgb, #ef4444 16%, var(--bg-tertiary));
		color: #fca5a5;
	}

	.call-actions {
		display: flex;
		gap: 6px;
		margin-bottom: 8px;
	}

	.call-btn {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 8px 10px;
		border: none;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
		background: var(--bg-tertiary);
		color: var(--text-secondary);
	}

	.call-btn:hover {
		color: white;
	}

	.call-btn.voice-call:hover {
		background: var(--color-success, #43b581);
	}

	.call-btn.video-call:hover {
		background: var(--color-info, #5865f2);
	}

	.call-btn.screen-share:hover {
		background: var(--color-warning, #faa61a);
	}
</style>
