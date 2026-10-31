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
	import UserPopoutActions from './UserPopoutActions.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { confirmAction } from '$lib/confirm';
	import { inkFor } from '$lib/theme/identity';
	import { roleBadgeLabel } from '$lib/badges';
	import { resolveUserDisplayColor } from '$lib/accessibility';
	import { memberSince, noteProblemCopy, presenceLabelKey, presenceOf, stampInitial, type NoteProblemKind } from './userPopoutModel';
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
	/** What the quiet line under the note says; '' says nothing. */
	let userNoteStatus = '';
	/** A save or load that failed ('' when none); the notice's words depend on whether a draft exists. */
	let noteProblem: NoteProblemKind | '' = '';
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
	// Live-sync status/avatar: the `user` prop is captured at click time and
	// goes stale when presence changes. Resolve the freshest roster entry by
	// id so the dot and label track the real status.
	$: liveUser =
		(user && sameProfileIdentity($currentUser, user) ? $currentUser : null) ||
		(user && $users.find((candidate) => sameProfileIdentity(candidate, user))) ||
		(user && $serverMembers.find((candidate) => sameProfileIdentity(candidate, user))) || user || null;
	$: popoutStatus = liveUser?.status || user?.status || 'offline';
	$: presence = presenceOf(popoutStatus);
	$: presenceWord = $_(presenceLabelKey(presence));
	/** Identity ink for the stamp and the name (§5.5); a CSS-variable color inherits the text color. */
	$: identityColor = (() => {
		const color = resolveUserDisplayColor(liveUser?.roleColor, liveUser?.color);
		return color && !color.startsWith('var(') ? color : '';
	})();
	$: inkStyle = $inkFor(identityColor);
	$: roleWord = liveUser?.isBot ? 'Bot' : roleBadgeLabel(liveUser);
	$: joinedLine = memberSince(liveUser?.joinedAt);
	const titleId = `profile-${Math.random().toString(36).slice(2, 8)}-name`;

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

	/** Under 641px the popout spans the viewport with 8px margins (user-popout.css), so no inline left. */
	let narrowViewport = false;
	function handleViewportChange(): void {
		narrowViewport = browser && window.innerWidth <= 640;
		if (surface === 'popout' && isOpen) calculatePosition();
	}

	async function loadUserNote(owner: NotebookOwner | null, subject: string | null) {
		const ticket = ++noteLoad;
		noteOwner = owner; noteSubject = subject || ''; noteReady = false;
		userNote = ''; userNoteDraft = ''; noteRevision = 0; noteBusy = false; noteProblem = '';
		legacyNotesFound = hasLegacyUserNotes();
		if (!owner || !subject) {
			userNoteStatus = !subject ? '' : $notebookOwner.error ? "Your notebook isn't available right now." : 'Opening your notebook…';
			return;
		}
		const retained = getUserNoteDraft(owner, subject, noteDraftSurface);
		if (retained) {
			userNoteDraft = retained.text;
			noteRevision = retained.baseRevision;
			noteReady = true;
		}
		userNoteStatus = '';
		try {
			const saved = await getUserNote(owner, subject);
			if (ticket !== noteLoad || !owner.isCurrent()) return;
			const draft = getUserNoteDraft(owner, subject, noteDraftSurface);
			userNote = saved.text;
			userNoteDraft = draft?.text ?? saved.text;
			noteRevision = draft?.baseRevision ?? saved.revision;
			noteReady = true;
			userNoteStatus = draft && draft.text !== saved.text ? 'Unsaved draft restored' : '';
		} catch (error) {
			if (ticket !== noteLoad) return;
			console.warn('[profile] personal note load failed', error);
			noteProblem = 'load';
		}
	}

	function retainNoteDraft() {
		if (!noteOwner || !noteSubject || !noteReady) return;
		retainUserNoteDraft(noteOwner, noteSubject, { text: userNoteDraft, baseRevision: noteRevision }, noteDraftSurface);
		userNoteStatus = userNoteDraft === userNote ? '' : 'Not saved yet';
	}

	async function saveUserNoteDraft() {
		if (!noteOwner || !noteSubject || !noteReady || noteBusy || userNoteDraft === userNote) return;
		const owner = noteOwner, subject = noteSubject, ticket = noteLoad, text = userNoteDraft, revision = noteRevision, draftSurface = noteDraftSurface;
		retainNoteDraft(); noteBusy = true; noteProblem = ''; userNoteStatus = 'Saving…';
		try {
			const saved = await setUserNote(owner, subject, text, revision);
			const retained = getUserNoteDraft(owner, subject, draftSurface);
			if (retained?.text === text && retained.baseRevision === revision) forgetUserNoteDraft(owner, subject, draftSurface);
			if (ticket !== noteLoad || !owner.isCurrent()) return;
			userNote = saved.text; noteRevision = saved.revision;
			userNoteStatus = saved.text ? 'Saved on this device' : 'Note cleared';
		} catch (error) {
			if (ticket !== noteLoad) return;
			console.warn('[profile] personal note save failed', error);
			userNoteStatus = '';
			noteProblem = 'save';
		} finally { if (ticket === noteLoad) noteBusy = false; }
	}

	// A load that failed with a draft kept here (noteReady) can still offer it; one with nothing kept cannot.
	$: noteProblemText = noteProblem ? noteProblemCopy(noteProblem, (noteProblem === 'save' || noteReady) && userNoteDraft !== '') : null;

	/** Enter saves (Shift Enter is a new line); Esc puts the saved text back. */
	function handleNoteKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void saveUserNoteDraft();
		} else if (event.key === 'Escape' && userNoteDraft !== userNote) {
			event.preventDefault();
			event.stopPropagation();
			userNoteDraft = userNote;
			if (noteOwner && noteSubject) forgetUserNoteDraft(noteOwner, noteSubject, noteDraftSurface);
			userNoteStatus = '';
		}
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

	// ---- nickname on this device: an inline field instead of window.prompt ----
	let nicknameEditing = false;
	let nicknameDraft = '';
	let nicknameInput: HTMLInputElement | null = null;

	function promptSetLocalNickname(): void {
		if (!browser || !user || !$displayEnhancementSettingsStore.localNicknamesEnabled) return;
		nicknameDraft = getLocalNicknameForUser(user) || user.username;
		nicknameEditing = true;
		void tick().then(() => {
			nicknameInput?.focus();
			nicknameInput?.select();
		});
	}

	function saveLocalNickname(): void {
		if (!user) return;
		setLocalNicknameForUser(user, nicknameDraft);
		nicknameEditing = false;
	}

	function handleNicknameKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			saveLocalNickname();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			nicknameEditing = false;
		}
	}

	function clearLocalNickname(): void {
		if (!browser || !user) return;
		clearLocalNicknameForUser(user);
		nicknameEditing = false;
	}

	function calculatePosition() {
		if (!anchorElement) return;

		const rect = anchorElement.getBoundingClientRect();
		const popoutWidth = popoutElement?.offsetWidth || Math.min(360, window.innerWidth - 16);
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
		// The ⋯ menu, its phone sheet and the ban/remove confirms are portaled to <body>: a click
		// inside them belongs to the popout.
		if (event.target instanceof Element && event.target.closest('[role="menu"], .w-sheet, .w-scrim, .w-dialog')) return;
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
			console.warn('[Call] Screen share failed to start:', error);
			showToast("Couldn't start screen sharing. Check that this browser may share your screen.", 'error', 5000);
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
			roleActionStatus = 'Role saved';
			setTimeout(() => (roleActionStatus = ''), 2200);
		} catch (error) {
			console.warn('[profile] role change failed', error);
			roleActionStatus = "Couldn't change the role. Nothing changed.";
		}
	}

	async function handleBanUser() {
		if (!user?.dbUserId || !canManageRoles || !browser) return;
		const handle = user.handle || user.username;
		const confirmed = await confirmAction({
			title: `Ban @${handle} from this server?`,
			body: 'They are signed out and cannot sign in again until someone unbans them.',
			confirm: 'Ban from server',
			danger: true
		});
		if (!confirmed || !user?.dbUserId) return;
		banActionStatus = 'Banning…';
		try {
			const { banUser } = await import('$lib/presenceStore');
			await banUser(user.dbUserId);
			banActionStatus = 'Banned';
			setTimeout(() => (banActionStatus = ''), 2200);
		} catch (error) {
			console.warn('[profile] ban failed', error);
			banActionStatus = "Couldn't ban this member. Nothing changed.";
		}
	}

	async function handleUnbanUser() {
		if (!user?.dbUserId || !canManageRoles) return;
		banActionStatus = 'Unbanning…';
		try {
			const { unbanUser } = await import('$lib/presenceStore');
			await unbanUser(user.dbUserId);
			banActionStatus = 'Unbanned';
			setTimeout(() => (banActionStatus = ''), 2200);
		} catch (error) {
			console.warn('[profile] unban failed', error);
			banActionStatus = "Couldn't unban this member. Nothing changed.";
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

	onMount(() => {
		narrowViewport = window.innerWidth <= 640;
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
		style="{surface === 'popout' && !profileExpanded ? `top: ${position.top}px;${narrowViewport ? '' : ` left: ${position.left}px;`}` : ''}{inkStyle}"
		role={surface === 'panel' && !profileExpanded ? 'region' : 'dialog'}
		aria-labelledby={titleId}
		aria-modal={profileExpanded ? 'true' : undefined}
		tabindex="-1"
		on:click|stopPropagation
		on:keydown|stopPropagation={handleProfileKeydown}
	>
		<div class="pop-tools">
			{#if surface !== 'panel'}
				<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Keep in side panel" title="Keep in side panel" on:click={keepInProfilePanel}>
					<Icon name="sidebarRight" size={16} />
				</button>
			{/if}
			<button type="button" class="w-ibtn w-ibtn--sm" aria-label={profileExpanded ? 'Close full profile' : 'Close profile'} on:click={closePopout}>
				<Icon name="x" size={16} />
			</button>
		</div>

		{#if liveUser?.bannerUrl && $profileDecorationsVisible}
			<div class="pop-banner">
				<ProfileMedia src={mediaUrl(liveUser?.bannerUrl)} alt="" decorative class="popout-banner-img" />
			</div>
		{/if}

		<div class="popout-body">
			<!-- Identity first (§8.9): stamp, name in ink, role word, presence. -->
			<header class="pop-id">
				<span class="pop-av" data-presence={presence}>
					{#if liveUser?.profilePicture}
						<ProfileMedia src={mediaUrl(liveUser?.profilePicture)} alt="" decorative class="pop-av__pic" />
					{:else}
						<span class="pop-av__stamp" aria-hidden="true">{stampInitial(popoutDisplayName)}</span>
					{/if}
					{#if liveUser?.overlayUrl && $profileDecorationsVisible}
						<ProfileDecoration user={liveUser} class="popout-avatar-overlay" />
					{/if}
					<span class="pop-av__presence" aria-hidden="true"></span>
				</span>
				<div class="pop-who">
					<h3 class="pop-name" id={titleId}>
						<ProfileName username={popoutDisplayName} font={liveUser?.usernameFont} color={identityColor} />
					</h3>
					<p class="pop-meta">
						<button type="button" class="pop-handle" title="Copy handle" on:click={copyHandle}>@{liveUser?.handle || liveUser?.username}</button>
						{#if roleWord}<span class="w-role" title={getUserTopRoleLabel(liveUser ?? user)}>{roleWord}</span>{/if}
					</p>
					<p class="pop-presence">
						<span class="pop-presence__dot" data-presence={presence} aria-hidden="true"></span>
						<span class="pop-presence__text">{presenceWord}{#if liveUser?.statusMessage} · {liveUser.statusMessage}{/if}</span>
					</p>
				</div>
			</header>

			{#if localNickname}
				<p class="pop-aside">Nickname on this device · {liveUser?.username || user.username}</p>
			{/if}

			{#if liveUser?.bio}
				<p class="pop-bio">{liveUser.bio}</p>
			{/if}

			{#if (user.badges?.length ?? 0) > 0}
				<div class="pop-badges">
					<RoleBadge user={liveUser ?? user} size="md" mode="custom" />
				</div>
			{/if}

			{#if completeProfile}
				<dl class="w-pop__facts pop-facts">
					<dt>Role</dt>
					<dd>{getUserTopRoleLabel(liveUser ?? user)}</dd>
					{#if joinedLine}
						<dt>{$_('user.popout.member_since')}</dt>
						<dd>{joinedLine}</dd>
					{/if}
				</dl>
			{/if}

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
				onEditProfile={openProfileSettings}
				onVoiceCall={handleVoiceCall}
				onVideoCall={handleVideoCall}
				onScreenShare={handleScreenShare}
				onSetLocalNickname={promptSetLocalNickname}
				onClearLocalNickname={clearLocalNickname}
			/>

			{#if nicknameEditing}
				<div class="pop-line">
					<label class="pop-line__label" for="{titleId}-nickname">Nickname on this device</label>
					<input
						id="{titleId}-nickname"
						class="w-field pop-line__field"
						type="text"
						maxlength={MAX_LOCAL_NICKNAME_LENGTH}
						autocomplete="off"
						bind:this={nicknameInput}
						bind:value={nicknameDraft}
						on:keydown={handleNicknameKeydown}
					/>
					<div class="pop-line__actions">
						<button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={() => (nicknameEditing = false)}>Cancel</button>
						<button type="button" class="w-btn w-btn--sm" on:click={saveLocalNickname}>Save nickname</button>
					</div>
				</div>
			{/if}

			<!-- The private note: a quiet one-line field that only you see. -->
			{#if !isOwnProfile && $displayEnhancementSettingsStore.userNotesEnabled && noteSubject}
				<div class="pop-note">
					<textarea
						class="w-field pop-note__field"
						rows="1"
						maxlength={MAX_USER_NOTE_LENGTH}
						bind:value={userNoteDraft}
						on:input={() => queueMicrotask(retainNoteDraft)}
						on:keydown={handleNoteKeydown}
						on:blur={() => void saveUserNoteDraft()}
						disabled={!noteReady}
						readonly={noteBusy}
						aria-busy={noteBusy}
						aria-label="Private note about {popoutDisplayName}"
						aria-describedby="{titleId}-note-status"
						placeholder={$_('user.popout.note_placeholder')}
					></textarea>
					<p class="pop-note__status" id="{titleId}-note-status" role="status">
						{userNoteStatus}{#if userNoteDraft.length > MAX_USER_NOTE_LENGTH - 80}<span class="pop-note__count">{userNoteDraft.length} / {MAX_USER_NOTE_LENGTH}</span>{/if}
					</p>
					{#if noteProblemText}
						<div class="w-notice pop-note__problem" role="alert">
							<Icon name="alert" size={16} />
							<p class="w-notice__title">{noteProblemText.title}</p>
							<p class="w-notice__text">{noteProblemText.text}</p>
							<div class="w-notice__actions">
								{#if noteProblemText.canDownload}
									<button type="button" class="w-btn w-btn--sm" on:click={downloadNoteDraft}>Download draft</button>
								{/if}
								<button type="button" class="w-btn w-btn--sm" on:click={reloadSavedNote} disabled={noteBusy}>{noteProblemText.retryLabel}</button>
							</div>
						</div>
					{/if}
					{#if legacyNotesFound}
						<p class="pop-aside">Older notes on this device are kept apart and are not linked to this account.</p>
					{/if}
				</div>
			{/if}

			{#if !completeProfile && joinedLine}
				<p class="pop-since">{$_('user.popout.member_since')} {joinedLine}</p>
			{/if}

			{#if $displayEnhancementSettingsStore.showConnectionsEnabled && connectionRows.length > 0}
				<section class="pop-links" aria-label="Links">
					<h4 class="w-kicker">Links</h4>
					<ul>
						{#each connectionRows as row (row.label + row.value)}
							<li>
								{#if row.url}
									<a href={row.url} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} />{row.label}</a>
								{:else}
									<span>{row.value}</span>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>
	</div>
{/if}
