<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { currentUser, updateProfile, roleDefinitions } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, toggleMute, toggleDeafen } from '$lib/calling';
	import { clearActiveCustomStatusPreset, customStatusPresetsStore, getActiveCustomStatusPreset } from '$lib/customStatusPresets';
	import { brandName } from '$lib/branding';
import { resolveServerUrl } from '$lib/serverUrl';
	import { FALLBACK_ROLE_LABELS } from './channelSidebarHelpers';

	export let sidebarWidth: number;

	const dispatch = createEventDispatcher();

	let showStatusPopup = false;
	let disableAllBanners = false;
	let shareCopied = false;

	const BANNER_VISIBILITY_KEY = 'wabi:profile:visibility';

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

	// PR4: richer status/activity line — status label + active custom status preset.
	$: activityLabel = (() => {
		const status = $currentUser?.status;
		if (status === 'away') return 'Away';
		if (status === 'busy') return 'Busy';
		if (status === 'offline') return 'Offline';
		return 'Active';
	})();
	$: activeCustomStatus = getActiveCustomStatusPreset($customStatusPresetsStore);
	$: cardBannerUrl =
		$currentUser?.bannerUrl && $currentUser.showBanner !== false && !disableAllBanners
			? $currentUser.bannerUrl
			: '';

	function openProfilePopout(event: Event): void {
		dispatch('openProfilePopout', event);
	}

	function toggleStatus() {
		showStatusPopup = !showStatusPopup;
	}

	function changeStatus(newStatus: 'active' | 'away' | 'busy') {
		clearActiveCustomStatusPreset();
		updateProfile({ status: newStatus });
		showStatusPopup = false;
	}

	function copyUserId(): void {
		const id = $currentUser?.id;
		if (!id || !navigator.clipboard) return;
		navigator.clipboard.writeText(id).catch(() => {});
	}

	function copyMention(): void {
		const handle = ($currentUser?.handle || '').trim();
		const mention = handle && handle.toLowerCase() !== 'unknown' ? `@${handle}` : displayUsername;
		if (!mention || !navigator.clipboard) return;
		navigator.clipboard.writeText(mention).catch(() => {});
	}

	function shareProfile(): void {
		const handle = ($currentUser?.handle || '').trim();
		const identity = handle && handle.toLowerCase() !== 'unknown' ? `@${handle}` : displayUsername;
		const text = `${identity} on ${brandName}`;
		const url = `${resolveServerUrl().url}/@${handle || displayUsername}`;
		if (navigator.share) {
			navigator.share({ title: identity, text, url }).catch(() => {
				navigator.clipboard.writeText(url).catch(() => {});
			});
		} else if (navigator.clipboard) {
			navigator.clipboard.writeText(url).then(() => {
				// Brief visual feedback
				shareCopied = true;
				setTimeout(() => shareCopied = false, 2000);
			}).catch(() => {});
		}
	}
</script>

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
				<div class="status-indicator" class:online={$currentUser.status === 'active'} class:away={$currentUser.status === 'away'} class:busy={$currentUser.status === 'busy'}></div>
			</button>
			<div class="user-details">
				<div
					class="username"
					role="button"
					tabindex="0"
					on:click={toggleStatus}
					on:keydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							toggleStatus();
						}
					}}
				>
					<span class="username-text">{displayUsername}</span>
					<span class="self-role-badge">{currentUserRoleLabel}</span>
				</div>
				<div class="user-tag">@{displayHandle}</div>
				<div class="activity-line">
					<span class="activity-dot" class:away={$currentUser.status === 'away'} class:busy={$currentUser.status === 'busy'} class:offline={$currentUser.status === 'offline'}></span>
					<span class="activity-label">{activityLabel}</span>
					{#if activeCustomStatus?.label}
						<span class="activity-status">{activeCustomStatus.label}</span>
					{/if}
				</div>
			</div>
		</div>

		{#if showStatusPopup}
			<div class="status-popup">
				<button class="status-option active" on:click={() => changeStatus('active')}>
					<span class="status-dot" style="background-color: var(--status-online)"></span>
					Active
				</button>
				<button class="status-option away" on:click={() => changeStatus('away')}>
					<span class="status-dot" style="background-color: var(--status-away)"></span>
					Away
				</button>
				<button class="status-option busy" on:click={() => changeStatus('busy')}>
					<span class="status-dot" style="background-color: var(--status-busy)"></span>
					Busy
				</button>
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
					on:click={copyMention}
					title="Copy mention"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg>
				</button>
				<button
					class="control-btn"
					on:click={copyUserId}
					title="Copy user ID"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>
				</button>
				<button
						class="control-btn"
						class:share-copied={shareCopied}
						on:click={shareProfile}
						title="Share profile"
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
						{#if shareCopied}
							<span class="share-copied-badge">Copied!</span>
						{/if}
					</button>
				<button
					class="control-btn"
					on:click={() => dispatch('openSettings')}
					title="User Settings"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v4m0 16v4M4.93 4.93l2.83 2.83M18.36 18.36l2.83-2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83M18.36 5.64l2.83 2.83"></path></svg>
				</button>
			{/if}
		</div>
	</div>
{/if}
