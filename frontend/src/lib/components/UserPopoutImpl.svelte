<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { showToast } from '$lib/toast';
	async function copyHandle() {
		try { await navigator.clipboard.writeText(`@${liveUser?.handle || liveUser?.username}`); showToast('Handle copied.', 'info', 1200); }
		catch { showToast('Could not copy handle.', 'error', 3000); }
	}
	import {
		channels,
		createDM,
		currentUser,
		dmPanelSignal,
		roleDefinitions,
		serverMembers,
		socket,
		users,
		type User
	} from '$lib/socket';
	import { startCall } from '$lib/calling';
	import { startScreenShare } from '$lib/calling';
	import { browser } from '$app/environment';
	import { portal } from '$lib/actions/portal';
	import { openProfilePanel } from '$lib/profilePanelNavigation';
	import { profileIdentity, sameProfileIdentity } from '$lib/profilePanelController';
	import { activeServerUrl } from '$lib/serverUrl';
	import { get } from 'svelte/store';
	import { profileDecorationsVisible } from '$lib/profileAppearance';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import ProfileMedia from '$lib/components/ProfileMedia.svelte';
	import ProfileDecoration from '$lib/components/ProfileDecoration.svelte';
	import { onMount, onDestroy, tick } from 'svelte';
	import { _ } from '$lib/i18n';
	import { currentSavedServer } from '$lib/savedServers';
	import BadgeMark from '$lib/components/BadgeMark.svelte';
	import { ownerBadgeMark, staffBadgeMark } from '$lib/badgeMarks';
	import UserPopoutActions from './UserPopoutActions.svelte';
	import RoleBadge from '$lib/components/RoleBadge.svelte';
	import { requestLiveRoleChange, selectAssignableRoles } from './userListHelpers';
	import { attachUserBanListeners, bannedUserIds } from '$lib/presenceStore';
	import { mediaUrl } from '$lib/mediaUrl';
	import { resolveDmEntry } from '$lib/dmEntry';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import {
		MAX_USER_NOTE_LENGTH,
		forgetUserNoteDraft, getUserNoteDraft, retainUserNoteDraft, hasLegacyUserNotes, stableUserNoteSubject,
		getUserNote,
		setUserNote
	} from '$lib/userNotes';
	import { notebookOwner } from '$lib/notes/scope';
	import type { NotebookOwner } from '$lib/notes/types';
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
	export let surface: 'popout' | 'panel' = 'popout';

	const dispatch = createEventDispatcher();

	let popoutElement: HTMLElement;
	let position = { top: 0, left: 0 };
	let userNote = '';
	let userNoteDraft = '';
	let userNoteStatus = '';
	let lastLoadedUserId = '';
	let noteOwner: NotebookOwner | null = null;
	let noteSubject = '';
	let noteRevision = 0;
	let noteBusy = false;
	let noteReady = false;
	let noteLoad = 0;
	let legacyNotesFound = false;
	let profileExpanded = false;
	let retired = false;
	$: completeProfile = profileExpanded || surface === 'panel';
	$: noteDraftSurface = surface === 'panel' ? 'panel' : 'profile';
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


	$: connectionRows =
		liveUser && $displayEnhancementSettingsStore.showConnectionsEnabled
			? extractBioLinks(liveUser.bio)
			: [];
	$: localNickname = (() => {
		if (!user || !$displayEnhancementSettingsStore.localNicknamesEnabled) return '';
		const identityKey = getUserIdentityKey(user);
		return identityKey ? $localNicknamesStore[identityKey] || '' : '';
	})();
	$: popoutDisplayName = localNickname || liveUser?.username || user?.username || '';
	$: popoutTopRoleName = getUserTopRoleName(liveUser ?? undefined);
	$: ownerMark = ownerBadgeMark($currentSavedServer?.frontendMetadata);
	$: staffMark = staffBadgeMark($currentSavedServer?.frontendMetadata);
	// Live-sync status/avatar: the `user` prop is captured at click time and
	// goes stale when presence changes. Resolve the freshest roster entry by
	// id so the dot and label track the real status.
	$: liveUser =
		(user && sameProfileIdentity($currentUser, user) ? $currentUser : null) ||
		(user && $users.find((candidate) => sameProfileIdentity(candidate, user))) ||
		(user && $serverMembers.find((candidate) => sameProfileIdentity(candidate, user))) || user || null;
	$: popoutStatus = liveUser?.status || user?.status || 'offline';

	$: if (browser) {
		const subject = stableUserNoteSubject(user?.dbUserId);
		const owner = $notebookOwner.owner;
		const identity = JSON.stringify([owner?.scopeId, subject, isOpen, noteDraftSurface]);
		if (identity !== lastLoadedUserId || noteOwner !== owner) {
			lastLoadedUserId = identity;
			void loadUserNote(owner, subject);
			profileExpanded = false;
		}
	}

	$: if (surface === 'popout' && isOpen && anchorElement) {
		// The popout node may not be laid out yet at this reactive tick —
		// measure AFTER paint so offsetHeight is real (a 0-height measure
		// fell back to 400 and clipped tall popouts off-screen).
		calculatePosition();
		void tick().then(() => calculatePosition());
	}

	// Expanding the profile (or any height change) must re-clamp the popout
	// into the viewport, otherwise the bottom runs off-screen again.
	$: if (surface === 'popout' && isOpen && profileExpanded) {
		void tick().then(() => calculatePosition());
	}

	function handleViewportChange(): void {
		if (surface === 'popout' && isOpen) calculatePosition();
	}

	async function loadUserNote(owner: NotebookOwner | null, subject: string | null) {
		const ticket = ++noteLoad;
		noteOwner = owner; noteSubject = subject || ''; noteReady = false;
		userNote = ''; userNoteDraft = ''; noteRevision = 0; noteBusy = false;
		legacyNotesFound = hasLegacyUserNotes();
		if (!owner || !subject) {
			userNoteStatus = !subject ? 'Personal notes need a stable account identity; this profile does not provide one.' : ($notebookOwner.error || 'Waiting for your notebook account.');
			return;
		}
		const retained = getUserNoteDraft(owner, subject, noteDraftSurface);
		if (retained) {
			userNoteDraft = retained.text;
			noteRevision = retained.baseRevision;
			noteReady = true;
		}
		userNoteStatus = 'Loading personal note…';
		try {
			const saved = await getUserNote(owner, subject);
			if (ticket !== noteLoad || !owner.isCurrent()) return;
			const draft = getUserNoteDraft(owner, subject, noteDraftSurface);
			userNote = saved.text;
			userNoteDraft = draft?.text ?? saved.text;
			noteRevision = draft?.baseRevision ?? saved.revision;
			noteReady = true;
			userNoteStatus = draft ? 'Unsaved draft restored in this session.' : 'On this device · personal to this server/account';
		} catch (error) {
			if (ticket === noteLoad) userNoteStatus = error instanceof Error ? error.message : 'Could not load this personal note.';
		}
	}

	function retainNoteDraft() {
		if (!noteOwner || !noteSubject || !noteReady) return;
		retainUserNoteDraft(noteOwner, noteSubject, { text: userNoteDraft, baseRevision: noteRevision }, noteDraftSurface);
		userNoteStatus = 'Unsaved on this device. Save or download before leaving.';
	}

	async function saveUserNoteDraft() {
		if (!noteOwner || !noteSubject || !noteReady || noteBusy) return;
		const owner = noteOwner, subject = noteSubject, ticket = noteLoad, text = userNoteDraft, revision = noteRevision, draftSurface = noteDraftSurface;
		retainNoteDraft(); noteBusy = true; userNoteStatus = 'Saving…';
		try {
			const saved = await setUserNote(owner, subject, text, revision);
			const retained = getUserNoteDraft(owner, subject, draftSurface);
			if (retained?.text === text && retained.baseRevision === revision) forgetUserNoteDraft(owner, subject, draftSurface);
			if (ticket !== noteLoad || !owner.isCurrent()) return;
			userNote = saved.text; noteRevision = saved.revision;
			userNoteStatus = 'Saved on this device.';
		} catch (error) {
			if (ticket === noteLoad) userNoteStatus = error instanceof Error ? error.message : 'Could not save. Your draft is retained in this session.';
		} finally { if (ticket === noteLoad) noteBusy = false; }
	}

	function clearUserNoteDraft() {
		userNoteDraft = ''; retainNoteDraft(); void saveUserNoteDraft();
	}
	function downloadNoteDraft() {
		const url = URL.createObjectURL(new Blob([userNoteDraft], { type: 'text/plain;charset=utf-8' }));
		const link = document.createElement('a'); link.href = url; link.download = 'personal-note-draft.txt'; link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	function warnUnsavedNote(event: BeforeUnloadEvent) {
		if (noteReady && userNoteDraft !== userNote) { event.preventDefault(); event.returnValue = ''; }
	}
	function reloadSavedNote() {
		if (!noteOwner || !noteSubject || noteBusy) return;
		if (userNoteDraft !== userNote) downloadNoteDraft();
		forgetUserNoteDraft(noteOwner, noteSubject, noteDraftSurface);
		void loadUserNote(noteOwner, noteSubject);
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
		const popoutWidth = popoutElement?.offsetWidth || Math.min(380, window.innerWidth - 16);
		// Measure the real node after it renders — the fixed 400px guess let
		// tall popouts run past the viewport bottom with no way to scroll.
		const popoutHeight = popoutElement?.offsetHeight || 400;
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
			top = Math.max(padding, window.innerHeight - popoutHeight - padding);
		}
		if (top < padding) {
			top = padding;
		}

		position = { top, left };
	}

	function closePopout() {
		if (surface === 'panel' && profileExpanded) {
			profileExpanded = false;
			void tick().then(() => popoutElement?.querySelector<HTMLElement>('[data-profile-expand]')?.focus());
			return;
		}
		isOpen = false;
		dispatch('close');
		anchorElement?.focus();
	}

	function handleProfileKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') { event.preventDefault(); closePopout(); return; }
		if (!profileExpanded || event.key !== 'Tab') return;
		const focusable = [...popoutElement.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((node) => node.offsetParent !== null);
		const first = focusable[0], last = focusable[focusable.length - 1];
		if (!first) { event.preventDefault(); return; }
		if (event.shiftKey && (document.activeElement === first || document.activeElement === popoutElement)) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && (document.activeElement === last || document.activeElement === popoutElement)) { event.preventDefault(); first.focus(); }
	}

	function handleClickOutside(event: MouseEvent) {
		if (surface === 'panel' || !isOpen || profileExpanded) return;
		// The username that opened the popout lives outside the popout node, so
		// the reopen click bubbles to document and would instantly close it on
		// every open after the first. Ignore clicks on the anchor (and anything
		// inside it) — the popout's own toggle manages those.
		if (anchorElement && anchorElement.contains(event.target as Node)) return;
		if (popoutElement && !popoutElement.contains(event.target as Node)) {
			closePopout();
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (surface === 'popout' && isOpen && !event.defaultPrevented && event.key === 'Escape') {
			closePopout();
		}
	}

	async function openDM() {
		if (!liveUser) return;
		const target = liveUser;
		const self = get(currentUser);
		if (!self || sameProfileIdentity(target, self)) return;
		const account = profileIdentity(self), server = get(activeServerUrl), identity = profileIdentity(target);

		const result = await resolveDmEntry({
			channels: get(channels),
			target,
			createDm: createDM
		});
		if (retired || !isOpen || account !== profileIdentity(get(currentUser)) || server !== get(activeServerUrl) || identity !== profileIdentity(user)) return;
		if (result.ok === false) {
			console.warn('[DM] Could not open conversation:', result.error);
			closePopout();
			return;
		}

		// +page owns the signal and always joins the socket room before showing
		// the DM, keeping profile-popout behavior identical to the other entry paths.
		dmPanelSignal.set({ channelId: result.channelId, otherUser: target });
		closePopout();
	}

	function openFullProfile() {
		profileExpanded = !profileExpanded;
		if (profileExpanded) void tick().then(() => {
			popoutElement?.focus({ preventScroll: true });
			const body = popoutElement?.querySelector('.popout-body');
			if (body) body.scrollTop = 0;
		});
	}

	function keepInProfilePanel() {
		if (!liveUser) return;
		if (noteOwner && noteSubject && noteReady && userNoteDraft !== userNote && !getUserNoteDraft(noteOwner, noteSubject, 'panel')) {
			retainUserNoteDraft(noteOwner, noteSubject, { text: userNoteDraft, baseRevision: noteRevision }, 'panel');
		}
		if (openProfilePanel(liveUser)) closePopout();
	}

	/** Keep one body/actions implementation in both the dock and modal. */
	function placeProfile(node: HTMLElement, detached: boolean) {
		const marker = document.createComment('profile surface');
		node.parentNode?.insertBefore(marker, node);
		function update(nextDetached: boolean) {
			if (nextDetached) document.body.appendChild(node);
			else marker.parentNode?.insertBefore(node, marker.nextSibling);
		}
		update(detached);
		return { update, destroy() { node.remove(); marker.remove(); } };
	}

	function openProfileSettings() {
		// Opening Settings owns the next focus. A dock-to-dialog return must not
		// schedule focus behind that modal after its focus action has mounted.
		if (surface === 'panel') profileExpanded = false;
		else closePopout();
		window.dispatchEvent(new CustomEvent('wabi:open-settings', { detail: { tab: 'profile' } }));
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

	// --- Moderation (role management) for owner/admin on other registered users ---
	$: canManageRoles = (() => {
		const self = $currentUser;
		if (!self || !user) return false;
		if (user.dbUserId == null) return false;
		if (isOwnProfile) return false;
		if ((self.highestRole !== 'owner' && self.highestRole !== 'admin')) return false;
		if (user.highestRole === 'owner') return false;
		return true;
	})();

	// Live role list for the moderation buttons: lore roles from the catalog
	// plus mod. Kept compact — the member list shows the full set.
	$: popoutAssignableRoles = canManageRoles ? selectAssignableRoles($roleDefinitions) : [];
	$: popoutRoles = popoutAssignableRoles.slice(0, 6);
	$: hiddenRoleCount = Math.max(0, popoutAssignableRoles.length - popoutRoles.length);

	let roleActionStatus = '';
	let banActionStatus = '';
	$: isTargetBanned = user?.dbUserId != null ? $bannedUserIds.has(user.dbUserId) : false;
	// Keep the client-side ban mirror fed by `user-banned`/`user-unbanned`
	// broadcasts while this popout is alive (idempotent per socket).
	$: if ($socket && browser) {
		try { attachUserBanListeners($socket); } catch { /* best-effort */ }
	}
	async function setUserRole(role: string) {
		if (!user?.dbUserId || !canManageRoles) return;
		roleActionStatus = 'Saving…';
		try {
			await requestLiveRoleChange($socket, user.dbUserId, role);
			roleActionStatus = 'Saved.';
			setTimeout(() => (roleActionStatus = ''), 2200);
		} catch (error) {
			roleActionStatus = error instanceof Error ? error.message : 'Could not change role.';
		}
	}

	async function handleBanUser() {
		if (!user?.dbUserId || !canManageRoles || !browser) return;
		if (!window.confirm(`Ban @${user.username} from this server? They will be logged out and blocked from signing in.`)) return;
		banActionStatus = 'Banning…';
		try {
			const { banUser } = await import('$lib/presenceStore');
			await banUser(user.dbUserId);
			banActionStatus = 'Banned.';
			setTimeout(() => (banActionStatus = ''), 2200);
		} catch (error) {
			banActionStatus = error instanceof Error ? error.message : 'Could not ban this member.';
		}
	}

	async function handleUnbanUser() {
		if (!user?.dbUserId || !canManageRoles) return;
		banActionStatus = 'Unbanning…';
		try {
			const { unbanUser } = await import('$lib/presenceStore');
			await unbanUser(user.dbUserId);
			banActionStatus = 'Unbanned.';
			setTimeout(() => (banActionStatus = ''), 2200);
		} catch (error) {
			banActionStatus = error instanceof Error ? error.message : 'Could not unban this member.';
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
		retired = true;
		noteLoad++;
		if (browser) {
			document.removeEventListener('click', handleClickOutside);
			document.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('resize', handleViewportChange);
			window.removeEventListener('scroll', handleViewportChange, true);
		}
	});
</script>

<svelte:window on:beforeunload={warnUnsavedNote} />

{#if isOpen && user}
	{#if profileExpanded}
		<button type="button" class="profile-full-backdrop" use:portal tabindex="-1" aria-label="Close full profile" on:click={closePopout}></button>
	{/if}
	<div
		class="popout-container"
		class:profile-expanded={profileExpanded}
		class:profile-docked={surface === 'panel' && !profileExpanded}
		bind:this={popoutElement}
		use:placeProfile={surface === 'popout' || profileExpanded}
		style={surface === 'popout' ? `top: ${position.top}px; left: ${position.left}px;` : undefined}
		role={surface === 'panel' && !profileExpanded ? 'region' : 'dialog'}
		aria-label={surface === 'panel' && !profileExpanded ? 'Complete profile' : 'User profile'}
		aria-modal={profileExpanded ? 'true' : undefined}
		tabindex="-1"
		on:click|stopPropagation
		on:keydown|stopPropagation={handleProfileKeydown}
	>
		<button type="button" class="profile-close" aria-label="Close profile" on:click={closePopout}>×</button>
		<div class="profile-tools">
			{#if isOwnProfile}<button type="button" aria-label="Edit profile" title="Edit profile" on:click={openProfileSettings}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m14 5 5 5"/></svg></button>{/if}
			{#if surface !== 'panel'}<button type="button" aria-label="Keep in side panel" title="Keep in side panel" on:click={keepInProfilePanel}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></button>{/if}
		</div>
		<!-- Banner/Header Area -->
		<div class="popout-banner" style="--banner-color: {liveUser?.color || 'var(--pfp-banner)'}">
			<div class="banner-gradient"></div>
			{#if liveUser?.bannerUrl && $profileDecorationsVisible}
				<ProfileMedia src={mediaUrl(liveUser?.bannerUrl)} alt="Profile banner" class="popout-banner-img" />
			{/if}
		</div>

		<!-- Avatar overlapping banner -->
		<div class="avatar-section">
			<div class="avatar-ring">
				{#if liveUser?.profilePicture}
					<ProfileMedia src={mediaUrl(liveUser?.profilePicture)} alt={popoutDisplayName} class="popout-avatar" />
				{:else}
					<div class="popout-avatar-placeholder" style="--avatar-color: {liveUser?.color}">
						{popoutDisplayName.charAt(0).toUpperCase()}
					</div>
				{/if}
				{#if liveUser?.overlayUrl && $profileDecorationsVisible}
					<ProfileDecoration user={liveUser!} class="popout-avatar-overlay" />
				{/if}
				<!-- Presence dot: bottom-right of the avatar, tracks live status -->
				<span
					class="popout-presence-dot"
					style="--status-color: {getStatusColor(popoutStatus)}"
					title={getStatusLabel(popoutStatus)}
					aria-label={getStatusLabel(popoutStatus)}
				></span>
			</div>
		</div>

		<!-- User Info Card -->
		<div class="popout-body">
			<div class="username-section">
				<h3 class="display-name"><ProfileName username={popoutDisplayName} font={liveUser?.usernameFont} color={liveUser?.color} /></h3>
				<button type="button" class="username-handle handle-copy" title="Copy handle" on:click={copyHandle}>@{liveUser?.handle || liveUser?.username}</button>
			</div>
			{#if ($displayEnhancementSettingsStore.topRoleEverywhereEnabled && roleToneClass(popoutTopRoleName) === 'owner') || ($displayEnhancementSettingsStore.staffTagEnabled && isStaffRole(popoutTopRoleName)) || (user.badges?.length ?? 0) > 0}
				<div class="popout-role-tags">
					{#if $displayEnhancementSettingsStore.topRoleEverywhereEnabled && roleToneClass(popoutTopRoleName) === 'owner'}
						<span class="popout-role-badge tone-owner role-mark" title="Owner" aria-label="Owner">
							<BadgeMark kind="owner" mark={ownerMark} />
						</span>
					{/if}
					{#if $displayEnhancementSettingsStore.staffTagEnabled && isStaffRole(popoutTopRoleName)}
						<span class="popout-staff-tag role-mark" title="Staff" aria-label="Staff"><BadgeMark kind="staff" mark={staffMark} /></span>
					{/if}
					<RoleBadge user={liveUser!} size="md" mode="custom" />
				</div>
			{/if}

			{#if completeProfile}
				<div class="profile-detail-grid">
					<div>
						<span>Role</span>
						<strong>{getUserTopRoleLabel(liveUser!)}</strong>
					</div>
					{#if liveUser?.joinedAt}
						<div>
							<span>Member since</span>
							<strong>{new Date(liveUser.joinedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</strong>
						</div>
					{/if}
				</div>
			{/if}

			<div class="status-section">
				<span class="status-indicator" style="--status-color: {getStatusColor(popoutStatus)}"></span>
				<span class="status-label" title={getStatusLabel(popoutStatus)} aria-label={getStatusLabel(popoutStatus)}>{getStatusLabel(popoutStatus)}{#if liveUser?.statusMessage} · {liveUser.statusMessage}{/if}</span>
			</div>

			<div class="divider"></div>

			<!-- About Me / Bio section -->
			{#if liveUser?.bio}
				<div class="section">
					<h4 class="section-title">{$_('user.popout.about_me')}</h4>
					<p class="section-content">{liveUser?.bio}</p>
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
						on:input={() => queueMicrotask(retainNoteDraft)}
						disabled={!noteReady || noteBusy}
						aria-label="Personal note"
						placeholder="Add a private note about this user (local only)."
					></textarea>
					<div class="note-actions">
						<button
							class="note-btn primary"
							on:click={saveUserNoteDraft}
							disabled={!noteReady || noteBusy || userNoteDraft === userNote}
						>
							Save
						</button>
						<button
							class="note-btn"
							on:click={clearUserNoteDraft}
							disabled={!noteReady || noteBusy || (!userNote && !userNoteDraft)}
						>
							Clear
						</button>
						<button class="note-btn" on:click={downloadNoteDraft} disabled={!userNoteDraft}>Download draft</button>
						<button class="note-btn" on:click={reloadSavedNote} disabled={!noteOwner || !noteSubject || noteBusy}>{userNoteDraft !== userNote ? 'Download draft & load saved' : 'Reload saved note'}</button>
						<span class="note-count">{userNoteDraft.length}/{MAX_USER_NOTE_LENGTH}</span>
					</div>
					{#if legacyNotesFound}<p class="note-status">Older personal notes are preserved on this device. Their owner and profile identities need explicit mapping before recovery; they have not been assigned to this account.</p>{/if}
					{#if userNoteStatus}
						<p class="note-status" role="status">{userNoteStatus}</p>
					{:else if userNote}
						<p class="section-content note-content">{userNote}</p>
					{/if}
				</div>
			{/if}

			{#if !completeProfile && liveUser?.joinedAt}
				<span class="member-since-ghost">Member since {new Date(liveUser.joinedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
			{/if}


			{#if $displayEnhancementSettingsStore.showConnectionsEnabled && connectionRows.length > 0}
				<div class="section">
					<h4 class="section-title">Links</h4>
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
				onClose={closePopout}
				{isOwnProfile}
				{profileExpanded}
				inSidePanel={surface === 'panel'}
				user={liveUser}
				{localNickname}
				localNicknamesEnabled={$displayEnhancementSettingsStore.localNicknamesEnabled}
				canManageRoles={canManageRoles}
				targetRole={user?.highestRole || 'member'}
				roles={popoutRoles}
				hiddenRoleCount={hiddenRoleCount}
				roleActionStatus={roleActionStatus}
				onSetRole={setUserRole}
				isBanned={isTargetBanned}
				banActionStatus={banActionStatus}
				onBanUser={handleBanUser}
				onUnbanUser={handleUnbanUser}
				onOpenDM={openDM}
				onOpenFullProfile={openFullProfile}
				onVoiceCall={handleVoiceCall}
				onVideoCall={handleVideoCall}
				onScreenShare={handleScreenShare}
				onSetLocalNickname={promptSetLocalNickname}
				onClearLocalNickname={clearLocalNickname}
			/>
		</div>
	</div>
{/if}

<style>
	.profile-tools {position:absolute;top:10px;right:48px;z-index:3;display:flex;gap:6px;}
	.profile-tools button {display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:50%;background:var(--w-raise);color:var(--w-text);cursor:pointer;}
	.handle-copy {border:0;background:none;padding:0;cursor:pointer;}
	.handle-copy:hover {text-decoration:underline;}
	.popout-container .note-actions { flex-wrap: wrap; gap: 0.5rem; }
	.popout-container .note-actions .note-btn { min-height: 36px; padding: 0.375rem 0.625rem; font-size: 0.8125rem; border-radius: calc(10px * var(--w-rs, 1)); }
	.popout-container .note-count { flex-basis: 100%; margin-left: 0; }
	@media (pointer: coarse) { .popout-container .note-actions .note-btn { min-height: 44px; } }
</style>
