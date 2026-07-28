<script lang="ts">
	import { onMount, createEventDispatcher } from 'svelte';
	import { fade } from 'svelte/transition';
	import { browser } from '$app/environment';
	import '$lib/business/theme.css';
	import {
		todos,
		projects,
		calendarEvents,
		diaryEntries,
		sprints,
		todaysTodos,
		overdueTodos
	} from '$lib/business/store';
	import Calendar from '$lib/components/business/Calendar.svelte';
	import DiaryView from '$lib/components/business/DiaryView.svelte';
	import ProjectsView from '$lib/components/business/ProjectsView.svelte';
	import KanbanBoard from '$lib/components/business/KanbanBoard.svelte';
	import TaskPanel from '$lib/components/business/TaskPanel.svelte';
	import BusinessPrivacyToggle from '$lib/components/BusinessPrivacyToggle.svelte';
	import Chat from '$lib/components/Chat.svelte';
	import GuestCodePrompt from '$lib/components/GuestCodePrompt.svelte';
	import { channels, currentChannel } from '$lib/socket';
	import {
		initGuestAccess,
		restoreActiveView,
		persistActiveView,
		computeQuickStats,
		exportBusinessData,
		importBusinessData,
		handleImportFileInput,
		handleChatChannelSwitch,
		type MainView,
		type GuestAccessState,
		type QuickStats
	} from '$lib/business/pageHelpers';
	import './businessPage.css';

	export let initialView: MainView | null = null;

	let activeView: MainView = 'calendar';
	let showTaskPanel = true;
	let taskPanelWidth = 380;
	let importFileInput: HTMLInputElement;
	let showLoadingScreen = true;

	// Chat panel state
	let showChatPanel = true;
	let chatPanelExpanded = false;

	// Guest access state
	let guestState: GuestAccessState = {
		isGuest: false,
		hasGuestAccess: false,
		showGuestPrompt: false,
		guestReadOnly: false
	};

	onMount(() => {
		showLoadingScreen = false;
		guestState = initGuestAccess();
		activeView = initialView ?? restoreActiveView();
	});

	function handleGuestVerified() {
		guestState = { ...guestState, hasGuestAccess: true, guestReadOnly: false };
	}

	function handleGuestReadOnly() {
		guestState = { ...guestState, hasGuestAccess: false, guestReadOnly: true };
	}

	$: if (typeof window !== 'undefined') {
		persistActiveView(activeView);
	}

	$: quickStats = computeQuickStats($todos, $overdueTodos, $todaysTodos, $calendarEvents);

	function toggleChatPanel() {
		showChatPanel = !showChatPanel;
	}

	function toggleChatExpanded() {
		chatPanelExpanded = !chatPanelExpanded;
	}
</script>

