<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { currentUser } from '$lib/socket';
	import Settings from './Settings.svelte';

	const dispatch = createEventDispatcher();

	let showSettings = false;
	let isMiniMode = false;

	function handleLogout() {
		dispatch('logout');
	}

	// Watch for parent width changes (via container queries or manual tracking)
	function checkMiniMode() {
		const sidebar = document.querySelector('.sidebar');
		if (sidebar) {
			isMiniMode = sidebar.offsetWidth < 100;
		}
	}

	// Optional: Add ResizeObserver for responsive behavior
	$: if (typeof window !== 'undefined') {
		// Check on mount and when component updates
		checkMiniMode();
	}
</script>

<aside class="sidebar" on:resize={checkMiniMode}>
	<div class="sidebar-top">
		<div class="logo">
			<img src="/wabi-logo-small.webp" alt="Wabi" class="logo-img" />
		</div>
	</div>

	<div class="spacer"></div>

	<div class="sidebar-bottom">
		<!-- Settings button (moves above profile in mini mode) -->
		<button class="settings-btn" on:click={() => showSettings = true} title="Settings" aria-label="Settings">
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m3.08 3.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m3.08-3.08l4.24-4.24M19.78 19.78l-4.24-4.24m-3.08-3.08l-4.24-4.24M19.78 4.22l-4.24 4.24m-3.08 3.08l-4.24-4.24"></path></svg>
		</button>

		<!-- User profile section -->
		{#if $currentUser}
			<div class="user-profile">
				<div class="user-avatar-container">
					{#if $currentUser.profilePicture}
						<img src={$currentUser.profilePicture} alt={$currentUser.username} class="user-avatar" title={$currentUser.username} />
					{:else}
						<div class="user-avatar-placeholder" style="background-color: {$currentUser.color}" title={$currentUser.username}>
							{$currentUser.username.charAt(0).toUpperCase()}
						</div>
					{/if}
					<span class="user-status" class:online={$currentUser.status === 'active'} class:away={$currentUser.status === 'away'} class:busy={$currentUser.status === 'busy'} title={$currentUser.status}></span>
				</div>
				<!-- Username only shown in full mode -->
				<div class="user-name-section">
					<span class="user-name">{$currentUser.username}</span>
					<span class="user-status-text">{$currentUser.status}</span>
				</div>
			</div>
		{/if}
	</div>
</aside>

<Settings bind:isOpen={showSettings} on:logout={handleLogout} />

<style>
	.sidebar {
		width: 80px;
		background: var(--bg-secondary);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.75rem 0;
		height: 100vh;
		transition: width 0.3s ease;
		gap: 0;
	}

	.sidebar-top {
		flex-shrink: 0;
		display: flex;
		justify-content: center;
		width: 100%;
	}

	.logo {
		padding: 0.5rem 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.logo-img {
		height: 50px;
		width: auto;
		filter: invert(1) drop-shadow(0 3px 6px rgba(0, 0, 0, 0.4));
		transition: transform 0.3s ease;
	}

	.logo-img:hover {
		transform: scale(1.05);
	}

	.spacer {
		flex: 1;
		min-height: 1rem;
	}

	.sidebar-bottom {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem 0;
		border-top: 1px solid var(--border);
	}

	/* Settings Button */
	.settings-btn {
		background: transparent;
		border: none;
		font-size: 1.3rem;
		cursor: pointer;
		color: var(--text-secondary);
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		transition: all 0.2s ease;
		flex-shrink: 0;
	}

	.settings-btn:hover {
		color: var(--text-primary);
		background: var(--bg-tertiary);
		transform: rotate(20deg);
	}

	.settings-btn:active {
		transform: rotate(20deg) scale(0.95);
	}

	.settings-btn svg {
		width: 20px;
		height: 20px;
		stroke: currentColor;
		stroke-width: 2;
	}

	/* User Profile Section */
	.user-profile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0;
		transition: all 0.3s ease;
	}

	.user-avatar-container {
		position: relative;
		flex-shrink: 0;
	}

	.user-avatar,
	.user-avatar-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		border: 2px solid var(--accent);
		object-fit: cover;
		cursor: pointer;
		transition: all 0.2s ease;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 0.9rem;
	}

	.user-avatar:hover,
	.user-avatar-placeholder:hover {
		transform: scale(1.1);
		box-shadow: 0 0 8px rgba(var(--accent-rgb), 0.3);
	}

	.user-status {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--bg-secondary);
		transition: background-color 0.3s ease;
	}

	.user-status.online {
		background-color: var(--status-online);
	}

	.user-status.away {
		background-color: var(--status-away);
	}

	.user-status.busy {
		background-color: var(--status-busy);
	}

	/* Username (hidden in mini mode, shown in full) */
	.user-name-section {
		display: none;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		width: 100%;
		padding: 0 0.5rem;
		text-align: center;
		opacity: 0;
		transition: opacity 0.3s ease;
	}

	.user-name {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-primary);
		word-break: break-word;
		max-width: 100%;
	}

	.user-status-text {
		font-size: 0.65rem;
		color: var(--text-tertiary);
		text-transform: capitalize;
	}

	/* Full-width sidebar mode (expandable) */
	@media (min-width: 100px) {
		.sidebar {
			width: 100px;
		}

		.user-name-section {
			display: flex;
			opacity: 1;
		}
	}

	/* Tablet/Desktop - could expand further */
	@media (min-width: 140px) {
		.sidebar {
			width: 140px;
			padding: 1rem 0.5rem;
		}

		.logo {
			padding: 0.5rem;
			margin-bottom: 0.5rem;
		}

		.logo-img {
			height: 60px;
		}

		.sidebar-bottom {
			gap: 1rem;
			padding: 1rem 0;
		}

		.settings-btn {
			width: 48px;
			height: 48px;
		}

		.user-avatar,
		.user-avatar-placeholder {
			width: 48px;
			height: 48px;
		}

		.user-name {
			font-size: 0.85rem;
		}

		.user-status-text {
			font-size: 0.7rem;
		}
	}

	/* Mobile responsiveness */
	@media (max-width: 768px) {
		.sidebar {
			width: 60px;
			padding: 0.5rem 0;
		}

		.logo-img {
			height: 40px;
		}

		.user-avatar,
		.user-avatar-placeholder {
			width: 36px;
			height: 36px;
		}

		.user-name-section {
			display: none;
		}
	}
</style>
