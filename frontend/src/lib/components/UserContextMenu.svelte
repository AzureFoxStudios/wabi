<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import {
		type User,
		currentUser,
		forceLogoutUser,
		applyUserTimeout,
		removeUserTimeout,
		applyUserBan,
		removeUserBan,
		applyShadowRestriction,
		removeShadowRestriction
	} from '$lib/socket';
	import { canModerateTarget } from '$lib/moderationPermissions';

	export let user: User;
	export let x: number;
	export let y: number;
	export let isOwnProfile: boolean;

	const dispatch = createEventDispatcher();
	let menuElement: HTMLDivElement;
	let toastMessage = '';
	let toastType: 'success' | 'error' = 'success';

	$: me = $currentUser;
	$: canForceLogout = canModerateTarget(me, user, 'user.force_logout');
	$: canTimeout = canModerateTarget(me, user, 'user.timeout');
	$: canBan = canModerateTarget(me, user, 'user.ban');
	$: canShadowRestrict = canModerateTarget(me, user, 'user.shadow_restrict');
	$: showStaffActions = !isOwnProfile && !!user.dbUserId && (canForceLogout || canTimeout || canBan || canShadowRestrict);

	$: adjustedX = menuElement && x + (menuElement.offsetWidth || 200) > window.innerWidth ? x - (menuElement.offsetWidth || 200) : x;
	$: adjustedY = menuElement && y + (menuElement.offsetHeight || 300) > window.innerHeight ? y - (menuElement.offsetHeight || 300) : y;

	function showToast(message: string, type: 'success' | 'error') {
		toastMessage = message;
		toastType = type;
		setTimeout(() => (toastMessage = ''), 3000);
	}

	function performAction(actionName: string, fn: (cb: (r: { success: boolean; error?: string }) => void) => void) {
		fn((response) => {
			if (response.success) {
				showToast(`${actionName} completed for ${user.username}.`, 'success');
			} else {
				showToast(response.error || `${actionName} failed. Please try again.`, 'error');
			}
		});
	}

	function confirmAndRun(message: string, run: () => void) {
		if (confirm(message)) run();
	}
</script>

<svelte:window on:click={() => dispatch('close')} />
<div bind:this={menuElement} class="context-menu" style="left: {adjustedX}px; top: {adjustedY}px;" role="button" tabindex="0" on:click|stopPropagation>
	{#if toastMessage}
		<div class="toast {toastType}">{toastMessage}</div>
	{/if}
	<div class="menu-header"><div class="user-info"><span class="username">{user.username}</span></div></div>
	<div class="menu-divider"></div>

	{#if !isOwnProfile}
		<button class="menu-item" on:click={() => dispatch('openDM', { user })}>💬 Send Message</button>
		<button class="menu-item" on:click={() => dispatch('voiceCall')}>📞 Voice Call</button>
		<button class="menu-item" on:click={() => dispatch('videoCall')}>📹 Video Call</button>
		<button class="menu-item" on:click={() => dispatch('screenShare')}>📺 Screen Share</button>
		<div class="menu-divider"></div>
	{/if}

	<button class="menu-item" on:click={() => dispatch('viewProfile')}>👤 View Profile</button>

	{#if showStaffActions}
		<div class="menu-divider"></div>
		<div class="menu-label">Staff Actions</div>
		{#if canForceLogout}
			<button class="menu-item destructive" on:click={() => confirmAndRun(`Force logout ${user.username}?`, () => performAction('Force logout', cb => forceLogoutUser(user.dbUserId!, cb)))}>🚪 Force Logout</button>
		{/if}
		{#if canTimeout}
			{#if user.isTimedOut}
				<button class="menu-item" on:click={() => performAction('Remove timeout', cb => removeUserTimeout(user.dbUserId!, cb))}>⏱️ Remove Timeout</button>
			{:else}
				<button class="menu-item" on:click={() => {
					const input = prompt('Timeout duration in minutes', '10');
					const duration = Number(input || 10);
					if (!Number.isNaN(duration) && duration > 0) performAction('Apply timeout', cb => applyUserTimeout(user.dbUserId!, duration, cb));
				}}>⏱️ Apply Timeout</button>
			{/if}
		{/if}
		{#if canBan}
			{#if user.isBanned}
				<button class="menu-item" on:click={() => performAction('Remove ban', cb => removeUserBan(user.dbUserId!, cb))}>✅ Remove Ban</button>
			{:else}
				<button class="menu-item destructive" on:click={() => confirmAndRun(`Ban ${user.username}? This will immediately end their session.`, () => performAction('Apply ban', cb => applyUserBan(user.dbUserId!, cb)))}>🔨 Apply Ban</button>
			{/if}
		{/if}
		{#if canShadowRestrict}
			{#if user.isShadowRestricted}
				<button class="menu-item" on:click={() => performAction('Remove shadow restriction', cb => removeShadowRestriction(user.dbUserId!, cb))}>👁️ Remove Shadow Restriction</button>
			{:else}
				<button class="menu-item" on:click={() => confirmAndRun(`Apply shadow restriction to ${user.username}?`, () => performAction('Apply shadow restriction', cb => applyShadowRestriction(user.dbUserId!, cb)))}>👁️ Apply Shadow Restriction</button>
			{/if}
		{/if}
	{/if}
</div>

<style>
.context-menu{position:fixed;background:#2b2d31;border:2px solid #5865f2;border-radius:8px;min-width:220px;z-index:1000;padding:.5rem 0}.menu-item{width:100%;padding:.65rem 1rem;background:transparent;border:none;color:#dbdee1;text-align:left}.menu-item:hover{background:#5865f2;color:#fff}.menu-divider{height:1px;background:#404249;margin:.4rem 0}.menu-label{padding:.3rem 1rem;color:#8ea1e1;font-size:.75rem;text-transform:uppercase}.destructive{color:#ff9ea3}.toast{margin:.25rem .5rem;padding:.4rem .6rem;border-radius:6px;font-size:.8rem}.toast.success{background:#1f6f43}.toast.error{background:#8f2d38}
</style>
