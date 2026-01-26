<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import Settings from './Settings.svelte';

	const dispatch = createEventDispatcher();

	let showSettings = false;

	function handleLogout() {
		dispatch('logout');
	}
</script>

<aside class="sidebar">
	<div class="logo">
		<img src="/wabi-logo-small.webp" alt="Wabi" class="logo-img" />
	</div>

	<div class="spacer"></div>

	<button class="settings-btn" on:click={() => showSettings = true} title="Settings">
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m3.08 3.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m3.08-3.08l4.24-4.24M19.78 19.78l-4.24-4.24m-3.08-3.08l-4.24-4.24M19.78 4.22l-4.24 4.24m-3.08 3.08l-4.24-4.24"></path></svg>
	</button>
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
		padding: 1rem 0;
		height: 100vh;
	}

	.logo {
		padding: 0 1rem;
		margin-bottom: 1rem;
	}

	.logo-img {
		height: 50px;
		width: auto;
		filter: invert(1) drop-shadow(0 3px 6px rgba(0, 0, 0, 0.4));
	}

	.spacer {
		flex: 1;
	}

	.settings-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.75rem;
		transition: all 0.2s;
		border-radius: 8px;
		margin: 0.5rem;
	}

	.settings-btn:hover {
		color: var(--text-primary);
		background: var(--bg-tertiary);
		transform: rotate(45deg);
	}
</style>
