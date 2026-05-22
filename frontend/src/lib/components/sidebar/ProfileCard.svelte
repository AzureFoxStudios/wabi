<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { currentUser, updateProfile, roleDefinitions } from '$lib/socket';
	import { isMuted as callMuted, isDeafened as callDeafened, toggleMute, toggleDeafen } from '$lib/calling';
	import { clearActiveCustomStatusPreset } from '$lib/customStatusPresets';
	import { FALLBACK_ROLE_LABELS } from './channelSidebarHelpers';

	export let sidebarWidth: number;

	const dispatch = createEventDispatcher();

	let showStatusPopup = false;

	$: currentUserRoleLabel = (() => {
		if (!$currentUser) return '';
		const roleName = $currentUser.highestRole || ($currentUser.dbUserId ? 'member' : 'guest');
		const roleDefinition = $roleDefinitions.find(role => role.roleName === roleName);
		return roleDefinition?.displayName || FALLBACK_ROLE_LABELS[roleName] || roleName;
	})();

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
</script>

{#if $currentUser}
	<div class="profile-card">
		<div class="profile-info">
			<button class="avatar-container" on:click={openProfilePopout}>
				{#if $currentUser.profilePicture}
					<img src={$currentUser.profilePicture} alt={$currentUser.username} class="avatar" />
				{:else}
					<div class="avatar-placeholder" style="--avatar-color: {$currentUser.color}">
						{$currentUser.username.charAt(0).toUpperCase()}
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
					<span class="username-text">{$currentUser.username}</span>
					<span class="self-role-badge">{currentUserRoleLabel}</span>
				</div>
				<div class="user-tag">@{$currentUser.handle || $currentUser.username}</div>
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
					on:click={() => dispatch('openSettings')}
					title="User Settings"
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				</button>
			{/if}
		</div>
	</div>
{/if}
