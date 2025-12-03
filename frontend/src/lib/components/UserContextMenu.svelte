<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { User } from '$lib/socket';

	export let user: User;
	export let x: number;
	export let y: number;
	export let isOwnProfile: boolean;

	const dispatch = createEventDispatcher<{
		close: void;
		voiceCall: void;
		videoCall: void;
		openDM: void;
		viewProfile: void;
	}>();

	let menuElement: HTMLDivElement;

	// Adjust position to keep menu on screen
	$: adjustedX = (() => {
		if (!menuElement) return x;
		const menuWidth = menuElement.offsetWidth || 200;
		const windowWidth = window.innerWidth;
		// If menu would go off right edge, flip to left
		if (x + menuWidth > windowWidth) {
			return x - menuWidth;
		}
		return x;
	})();

	$: adjustedY = (() => {
		if (!menuElement) return y;
		const menuHeight = menuElement.offsetHeight || 300;
		const windowHeight = window.innerHeight;
		// If menu would go off bottom edge, flip to top
		if (y + menuHeight > windowHeight) {
			return y - menuHeight;
		}
		return y;
	})();

	function handleClickOutside(event: MouseEvent) {
		dispatch('close');
	}

	function handleVoiceCall() {
		dispatch('voiceCall');
		dispatch('close');
	}

	function handleVideoCall() {
		dispatch('videoCall');
		dispatch('close');
	}

	function handleOpenDM() {
		dispatch('openDM');
		dispatch('close');
	}

	function handleViewProfile() {
		dispatch('viewProfile');
		dispatch('close');
	}
</script>

<svelte:window on:click={handleClickOutside} />

<div bind:this={menuElement} class="context-menu" style="left: {adjustedX}px; top: {adjustedY}px;" on:click|stopPropagation>
	<div class="menu-header">
		<div class="user-info">
			{#if user.profilePicture}
				<img src={user.profilePicture} alt={user.username} class="avatar" />
			{:else}
				<div class="avatar-placeholder" style="background-color: {user.color}">
					{user.username.charAt(0).toUpperCase()}
				</div>
			{/if}
			<span class="username">{user.username}</span>
		</div>
	</div>

	<div class="menu-divider"></div>

	{#if !isOwnProfile}
		<button class="menu-item" on:click={handleOpenDM}>
			<span class="icon">💬</span>
			<span>Send Message</span>
		</button>

		<button class="menu-item" on:click={handleVoiceCall}>
			<span class="icon">📞</span>
			<span>Voice Call</span>
		</button>

		<button class="menu-item" on:click={handleVideoCall}>
			<span class="icon">📹</span>
			<span>Video Call</span>
		</button>

		<div class="menu-divider"></div>
	{/if}

	<button class="menu-item" on:click={handleViewProfile}>
		<span class="icon">👤</span>
		<span>View Profile</span>
	</button>
</div>

<style>
	.context-menu {
		position: fixed;
		background: #2b2d31;
		border: 2px solid #5865f2;
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		min-width: 200px;
		z-index: 1000;
		padding: 0.5rem 0;
	}

	.menu-header {
		padding: 0.75rem 1rem;
		background: #1e1f22;
	}

	.user-info {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid #5865f2;
	}

	.avatar-placeholder {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 0.875rem;
		border: 2px solid #5865f2;
	}

	.username {
		font-weight: 700;
		color: #ffffff;
		font-size: 0.95rem;
	}

	.menu-divider {
		height: 2px;
		background: #404249;
		margin: 0.5rem 0;
	}

	.menu-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		background: transparent;
		border: none;
		color: #dbdee1;
		font-size: 0.95rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
		text-align: left;
	}

	.menu-item:hover {
		background: #5865f2;
		color: #ffffff;
		font-weight: 600;
	}

	.icon {
		font-size: 1.2rem;
		width: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
</style>
