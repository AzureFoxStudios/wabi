<script lang="ts">
	import {
		todos,
		calendarEvents,
		diaryEntries,
		projects,
		todosByStatus,
		todaysTodos,
		overdueTodos,
		upcomingEvents,
		currentView
	} from '$lib/business/store';
	import type { DashboardView } from '$lib/business/types';

	// Quick stats
	$: totalTodos = $todos.length;
	$: completedTodos = $todosByStatus.done.length;
	$: inProgressTodos = $todosByStatus.in_progress.length;
	$: overdueCount = $overdueTodos.length;
	$: todaysCount = $todaysTodos.length;
	$: upcomingCount = $upcomingEvents.length;

	// Calculate completion percentage
	$: completionPercent = totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0;

	function navigateTo(view: DashboardView) {
		currentView.set(view);
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString('en-US', {
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function getPriorityColor(priority: string): string {
		switch (priority) {
			case 'urgent': return '#ef4444';
			case 'high': return '#f97316';
			case 'medium': return '#eab308';
			case 'low': return '#22c55e';
			default: return '#6b7280';
		}
	}
</script>

<div class="overview">
	<header class="overview-header">
		<h1>Dashboard</h1>
		<p class="date-display">{new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
	</header>

	<!-- Stats Cards -->
	<div class="stats-grid">
		<div class="stat-card" on:click={() => navigateTo('todos')}>
			<div class="stat-icon">✅</div>
			<div class="stat-content">
				<div class="stat-value">{completedTodos}/{totalTodos}</div>
				<div class="stat-label">Tasks Completed</div>
			</div>
			<div class="stat-progress">
				<div class="progress-bar" style="width: {completionPercent}%"></div>
			</div>
		</div>

		<div class="stat-card warning" on:click={() => navigateTo('todos')}>
			<div class="stat-icon">⚠️</div>
			<div class="stat-content">
				<div class="stat-value">{overdueCount}</div>
				<div class="stat-label">Overdue Tasks</div>
			</div>
		</div>

		<div class="stat-card" on:click={() => navigateTo('calendar')}>
			<div class="stat-icon">📅</div>
			<div class="stat-content">
				<div class="stat-value">{upcomingCount}</div>
				<div class="stat-label">Upcoming Events</div>
			</div>
		</div>

		<div class="stat-card" on:click={() => navigateTo('projects')}>
			<div class="stat-icon">📁</div>
			<div class="stat-content">
				<div class="stat-value">{$projects.length}</div>
				<div class="stat-label">Active Projects</div>
			</div>
		</div>
	</div>

	<!-- Main Content Grid -->
	<div class="content-grid">
		<!-- Today's Tasks -->
		<section class="content-card">
			<div class="card-header">
				<h2>Today's Tasks</h2>
				<button class="view-all" on:click={() => navigateTo('todos')}>View All</button>
			</div>
			<div class="card-content">
				{#if $todaysTodos.length === 0}
					<p class="empty-message">No tasks due today</p>
				{:else}
					<ul class="task-list">
						{#each $todaysTodos.slice(0, 5) as todo}
							<li class="task-item">
								<span class="priority-dot" style="background-color: {getPriorityColor(todo.priority)}"></span>
								<span class="task-title">{todo.title}</span>
								{#if todo.dueDate}
									<span class="task-time">{formatTime(todo.dueDate)}</span>
								{/if}
							</li>
						{/each}
					</ul>
					{#if $todaysTodos.length > 5}
						<p class="more-items">+{$todaysTodos.length - 5} more</p>
					{/if}
				{/if}
			</div>
		</section>

		<!-- Overdue Tasks -->
		{#if overdueCount > 0}
			<section class="content-card alert">
				<div class="card-header">
					<h2>Overdue</h2>
					<button class="view-all" on:click={() => navigateTo('todos')}>View All</button>
				</div>
				<div class="card-content">
					<ul class="task-list">
						{#each $overdueTodos.slice(0, 3) as todo}
							<li class="task-item">
								<span class="priority-dot" style="background-color: {getPriorityColor(todo.priority)}"></span>
								<span class="task-title">{todo.title}</span>
								{#if todo.dueDate}
									<span class="task-date overdue">{formatDate(todo.dueDate)}</span>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			</section>
		{/if}

		<!-- Upcoming Events -->
		<section class="content-card">
			<div class="card-header">
				<h2>Upcoming Events</h2>
				<button class="view-all" on:click={() => navigateTo('calendar')}>View All</button>
			</div>
			<div class="card-content">
				{#if $upcomingEvents.length === 0}
					<p class="empty-message">No upcoming events this week</p>
				{:else}
					<ul class="event-list">
						{#each $upcomingEvents.slice(0, 5) as event}
							<li class="event-item">
								<div class="event-date-badge" style="background-color: {event.color || '#5865f2'}">
									<span class="event-day">{new Date(event.startDate).getDate()}</span>
									<span class="event-month">{new Date(event.startDate).toLocaleDateString('en-US', { month: 'short' })}</span>
								</div>
								<div class="event-details">
									<span class="event-title">{event.title}</span>
									{#if !event.allDay}
										<span class="event-time">{formatTime(event.startDate)}</span>
									{:else}
										<span class="event-time">All day</span>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</section>

		<!-- In Progress -->
		<section class="content-card">
			<div class="card-header">
				<h2>In Progress</h2>
				<span class="badge">{inProgressTodos}</span>
			</div>
			<div class="card-content">
				{#if $todosByStatus.in_progress.length === 0}
					<p class="empty-message">No tasks in progress</p>
				{:else}
					<ul class="task-list">
						{#each $todosByStatus.in_progress.slice(0, 4) as todo}
							<li class="task-item">
								<span class="priority-dot" style="background-color: {getPriorityColor(todo.priority)}"></span>
								<span class="task-title">{todo.title}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</section>

		<!-- Recent Journal Entries -->
		<section class="content-card wide">
			<div class="card-header">
				<h2>Recent Journal Entries</h2>
				<button class="view-all" on:click={() => navigateTo('diary')}>View All</button>
			</div>
			<div class="card-content">
				{#if $diaryEntries.length === 0}
					<p class="empty-message">No journal entries yet. Start writing!</p>
				{:else}
					<div class="diary-preview-list">
						{#each $diaryEntries.slice(0, 3) as entry}
							<div class="diary-preview">
								<div class="diary-date">{formatDate(entry.date)}</div>
								{#if entry.mood}
									<span class="mood-badge">{entry.mood === 'great' ? '😄' : entry.mood === 'good' ? '🙂' : entry.mood === 'neutral' ? '😐' : entry.mood === 'bad' ? '😕' : '😢'}</span>
								{/if}
								<p class="diary-excerpt">{entry.content.slice(0, 100)}{entry.content.length > 100 ? '...' : ''}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</section>
	</div>
</div>

<style>
	.overview {
		max-width: 1400px;
		margin: 0 auto;
	}

	.overview-header {
		margin-bottom: 1.5rem;
	}

	.overview-header h1 {
		margin: 0 0 0.25rem 0;
		font-size: 1.75rem;
		font-weight: 600;
	}

	.date-display {
		color: var(--text-secondary, #888);
		margin: 0;
	}

	/* Stats Grid */
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.stat-card {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		padding: 1.25rem;
		cursor: pointer;
		transition: all 0.2s ease;
		border: 1px solid var(--border-color, #2a2a4a);
		position: relative;
		overflow: hidden;
	}

	.stat-card:hover {
		transform: translateY(-2px);
		border-color: var(--accent, #5865f2);
	}

	.stat-card.warning .stat-value {
		color: #f97316;
	}

	.stat-icon {
		font-size: 1.5rem;
		margin-bottom: 0.5rem;
	}

	.stat-value {
		font-size: 1.75rem;
		font-weight: 700;
		color: var(--text-primary, #fff);
	}

	.stat-label {
		font-size: 0.85rem;
		color: var(--text-secondary, #888);
		margin-top: 0.25rem;
	}

	.stat-progress {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 4px;
		background: var(--bg-tertiary, #1f2937);
	}

	.progress-bar {
		height: 100%;
		background: var(--accent, #5865f2);
		transition: width 0.3s ease;
	}

	/* Content Grid */
	.content-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 1rem;
	}

	.content-card {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		border: 1px solid var(--border-color, #2a2a4a);
		overflow: hidden;
	}

	.content-card.wide {
		grid-column: span 2;
	}

	.content-card.alert {
		border-color: #ef4444;
	}

	.content-card.alert .card-header h2 {
		color: #ef4444;
	}

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.card-header h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}

	.view-all {
		background: transparent;
		border: none;
		color: var(--accent, #5865f2);
		font-size: 0.85rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: background 0.2s;
	}

	.view-all:hover {
		background: var(--bg-hover, #1f2937);
	}

	.badge {
		background: var(--accent, #5865f2);
		color: white;
		font-size: 0.75rem;
		padding: 0.2rem 0.5rem;
		border-radius: 12px;
		font-weight: 600;
	}

	.card-content {
		padding: 1rem 1.25rem;
	}

	.empty-message {
		color: var(--text-secondary, #888);
		font-size: 0.9rem;
		text-align: center;
		padding: 1rem 0;
		margin: 0;
	}

	/* Task List */
	.task-list, .event-list {
		list-style: none;
		padding: 0;
		margin: 0;
	}

	.task-item, .event-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.task-item:last-child, .event-item:last-child {
		border-bottom: none;
	}

	.priority-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.task-title, .event-title {
		flex: 1;
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.task-time, .task-date {
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
	}

	.task-date.overdue {
		color: #ef4444;
	}

	.more-items {
		text-align: center;
		color: var(--text-secondary, #888);
		font-size: 0.85rem;
		margin: 0.5rem 0 0 0;
	}

	/* Event List */
	.event-item {
		display: flex;
		gap: 1rem;
	}

	.event-date-badge {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border-radius: 8px;
		color: white;
		flex-shrink: 0;
	}

	.event-day {
		font-size: 1.1rem;
		font-weight: 700;
		line-height: 1;
	}

	.event-month {
		font-size: 0.65rem;
		text-transform: uppercase;
	}

	.event-details {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
	}

	.event-title {
		font-weight: 500;
	}

	.event-time {
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
	}

	/* Diary Preview */
	.diary-preview-list {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1rem;
	}

	.diary-preview {
		background: var(--bg-tertiary, #1f2937);
		border-radius: 8px;
		padding: 1rem;
	}

	.diary-date {
		font-size: 0.8rem;
		color: var(--accent, #5865f2);
		font-weight: 600;
		margin-bottom: 0.25rem;
	}

	.mood-badge {
		font-size: 1.25rem;
	}

	.diary-excerpt {
		font-size: 0.85rem;
		color: var(--text-secondary, #aaa);
		margin: 0.5rem 0 0 0;
		line-height: 1.4;
	}

	@media (max-width: 768px) {
		.content-card.wide {
			grid-column: span 1;
		}

		.stats-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
