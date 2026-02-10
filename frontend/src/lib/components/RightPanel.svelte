<script lang="ts">
	import { layoutStore } from '$lib/layoutStore';
	import UserListTab from './UserListTab.svelte';
	import DMTab from './DMTab.svelte';

	$: activeTab = $layoutStore.activeRightTab;
</script>

<div class="right-panel">
	<div class="right-panel-tabs">
		<button
			class="tab-btn"
			class:active={activeTab === 'users'}
			on:click={layoutStore.showUsersTab}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
				<circle cx="9" cy="7" r="4"/>
				<path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
				<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
			</svg>
			<span>Users</span>
		</button>
		<button
			class="tab-btn"
			class:active={activeTab === 'dms'}
			on:click={layoutStore.showDMsTab}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
			</svg>
			<span>DMs</span>
		</button>
		<div class="tab-spacer"></div>
		<button class="tab-close" on:click={layoutStore.toggleRightPanel} title="Close panel">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<line x1="18" y1="6" x2="6" y2="18"/>
				<line x1="6" y1="6" x2="18" y2="18"/>
			</svg>
		</button>
	</div>

	<div class="right-panel-content">
		{#if activeTab === 'users'}
			<UserListTab />
		{:else if activeTab === 'dms'}
			<DMTab />
		{/if}
	</div>
</div>

<style>
	.right-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-secondary);
	}

	.right-panel-tabs {
		display: flex;
		align-items: center;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		padding: 0 0.25rem;
		background: var(--bg-tertiary, var(--bg-secondary));
	}

	.tab-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.625rem 0.75rem;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 500;
		transition: color 0.15s, border-color 0.15s;
	}

	.tab-btn:hover {
		color: var(--text-primary);
	}

	.tab-btn.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}

	.tab-btn svg {
		flex-shrink: 0;
	}

	.tab-spacer {
		flex: 1;
	}

	.tab-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 4px;
		margin-right: 0.25rem;
	}

	.tab-close:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.right-panel-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	@media (max-width: 768px) {
		.tab-btn {
			padding: 0.75rem;
			font-size: 0.9rem;
			gap: 0.5rem;
		}

		.tab-close {
			width: 36px;
			height: 36px;
		}
	}
</style>
