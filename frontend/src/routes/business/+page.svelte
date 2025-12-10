<script lang="ts">
	import { currentView } from '$lib/business/store';
	import type { DashboardView } from '$lib/business/types';
	import TodoList from '$lib/components/business/TodoList.svelte';
	import Calendar from '$lib/components/business/Calendar.svelte';
	import DiaryView from '$lib/components/business/DiaryView.svelte';
	import ProjectsView from '$lib/components/business/ProjectsView.svelte';
	import Overview from '$lib/components/business/Overview.svelte';

	const navItems: { id: DashboardView; label: string; icon: string }[] = [
		{ id: 'overview', label: 'Overview', icon: '📊' },
		{ id: 'todos', label: 'Tasks', icon: '✅' },
		{ id: 'calendar', label: 'Calendar', icon: '📅' },
		{ id: 'diary', label: 'Journal', icon: '📓' },
		{ id: 'projects', label: 'Projects', icon: '📁' }
	];

	function setView(view: DashboardView) {
		currentView.set(view);
	}
</script>

<div class="business-container">
	<nav class="sidebar">
		<div class="sidebar-header">
			<h1>Business Hub</h1>
		</div>
		<ul class="nav-list">
			{#each navItems as item}
				<li>
					<button
						class="nav-item"
						class:active={$currentView === item.id}
						on:click={() => setView(item.id)}
					>
						<span class="nav-icon">{item.icon}</span>
						<span class="nav-label">{item.label}</span>
					</button>
				</li>
			{/each}
		</ul>
		<div class="sidebar-footer">
			<a href="/" class="back-link">← Back to Chat</a>
		</div>
	</nav>

	<main class="main-content">
		{#if $currentView === 'overview'}
			<Overview />
		{:else if $currentView === 'todos'}
			<TodoList />
		{:else if $currentView === 'calendar'}
			<Calendar />
		{:else if $currentView === 'diary'}
			<DiaryView />
		{:else if $currentView === 'projects'}
			<ProjectsView />
		{/if}
	</main>
</div>

<style>
	.business-container {
		display: flex;
		height: 100vh;
		background-color: var(--bg-primary, #1a1a2e);
		color: var(--text-primary, #eee);
	}

	.sidebar {
		width: 240px;
		background-color: var(--bg-secondary, #16213e);
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border-color, #2a2a4a);
	}

	.sidebar-header {
		padding: 1.5rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.sidebar-header h1 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--accent, #5865f2);
	}

	.nav-list {
		list-style: none;
		padding: 0.5rem;
		margin: 0;
		flex: 1;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem 1rem;
		border: none;
		background: transparent;
		color: var(--text-secondary, #aaa);
		font-size: 0.95rem;
		cursor: pointer;
		border-radius: 8px;
		transition: all 0.2s ease;
		text-align: left;
	}

	.nav-item:hover {
		background-color: var(--bg-hover, #1f2937);
		color: var(--text-primary, #eee);
	}

	.nav-item.active {
		background-color: var(--accent, #5865f2);
		color: white;
	}

	.nav-icon {
		font-size: 1.1rem;
	}

	.sidebar-footer {
		padding: 1rem;
		border-top: 1px solid var(--border-color, #2a2a4a);
	}

	.back-link {
		color: var(--text-secondary, #aaa);
		text-decoration: none;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		border-radius: 6px;
		transition: all 0.2s ease;
	}

	.back-link:hover {
		background-color: var(--bg-hover, #1f2937);
		color: var(--text-primary, #eee);
	}

	.main-content {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem;
	}
</style>
