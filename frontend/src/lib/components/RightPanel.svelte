<script lang="ts">
	import { layoutStore } from '$lib/layoutStore';
	import { currentUser } from '$lib/socket';
	import UserListTab from './UserListTab.svelte';
	import DMTab from './DMTab.svelte';
	import AdminTab from './AdminTab.svelte';

	$: activeTab = $layoutStore.activeRightTab;
	$: canAccessAdminTab = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin' || $currentUser?.highestRole === 'mod';
	$: if (!canAccessAdminTab && activeTab === 'admin') {
		layoutStore.showUsersTab();
	}
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
		{#if canAccessAdminTab}
			<button
				class="tab-btn"
				class:active={activeTab === 'admin'}
				on:click={layoutStore.showAdminTab}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 2l8 4v6c0 5.25-3.5 9.74-8 11-4.5-1.26-8-5.75-8-11V6l8-4z"/>
					<path d="M9 12l2 2 4-4"/>
				</svg>
				<span>Admin</span>
			</button>
		{/if}
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
		{:else if activeTab === 'admin'}
			<AdminTab />
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
		gap: 0.375rem;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		background: var(--bg-tertiary, var(--bg-secondary));
	}

	.tab-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		flex: 1 1 0;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid var(--border);
		border-radius: 10px;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.88rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
	}

	.tab-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
		border-color: rgba(var(--accent-rgb), 0.4);
	}

	.tab-btn.active {
		color: var(--text-primary);
		border-color: rgba(var(--accent-rgb), 0.65);
		background: rgba(var(--accent-rgb), 0.14);
		box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.2);
	}

	.tab-btn svg {
		flex-shrink: 0;
	}

	.tab-spacer {
		flex: 0;
	}

	.tab-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: none;
		border: 1px solid var(--border);
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: var(--radius-sm);
		margin-left: 0.15rem;
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
		.right-panel-tabs {
			padding: 0.45rem;
		}

		.tab-btn {
			padding: 0.6rem 0.7rem;
			font-size: 0.9rem;
			gap: 0.45rem;
		}

		.tab-close {
			width: 36px;
			height: 36px;
		}
	}
</style>
