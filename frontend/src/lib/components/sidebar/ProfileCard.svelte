<!--
	Sidebar foot (spec §8.1 item 8): the 80px band on the footer rule. Avatar 36 with its
	presence dot (the avatar opens the presence menu), name over handle (opens your profile),
	then Mute, Deafen and Settings as 32px icon buttons with aria-label and aria-pressed.
	In the 60px compact rail only the avatar shows.
-->
<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import ProfileMedia from '$lib/components/ProfileMedia.svelte';
	import ProfileDecoration from '$lib/components/ProfileDecoration.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import { profileDecorationsVisible } from '$lib/profileAppearance';
	import { currentUser, getSocket } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, toggleMute, toggleDeafen, isInCall, endCall } from '$lib/calling';
	import { clearActiveCustomStatusPreset, customStatusPresetsStore, getActiveCustomStatusPreset } from '$lib/customStatusPresets';
	import { selectPresence, getStoredPresence, maskedStatus, type PresenceState } from '$lib/presenceControl';
	import { mediaUrl } from '$lib/mediaUrl';
	import { inkFor } from '$lib/theme/identity';

	export let sidebarWidth: number;
	/** The 60px rail: the avatar alone (its menu still sets presence and opens your profile). */
	export let compact = false;

	const dispatch = createEventDispatcher();

	// Self-selected presence (not the broadcast status): invisible is kept
	// locally so the picker can re-highlight it even though everyone else
	// (including our own roster row) sees "offline".
	let selectedPresence: PresenceState = getStoredPresence();
	let presenceMenuOpen = false;
	let avatarWrap: HTMLElement | null = null;

	// R8: never render blank / literal "unknown" for self label in the sidebar foot.
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
	$: avatarInk = $inkFor($currentUser?.color);

	// The dot mirrors the MASKED view (invisible → offline), matching what everyone else sees.
	$: visibleStatus = selectedPresence === 'active' && !$currentUser?.status
		? 'active'
		: maskedStatus(selectedPresence);

	$: activeCustomStatus = getActiveCustomStatusPreset($customStatusPresetsStore);

	const PRESENCE_OPTIONS: Array<{ value: PresenceState; label: string }> = [
		{ value: 'active', label: 'Online' },
		{ value: 'away', label: 'Away' },
		{ value: 'busy', label: 'Do not disturb' },
		{ value: 'invisible', label: 'Invisible' }
	];
	$: presenceLabel = PRESENCE_OPTIONS.find((option) => option.value === selectedPresence)?.label ?? 'Online';

	function changePresence(presence: PresenceState): void {
		selectedPresence = presence;
		clearActiveCustomStatusPreset();
		selectPresence(presence);
	}

	/** Opens your profile popout anchored to the control that asked (the name block or the avatar). */
	function openProfilePopout(anchor: HTMLElement | null): void {
		dispatch('openProfilePopout', { anchor });
	}

	let presenceItems: MenuEntry[] = [];
	$: presenceItems = [
		{ id: 'presence-kicker', type: 'kicker', label: 'Presence' },
		...PRESENCE_OPTIONS.map(
			(option): MenuEntry => ({
				id: `presence-${option.value}`,
				label: option.label,
				role: 'menuitemradio',
				checked: selectedPresence === option.value,
				onSelect: () => changePresence(option.value)
			})
		),
		{ id: 'presence-divider', type: 'separator' },
		{
			id: 'view-profile',
			label: 'View profile',
			icon: 'user',
			onSelect: () => openProfilePopout(avatarWrap)
		},
		{ id: 'open-settings', label: 'Settings', icon: 'gear', onSelect: () => { dispatch('openSettings'); } }
	] as MenuEntry[];

	// Very narrow (but not compact) columns drop the name block before the controls.
	$: showDetails = !compact && sidebarWidth >= 200;
</script>

{#if $currentUser}
	<div class="profile-card sb-foot" class:compact>
		<span class="sb-foot-avatar-wrap" bind:this={avatarWrap}><Menu
			class="sb-foot-avatar"
			label="Presence"
			triggerLabel={`${displayUsername}, ${presenceLabel}. Change presence`}
			heading={displayUsername}
			items={presenceItems}
			bind:open={presenceMenuOpen}
		>
			<span class="sb-foot-stamp" style={avatarInk}>
				{#if $currentUser.profilePicture}
					<ProfileMedia src={mediaUrl($currentUser.profilePicture)} alt="" class="sb-foot-picture" />
				{:else}
					<span class="sb-foot-initial" aria-hidden="true">{avatarInitial}</span>
				{/if}
				{#if $currentUser.overlayUrl && $profileDecorationsVisible}
					<ProfileDecoration user={$currentUser} class="avatar-overlay-badge" />
				{/if}
				<span
					class="sb-foot-presence"
					class:away={visibleStatus === 'away'}
					class:busy={visibleStatus === 'busy'}
					class:offline={visibleStatus === 'offline'}
					aria-hidden="true"
				></span>
			</span>
		</Menu></span>
		{#if showDetails}
			<button
				type="button"
				class="sb-foot-me"
				aria-label={`Your profile: ${displayUsername}, @${displayHandle}`}
				aria-haspopup="dialog"
				on:click={(event) => openProfilePopout(event.currentTarget)}
			>
				<span class="sb-foot-name"><ProfileName username={displayUsername} font={$currentUser.usernameFont} /></span>
				<span class="sb-foot-handle">@{displayHandle}</span>
				{#if activeCustomStatus?.label}
					<span class="sb-foot-status">{activeCustomStatus.label}</span>
				{/if}
			</button>
		{/if}
		{#if !compact}
			<div class="sb-foot-controls">
				<button
					type="button"
					class="w-ibtn sb-foot-toggle"
					aria-label="Mute microphone"
					aria-pressed={$callMuted}
					title={$callMuted ? 'Unmute' : 'Mute'}
					on:click={toggleMute}
				><Icon name={$callMuted ? 'micOff' : 'mic'} size={18} /></button>
				<button
					type="button"
					class="w-ibtn sb-foot-toggle"
					aria-label="Deafen"
					aria-pressed={$callDeafened}
					title={$callDeafened ? 'Undeafen' : 'Deafen'}
					on:click={() => toggleDeafen()}
				><Icon name={$callDeafened ? 'headphonesOff' : 'headphones'} size={18} /></button>
				{#if $isInCall}
					<button
						type="button"
						class="w-ibtn sb-foot-end"
						aria-label="End call"
						title="End call"
						on:click={() => endCall(getSocket())}
					><Icon name="phoneOff" size={18} /></button>
				{/if}
				<button
					type="button"
					class="w-ibtn"
					aria-label="Settings"
					title="Settings"
					on:click={() => dispatch('openSettings')}
				><Icon name="gear" size={18} /></button>
			</div>
		{/if}
	</div>
{/if}
