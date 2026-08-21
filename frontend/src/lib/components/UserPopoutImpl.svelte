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
	import { brandName } from '$lib/branding';
	import UserPopoutActions from './UserPopoutActions.svelte';
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
	let profileExpanded = false;
	let disableAllBanners = false;
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
		return (message.user ?? '').trim().toLowerCase() === (candidate.username ?? '').trim().toLowerCase();
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
				label: brandName,
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
		profileExpanded = false;
	}

	$: if (!user?.id) {
		lastLoadedUserId = '';
		userNote = '';
		userNoteDraft = '';
		userNoteStatus = '';
		profileExpanded = false;
	}

	$: if (isOpen && anchorElement) {
		calculatePosition();
	}

	function handleViewportChange(): void {
		if (isOpen) calculatePosition();
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

		const dmId = "";

		const allChannels = get(channels);
		const existingDM = allChannels.find(ch => ch.id === dmId);

		if (existingDM) {
			if (existingDM.otherUser) {
				dmPanelSignal.set({ channelId: dmId, otherUser: existingDM.otherUser });
			}
		} else {
			undefined;
		}
		closePopout();
	}

	function openFullProfile() {
		if (isOwnProfile) {
			dispatch('openFullProfile', { user, isOwnProfile });
			closePopout();
			return;
		}
		profileExpanded = !profileExpanded;
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
			window.addEventListener('resize', handleViewportChange);
			window.addEventListener('scroll', handleViewportChange, true);
		}
	});

	onDestroy(() => {
		if (browser) {
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('resize', handleViewportChange);
			window.removeEventListener('scroll', handleViewportChange, true);
		}
	});
</script>

{#if isOpen && user}
	<div
		class="popout-container"
		bind:this={popoutElement}
		style="top: {position.top}px; left: {position.left}px;"
		role="dialog"
		aria-label="User profile"
		tabindex="-1"
		on:click|stopPropagation
		on:keydown|stopPropagation
	>
		<!-- Banner/Header Area -->
		<div class="popout-banner" style="--banner-color: {user.color || 'var(--pfp-banner)'}">
			<div class="banner-gradient"></div>
			{#if user.bannerUrl && !disableAllBanners}
				<img src={user.bannerUrl} alt="Profile banner" class="popout-banner-img" />
			{/if}
		</div>

		<!-- Avatar overlapping banner -->
		<div class="avatar-section">
			<div class="avatar-ring">
				{#if user.profilePicture}
					<img src={user.profilePicture} alt={popoutDisplayName} class="popout-avatar" />
				{:else}
					<div class="popout-avatar-placeholder" style="--avatar-color: {user.color}">
						{popoutDisplayName.charAt(0).toUpperCase()}
					</div>
				{/if}
				{#if user.overlayUrl && !disableAllBanners}
					<span class="popout-avatar-overlay" style="background-image: url({user.overlayUrl})" aria-hidden="true"></span>
				{/if}
			</div>
		</div>

		<!-- User Info Card -->
		<div class="popout-body">
			<div class="username-section">
				<h3 class="display-name">{popoutDisplayName}</h3>
				<span class="username-handle">@{user.handle || user.username}</span>
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

			{#if profileExpanded}
				<div class="profile-detail-grid">
					<div>
						<span>Status</span>
						<strong>{getStatusLabel(user.status)}</strong>
					</div>
					<div>
						<span>Role</span>
						<strong>{getUserTopRoleLabel(user)}</strong>
					</div>
					<div>
						<span>Handle</span>
						<strong>{user.handle ? `@${user.handle}` : 'Not set'}</strong>
					</div>
					<div>
						<span>User ID</span>
						<strong>{user.id.slice(-8)}</strong>
					</div>
				</div>
			{/if}

			<div class="status-section">
				<span class="status-indicator" style="--status-color: {getStatusColor(user.status)}"></span>
				<span class="status-label status-label-tooltip" title={getStatusLabel(user.status)} aria-label={getStatusLabel(user.status)}></span>
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

			<span class="member-since-ghost">Member since {new Date(user.joinedAt || Date.now()).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>

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

			<UserPopoutActions
				{isOwnProfile}
				{profileExpanded}
				{user}
				{localNickname}
				localNicknamesEnabled={$displayEnhancementSettingsStore.localNicknamesEnabled}
				onOpenDM={openDM}
				onOpenFullProfile={openFullProfile}
				onOpenSettings={openFullProfile}
				onVoiceCall={handleVoiceCall}
				onVideoCall={handleVideoCall}
				onScreenShare={handleScreenShare}
				onSetLocalNickname={promptSetLocalNickname}
				onClearLocalNickname={clearLocalNickname}
			/>
		</div>
	</div>
{/if}
