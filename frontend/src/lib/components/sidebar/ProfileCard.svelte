<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { currentUser, roleDefinitions, getSocket } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, toggleMute, toggleDeafen, isInCall, endCall } from '$lib/calling';
	import { clearActiveCustomStatusPreset, customStatusPresetsStore, getActiveCustomStatusPreset } from '$lib/customStatusPresets';
	import { selectPresence, getStoredPresence, maskedStatus, type PresenceState } from '$lib/presenceControl';
	import { FALLBACK_ROLE_LABELS } from './channelSidebarHelpers';

	export let sidebarWidth: number;

	const dispatch = createEventDispatcher();

	let showStatusPopup = false;
	let disableAllBanners = false;
	let shareCopied = false;

	const BANNER_VISIBILITY_KEY = 'wabi:profile:visibility';

	// Self-selected presence (not the broadcast status): invisible is kept
	// locally so the picker can re-highlight it even though everyone else
	// (including our own roster row) sees "offline".
	let selectedPresence: PresenceState = getStoredPresence();

	onMount(() => {
		try {
			const raw = localStorage.getItem(BANNER_VISIBILITY_KEY);
			if (!raw) return;
			const v = JSON.parse(raw);
			if (typeof v.disableAll === 'boolean') disableAllBanners = v.disableAll;
		} catch {
			// ignore malformed local state
		}
	});

	function onDocClick(event: MouseEvent): void {
		if (!showStatusPopup) return;
		const card = document.querySelector('.profile-card');
		if (card && !card.contains(event.target as Node)) showStatusPopup = false;
	}

	$: cardBannerUrl =
		$currentUser?.bannerUrl && !disableAllBanners
			? $currentUser.bannerUrl
			: '';

	$: currentUserRoleLabel = (() => {
		if (!$currentUser) return '';
		const roleName = $currentUser.highestRole || ($currentUser.dbUserId ? 'member' : 'guest');
		const roleDefinition = $roleDefinitions.find(role => role.roleName === roleName);
		return roleDefinition?.displayName || FALLBACK_ROLE_LABELS[roleName] || roleName;
	})();

	// R8: never render blank / literal "unknown" for self label in BL profile card.
	$: displayUsername = (() => {
		const raw = ($currentUser?.username || '').trim();
		if (!raw) return 'Guest';
		if (raw.toLowerCase() === 'unknown' || raw.toLowerCase() === 'unknown user') return 'Guest';
		return raw;
	})();
	$: displayHandle = (() => {
		const handle = ($currentUser?.handle || '').trim();
		if (handle && handle.toLowerCase() !== 'unknown') return handle;
		return displayUsername;
	})();
	$: avatarInitial = (displayUsername.charAt(0) || 'G').toUpperCase();

	// The dot mirrors the MASKED view (invisible → offline/grey), matching
	// what everyone else sees. The label line only carries the custom status.
	$: visibleStatus = selectedPresence === 'active' && !$currentUser?.status
		? 'active'
		: maskedStatus(selectedPresence);

	$: activeCustomStatus = getActiveCustomStatusPreset($customStatusPresetsStore);

	function openProfilePopout(event: Event): void {
		dispatch('openProfilePopout', event);
	}

	function toggleStatusPopup(): void {
		showStatusPopup = !showStatusPopup;
	}

	const PRESENCE_OPTIONS: Array<{ value: PresenceState; label: string; colorVar: string }> = [
		{ value: 'active', label: 'Online', colorVar: 'var(--status-online)' },
		{ value: 'away', label: 'Away', colorVar: 'var(--status-away)' },
		{ value: 'busy', label: 'Do Not Disturb', colorVar: 'var(--status-busy)' },
		{ value: 'invisible', label: 'Invisible', colorVar: 'var(--status-offline)' }
	];

	function changePresence(presence: PresenceState): void {
		selectedPresence = presence;
		clearActiveCustomStatusPreset();
		selectPresence(presence);
		showStatusPopup = false;
	}
</script>

<svelte:document on:click={onDocClick} />

{#if $currentUser}
	<div class="profile-card">
		{#if cardBannerUrl}
			<div class="profile-card-banner" style="background-image: url({cardBannerUrl});" aria-hidden="true"></div>
		{/if}
		<div class="profile-info">
			<button class="avatar-container" on:click={openProfilePopout}>
				{#if $currentUser.profilePicture}
					<img src={$currentUser.profilePicture} alt={displayUsername} class="avatar" />
				{:else}
					<div class="avatar-placeholder" style="--avatar-color: {$currentUser.color}">
						{avatarInitial}
					</div>
				{/if}
				<span
					class="status-indicator presence-toggle"
					class:online={visibleStatus === 'active'}
					class:away={visibleStatus === 'away'}
					class:busy={visibleStatus === 'busy'}
					class:offline={visibleStatus === 'offline'}
					role="button"
					tabindex="0"
					on:click|stopPropagation={toggleStatusPopup}
					on:keydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							event.stopPropagation();
							toggleStatusPopup();
						}
					}}
					title="Set presence"
					aria-label={`Presence: ${PRESENCE_OPTIONS.find((o) => o.value === selectedPresence)?.label ?? visibleStatus}. Change presence.`}
					aria-expanded={showStatusPopup}
					aria-haspopup="menu"
				></span>
			</button>
			<div class="user-details">
				<div class="username">
					<span class="username-text">{displayUsername}</span>
					<span class="self-role-badge">{currentUserRoleLabel}</span>
				</div>
				<div class="user-tag">@{displayHandle}</div>
				{#if activeCustomStatus?.label}
					<div class="activity-line">
						<span class="activity-status">{activeCustomStatus.label}</span>
					</div>
				{/if}
			</div>
		</div>

		{#if showStatusPopup}
			<div class="status-popup" role="menu" aria-label="Select presence">
				{#each PRESENCE_OPTIONS as option (option.value)}
					<button
						class="status-option"
						class:selected={selectedPresence === option.value}
						on:click={() => changePresence(option.value)}
						role="menuitem"
					>
						<span class="status-dot" style="background-color: {option.colorVar}"></span>
						{option.label}
						{#if selectedPresence === option.value}<span class="status-check">✓</span>{/if}
					</button>
				{/each}
			</div>
		{/if}
		<div class="profile-controls">
			<button
				class="control-btn"
				class:active={$callMuted}
				on:click={toggleMute}
				title={$callMuted ? 'Unmute' : 'Mute'}
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if $callMuted}
						<line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12m14 0a7 7 0 0 1-13.46 3.4"></path><path d="M12 19c3.314 0 6-2.686 6-6v-3m0-6h.01M6 9a6 6 0 0 0 11.13 3.13"></path>
					{:else}
						<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>
					{/if}
				</svg>
			</button>
			<button
				class="control-btn"
				class:active={$callDeafened}
				on:click={() => toggleDeafen()}
				title={$callDeafened ? 'Undeafen' : 'Deafen'}
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if $callDeafened}
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>
					{:else}
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
					{/if}
				</svg>
			</button>
			{#if sidebarWidth >= 170}
				<button
					class="control-btn"
					on:click={() => dispatch('openSettings')}
					title="User Settings"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path></svg>
				</button>
				{#if $isInCall}
					<button
						class="control-btn control-btn-danger"
						on:click={() => endCall(getSocket())}
						title="End call"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
					</button>
				{/if}
			{/if}
			</div>
			</div>
			{/if}