{#if showLoadingScreen}
	<div class="loading-screen" transition:fade={{ duration: 400 }}></div>
{/if}

<GuestCodePrompt
	bind:show={guestState.showGuestPrompt}
	on:verified={handleGuestVerified}
	on:readonly={handleGuestReadOnly}
/>

<div class="dashboard">
	<!-- Top Header Bar -->
	<header class="dashboard-header">
		<div class="header-left">
			<button class="back-btn" title="Back to Chat" on:click={() => history.length > 1 ? history.back() : (window.location.href = '/')}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M19 12H5M12 19l-7-7 7-7"/>
				</svg>
			</button>
			<h1>Business Hub</h1>
		</div>

		<nav class="header-nav">
			<button class="nav-tab" class:active={activeView === 'calendar'} on:click={() => activeView = 'calendar'}>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
					</svg>
				</span>
				Calendar
			</button>
			<button class="nav-tab" class:active={activeView === 'journal'} on:click={() => activeView = 'journal'}>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
					</svg>
				</span>
				Journal
			</button>
			<button class="nav-tab" class:active={activeView === 'projects'} on:click={() => activeView = 'projects'}>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
					</svg>
				</span>
				Projects
			</button>
			<button class="nav-tab" class:active={activeView === 'kanban'} on:click={() => activeView = 'kanban'}>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="8" rx="1"/>
					</svg>
				</span>
				Kanban
			</button>
		</nav>

		<div class="header-right">
			<!-- Quick Stats -->
			<div class="quick-stats">
				{#if quickStats.overdueCount > 0}
					<div class="stat-badge danger" title="Overdue tasks">
						<span class="stat-num">{quickStats.overdueCount}</span>
						<span class="stat-label">overdue</span>
					</div>
				{/if}
				{#if quickStats.todayCount > 0}
					<div class="stat-badge warning" title="Due today">
						<span class="stat-num">{quickStats.todayCount}</span>
						<span class="stat-label">today</span>
					</div>
				{/if}
				<div class="stat-badge" title="Tasks completed">
					<span class="stat-num">{quickStats.completedTasks}/{quickStats.totalTasks}</span>
					<span class="stat-label">done</span>
				</div>
			</div>

			<!-- Hidden file input for import -->
			<input type="file" bind:this={importFileInput} on:change={(e) => handleImportFileInput(e, importBusinessData)} accept=".json" style="display: none;" />

			<!-- Import Button -->
			<button class="panel-toggle" on:click={() => importFileInput?.click()} title="Import Business Data">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
				</svg>
			</button>

			<!-- Export Button -->
			<button class="panel-toggle" on:click={exportBusinessData} title="Export All Business Data">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
				</svg>
			</button>

			<!-- Task Panel Toggle -->
			<button class="panel-toggle" class:active={showTaskPanel} on:click={() => showTaskPanel = !showTaskPanel} title={showTaskPanel ? 'Hide Tasks' : 'Show Tasks'}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
				</svg>
				Tasks
			</button>
		</div>
	</header>

	<!-- Main Content Area -->
	<!-- Control Strip: dashboard overview -->
	<section class="business-control-strip" aria-label="Business status overview">
		<article class="biz-control-card biz-control-card--hero">
			<div class="biz-card-topline">
				<span>LOCAL · BUSINESS HUB</span>
				<span>WABI · OWNER SPACE</span>
			</div>
			<div class="biz-hero-metric">
				<span class="biz-hero-number">{quickStats.todayCount}</span>
				<span class="biz-hero-unit">due today</span>
			</div>
			<div class="biz-card-footerline">
				<span>{quickStats.completedTasks}/{quickStats.totalTasks} tasks complete</span>
				<span class="biz-status"><i class="biz-status-dot live"></i> local data</span>
			</div>
		</article>

		<article class="biz-control-card">
			<div class="biz-card-label">FOCUS</div>
			<div class="biz-card-value">{activeView}</div>
			<div class="biz-card-subtle">Current workspace mode</div>
		</article>

		<article class="biz-control-card">
			<div class="biz-card-label">OVERDUE</div>
			<div class="biz-card-value" class:warn={quickStats.overdueCount > 0}>{quickStats.overdueCount}</div>
			<div class="biz-card-subtle">Items needing attention</div>
		</article>

		<article class="biz-control-card">
			<div class="biz-card-label">PRIVACY</div>
			<div class="biz-card-value">LOCAL</div>
			<div class="biz-card-subtle">Private-by-default workspace</div>
		</article>
	</section>

	<!-- Read-only banner for guests -->
	{#if guestState.guestReadOnly}
		<div class="read-only-banner">
			👁️ Viewing in read-only mode. <button class="banner-link" on:click={() => guestState = { ...guestState, showGuestPrompt: true }}>Enter access code</button> to create/edit.
		</div>
	{/if}

	<div class="dashboard-body">
		<main class="main-content" class:panel-open={showTaskPanel}>
			{#if activeView === 'calendar'}
				<Calendar isReadOnly={guestState.isGuest && !guestState.hasGuestAccess} />
			{:else if activeView === 'journal'}
				<DiaryView isReadOnly={guestState.isGuest && !guestState.hasGuestAccess} />
			{:else if activeView === 'projects'}
				<ProjectsView isReadOnly={guestState.isGuest && !guestState.hasGuestAccess} />
			{:else if activeView === 'kanban'}
				<KanbanBoard {showTaskPanel} {taskPanelWidth} isReadOnly={guestState.isGuest && !guestState.hasGuestAccess} />
			{/if}
		</main>

		<!-- Right Task Panel -->
		{#if showTaskPanel}
			<aside class="task-panel" style="width: {taskPanelWidth}px">
				<TaskPanel onClose={() => showTaskPanel = false} />
				<BusinessPrivacyToggle />
			</aside>
		{/if}

		<!-- Chat Panel -->
		{#if showChatPanel}
			<div class="chat-panel-business" class:expanded={chatPanelExpanded}>
				<div class="chat-header">
					<div class="chat-title">
						{#if chatPanelExpanded}
							💬 Conversations
						{:else}
							{$channels.find(ch => ch.id === $currentChannel)?.name || 'Chat'}
						{/if}
					</div>
					<div class="chat-controls">
						<button class="chat-btn" on:click={toggleChatExpanded} title={chatPanelExpanded ? 'Show chat' : 'Show channels'}>
							{chatPanelExpanded ? '💬' : '👀'}
						</button>
						<button class="chat-btn" on:click={toggleChatPanel} title="Toggle chat panel">✕</button>
					</div>
				</div>

				{#if chatPanelExpanded}
					<!-- Channel/DM List -->
					<div class="chat-list">
						{#if $channels.length > 0}
							{#each $channels as channel}
								<button class="chat-list-item" class:active={$currentChannel === channel.id} on:click={() => handleChatChannelSwitch(channel.id)} title={channel.name}>
									<span class="chat-icon">
										{#if channel.type === 'dm'}👤{:else if channel.type === 'group'}👥{:else}#{/if}
									</span>
									<span class="chat-name">{channel.name}</span>
								</button>
							{/each}
						{:else}
							<div class="empty-list">No channels available</div>
						{/if}
					</div>
				{:else}
					<!-- Chat View -->
					<div class="chat-view"><Chat /></div>
				{/if}
			</div>
		{:else}
			<!-- Collapsed Chat Button -->
			<button class="chat-toggle-btn" on:click={toggleChatPanel} title="Open chat">💬</button>
		{/if}
	</div>
</div>
