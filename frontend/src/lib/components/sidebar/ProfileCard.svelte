<!--
	Sidebar foot (spec §8.1 item 8): the 80px band on the footer rule. Avatar 36 with its
	presence dot (the avatar opens the presence menu), name over handle (opens your profile),
	then Mute, Deafen and Settings as 32px icon buttons (44px on touch) with aria-label and
	aria-pressed, plus End call while you are in a call.
	The foot measures itself and fits what it has room for (planSidebarFoot): Settings, then
	Deafen, move into the avatar menu before the name goes, so nothing is clipped at the column
	edge. In the 60px compact rail only the avatar shows and its menu holds every control.
-->
<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
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
	import { planSidebarFoot } from './channelSidebarHelpers';

	/** The stored desktop column width: only a fallback until the foot has measured itself. */
	export let sidebarWidth: number;
	/** The 60px rail: the avatar alone (its menu still sets presence and opens your profile). */
	export let compact = false;

	const dispatch = createEventDispatcher();

	/** The foot's real width (the column on a desktop, the drawer on a phone). */
	let footWidth = 0;
	/** Touch keys are 44px (spec §10), so they take more room than the 32px desktop keys. */
	let coarsePointer = false;
	onMount(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const query = window.matchMedia('(pointer: coarse)');
		const read = () => {
			coarsePointer = query.matches;
		};
		read();
		query.addEventListener('change', read);
		return () => query.removeEventListener('change', read);
	});

	$: footPlan = planSidebarFoot(compact ? 0 : footWidth || sidebarWidth, { inCall: $isInCall, coarse: coarsePointer });
	$: showDetails = footPlan.name;
	$: inlineControls = new Set(footPlan.inline);
	$: overflowControls = new Set(footPlan.overflow);

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

	/** Foot keys with no room in the foot: the same toggles, as checkbox rows in the avatar menu. */
	function overflowSoundItems(overflow: Set<string>, muted: boolean, deafened: boolean): MenuEntry[] {
		const rows: MenuEntry[] = [];
		if (overflow.has('mute')) {
			rows.push({ id: 'foot-mute', label: 'Mute microphone', icon: 'micOff', role: 'menuitemcheckbox', checked: muted, onSelect: toggleMute });
		}
		if (overflow.has('deafen')) {
			rows.push({ id: 'foot-deafen', label: 'Deafen', icon: 'headphonesOff', role: 'menuitemcheckbox', checked: deafened, onSelect: () => toggleDeafen() });
		}
		return rows.length > 0 ? [{ id: 'sound-divider', type: 'separator' }, ...rows] : [];
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
		...overflowSoundItems(overflowControls, $callMuted, $callDeafened),
		{ id: 'presence-divider', type: 'separator' },
		{
			id: 'view-profile',
			label: 'View profile',
			icon: 'user',
			onSelect: () => openProfilePopout(avatarWrap)
		},
		// Settings is always here, whether or not the foot has room for its key.
		{ id: 'open-settings', label: 'Settings', icon: 'gear', onSelect: () => { dispatch('openSettings'); } },
		...(overflowControls.has('end')
			? ([
					{ id: 'end-divider', type: 'separator' },
					{ id: 'foot-end', label: 'End call', icon: 'phoneOff', danger: true, onSelect: () => endCall(getSocket()) }
				] satisfies MenuEntry[])
			: [])
	] as MenuEntry[];
</script>

{#if $currentUser}
	<div class="profile-card sb-foot" class:compact bind:clientWidth={footWidth}>
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
		{#if inlineControls.size > 0}
			<!-- Toggles keep one name and report their state with aria-pressed (spec §7.2). -->
			<div class="sb-foot-controls">
				{#if inlineControls.has('mute')}
					<button
						type="button"
						class="w-ibtn sb-foot-toggle"
						aria-label="Mute microphone"
						aria-pressed={$callMuted}
						title="Mute microphone"
						on:click={toggleMute}
					><Icon name={$callMuted ? 'micOff' : 'mic'} size={18} /></button>
				{/if}
				{#if inlineControls.has('deafen')}
					<button
						type="button"
						class="w-ibtn sb-foot-toggle"
						aria-label="Deafen"
						aria-pressed={$callDeafened}
						title="Deafen"
						on:click={() => toggleDeafen()}
					><Icon name={$callDeafened ? 'headphonesOff' : 'headphones'} size={18} /></button>
				{/if}
				{#if inlineControls.has('end')}
					<button
						type="button"
						class="w-ibtn sb-foot-end"
						aria-label="End call"
						title="End call"
						on:click={() => endCall(getSocket())}
					><Icon name="phoneOff" size={18} /></button>
				{/if}
				{#if inlineControls.has('settings')}
					<button
						type="button"
						class="w-ibtn"
						aria-label="Settings"
						title="Settings"
						on:click={() => dispatch('openSettings')}
					><Icon name="gear" size={18} /></button>
				{/if}
			</div>
		{/if}
	</div>
{/if}
