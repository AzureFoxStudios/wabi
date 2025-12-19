<script lang="ts">
	import { get } from 'svelte/store';
	import {
		calendarEvents,
		todos,
		selectedDate,
		addCalendarEvent,
		updateCalendarEvent,
		deleteCalendarEvent,
		updateTodo
	} from '$lib/business/store';
	import type { CalendarEvent, Todo } from '$lib/business/types';

	// Current view state
	let currentMonth = new Date();
	let days: Date[] = [];
	let showEventModal = false;
	let editingEvent: CalendarEvent | null = null;
	let selectedDayEvents: CalendarEvent[] = [];
	let showDayModal = false;

	// Form state
	let formTitle = '';
	let formDescription = '';
	let formStartDate = '';
	let formStartTime = '';
	let formEndDate = '';
	let formAllDay = false;
	let formColor = '#5865f2';

	const colorOptions = [
		'#5865f2', // Blue
		'#3ba55d', // Green
		'#faa81a', // Yellow
		'#ed4245', // Red
		'#9b59b6', // Purple
		'#e91e63', // Pink
		'#00bcd4', // Cyan
		'#ff9800'  // Orange
	];

	// Calendar generation
	function getDaysInMonth(date: Date): Date[] {
		const year = date.getFullYear();
		const month = date.getMonth();
		const firstDay = new Date(year, month, 1);
		const lastDay = new Date(year, month + 1, 0);

		const days: Date[] = [];

		// Add padding days from previous month
		const startPadding = firstDay.getDay();
		for (let i = startPadding - 1; i >= 0; i--) {
			const d = new Date(year, month, -i);
			days.push(d);
		}

		// Add days of current month
		for (let d = 1; d <= lastDay.getDate(); d++) {
			days.push(new Date(year, month, d));
		}

		// Add padding days from next month to complete the grid
		const remaining = 42 - days.length; // 6 rows * 7 days
		for (let i = 1; i <= remaining; i++) {
			days.push(new Date(year, month + 1, i));
		}

		return days;
	}

	function isToday(date: Date): boolean {
		const today = new Date();
		return date.toDateString() === today.toDateString();
	}

	function isCurrentMonth(date: Date): boolean {
		return date.getMonth() === currentMonth.getMonth();
	}

	function isSameDay(date1: Date, date2: Date): boolean {
		return date1.toDateString() === date2.toDateString();
	}

	function getEventsForDay(date: Date): CalendarEvent[] {
		const dayStart = new Date(date);
		dayStart.setHours(0, 0, 0, 0);
		const dayEnd = new Date(date);
		dayEnd.setHours(23, 59, 59, 999);

		return get(calendarEvents).filter(event => {
			const eventStart = new Date(event.startDate);
			const eventEnd = event.endDate ? new Date(event.endDate) : eventStart;
			return (
				(eventStart >= dayStart && eventStart <= dayEnd) ||
				(eventEnd >= dayStart && eventEnd <= dayEnd) ||
				(eventStart <= dayStart && eventEnd >= dayEnd)
			);
		}).sort((a, b) => a.startDate - b.startDate);
	}

	function getTasksForDay(date: Date): Todo[] {
		const dayStart = new Date(date);
		dayStart.setHours(0, 0, 0, 0);
		const dayEnd = new Date(date);
		dayEnd.setHours(23, 59, 59, 999);

		return get(todos).filter(todo =>
			todo.dueDate &&
			todo.dueDate >= dayStart.getTime() &&
			todo.dueDate <= dayEnd.getTime() &&
			todo.status !== 'done' &&
			todo.status !== 'archived'
		).sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));
	}

	function getPriorityColor(priority: string): string {
		switch (priority) {
			case 'urgent': return '#ef4444';
			case 'high': return '#f97316';
			case 'medium': return '#eab308';
			case 'low': return '#22c55e';
			default: return '#64748b';
		}
	}

	function toggleTaskComplete(todo: Todo) {
		updateTodo(todo.id, {
			status: todo.status === 'done' ? 'todo' : 'done',
			completedAt: todo.status === 'done' ? undefined : Date.now()
		});
	}

	// Upcoming tasks (next 7 days)
	$: upcomingTasks = $todos
		.filter(t =>
			t.dueDate &&
			t.status !== 'done' &&
			t.status !== 'archived' &&
			t.dueDate >= Date.now() &&
			t.dueDate <= Date.now() + 7 * 24 * 60 * 60 * 1000
		)
		.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0))
		.slice(0, 8);

	// Overdue tasks
	$: overdueTasks = $todos
		.filter(t =>
			t.dueDate &&
			t.status !== 'done' &&
			t.status !== 'archived' &&
			t.dueDate < Date.now()
		)
		.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));

	function prevMonth() {
		currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
	}

	function nextMonth() {
		currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
	}

	function goToToday() {
		currentMonth = new Date();
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString('en-US', {
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function formatDateForInput(date: Date): string {
		// Use local timezone, not UTC
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function formatTimeForInput(date: Date): string {
		return date.toTimeString().slice(0, 5);
	}

	// Modal handlers
	function openAddModal(date?: Date) {
		resetForm();
		// Default to provided date, or today if none provided
		const defaultDate = date || new Date();
		formStartDate = formatDateForInput(defaultDate);
		showEventModal = true;
	}

	function openEditModal(event: CalendarEvent) {
		editingEvent = event;
		formTitle = event.title;
		formDescription = event.description || '';
		formStartDate = formatDateForInput(new Date(event.startDate));
		formStartTime = event.allDay ? '' : formatTimeForInput(new Date(event.startDate));
		formEndDate = event.endDate ? formatDateForInput(new Date(event.endDate)) : '';
		formAllDay = event.allDay;
		formColor = event.color || '#5865f2';
		showEventModal = true;
	}

	function openDayModal(date: Date) {
		selectedDate.set(date.getTime());
		showDayModal = true;
	}

	// Reactive statement: update selectedDayEvents whenever calendar events or selected date changes
	$: {
		if (showDayModal) {
			selectedDayEvents = getEventsForDay(new Date($selectedDate));
		}
		// Force dependency on calendarEvents by reading it
		void $calendarEvents;
	}

	function closeModal() {
		showEventModal = false;
		showDayModal = false;
		resetForm();
	}

	function resetForm() {
		formTitle = '';
		formDescription = '';
		formStartDate = '';
		formStartTime = '';
		formEndDate = '';
		formAllDay = false;
		formColor = '#5865f2';
		editingEvent = null;
	}

	function handleSubmit() {
		if (!formTitle.trim() || !formStartDate) return;

		const startDate = new Date(formStartDate);
		if (!formAllDay && formStartTime) {
			const [hours, minutes] = formStartTime.split(':');
			startDate.setHours(parseInt(hours), parseInt(minutes));
		}

		const eventData = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			startDate: startDate.getTime(),
			endDate: formEndDate ? new Date(formEndDate).getTime() : undefined,
			allDay: formAllDay,
			color: formColor,
			createdBy: 'current-user'
		};

		if (editingEvent) {
			updateCalendarEvent(editingEvent.id, eventData);
		} else {
			addCalendarEvent(eventData);
		}

		closeModal();
	}

	function handleDelete(id: string) {
		if (confirm('Are you sure you want to delete this event?')) {
			deleteCalendarEvent(id);
			closeModal();
		}
	}

	// Regenerate calendar whenever events/todos/month change
	$: {
		void $calendarEvents; // Force dependency tracking
		void $todos; // Force dependency tracking
		days = getDaysInMonth(currentMonth);
	}
	$: monthLabel = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
</script>

<div class="calendar-wrapper">
	<div class="calendar-container">
		<header class="calendar-header">
			<div class="header-left">
				<h1>Calendar</h1>
			</div>
			<div class="header-center">
				<button class="nav-btn" on:click={prevMonth}>&larr;</button>
				<h2 class="month-label">{monthLabel}</h2>
				<button class="nav-btn" on:click={nextMonth}>&rarr;</button>
			</div>
			<div class="header-right">
				<button class="today-btn" on:click={goToToday}>Today</button>
				<button class="add-btn" on:click={() => openAddModal()}>+ Add Event</button>
			</div>
		</header>

		<div class="calendar-grid">
		<div class="weekday-header">
			{#each ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as day}
				<div class="weekday">{day}</div>
			{/each}
		</div>

		<div class="days-grid">
			{#each days as day}
				{@const dayEvents = getEventsForDay(day)}
				{@const dayTasks = getTasksForDay(day)}
				{@const totalItems = dayEvents.length + dayTasks.length}
				<div
					class="day-cell"
					class:today={isToday(day)}
					class:other-month={!isCurrentMonth(day)}
					class:has-events={totalItems > 0}
					on:click={() => openDayModal(day)}
				>
					<span class="day-number">{day.getDate()}</span>
					<div class="day-events">
						{#each dayEvents.slice(0, 2) as event}
							<div
								class="event-pill"
								style="background-color: {event.color || '#5865f2'}"
								on:click|stopPropagation={() => openEditModal(event)}
							>
								{#if !event.allDay}
									<span class="event-time">{formatTime(event.startDate)}</span>
								{/if}
								<span class="event-title">{event.title}</span>
							</div>
						{/each}
						{#each dayTasks.slice(0, 2 - Math.min(dayEvents.length, 2)) as task}
							<div
								class="task-pill"
								style="border-left-color: {getPriorityColor(task.priority)}"
								on:click|stopPropagation={() => toggleTaskComplete(task)}
								title="Click to complete"
							>
								<span class="task-checkbox"></span>
								<span class="task-title">{task.title}</span>
							</div>
						{/each}
						{#if totalItems > 2}
							<div class="more-events">+{totalItems - 2} more</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
		</div>
	</div>

	<!-- Tasks Sidebar -->
	<aside class="tasks-sidebar">
		{#if overdueTasks.length > 0}
			<div class="sidebar-section overdue-section">
				<h3>Overdue</h3>
				<div class="task-list">
					{#each overdueTasks.slice(0, 5) as task}
						<div class="sidebar-task overdue" on:click={() => toggleTaskComplete(task)}>
							<span class="task-priority" style="background-color: {getPriorityColor(task.priority)}"></span>
							<div class="task-info">
								<span class="task-name">{task.title}</span>
								<span class="task-date">{new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
							</div>
							<span class="complete-btn" title="Mark complete">&#10003;</span>
						</div>
					{/each}
					{#if overdueTasks.length > 5}
						<div class="see-more">+{overdueTasks.length - 5} more overdue</div>
					{/if}
				</div>
			</div>
		{/if}

		<div class="sidebar-section">
			<h3>Upcoming Tasks</h3>
			{#if upcomingTasks.length === 0}
				<p class="empty-tasks">No upcoming tasks this week</p>
			{:else}
				<div class="task-list">
					{#each upcomingTasks as task}
						<div class="sidebar-task" on:click={() => toggleTaskComplete(task)}>
							<span class="task-priority" style="background-color: {getPriorityColor(task.priority)}"></span>
							<div class="task-info">
								<span class="task-name">{task.title}</span>
								<span class="task-date">
									{#if task.dueDate && new Date(task.dueDate).toDateString() === new Date().toDateString()}
										Today
									{:else if task.dueDate}
										{new Date(task.dueDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
									{/if}
								</span>
							</div>
							<span class="complete-btn" title="Mark complete">&#10003;</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</aside>
</div>

<!-- Event Modal -->
{#if showEventModal}
	<div class="modal-overlay" on:click|stopPropagation={closeModal}>
		<div class="modal" on:click|stopPropagation>
			<div class="modal-header">
				<h2>{editingEvent ? 'Edit Event' : 'Add New Event'}</h2>
				<button class="close-btn" on:click={closeModal}>&times;</button>
			</div>
			<form on:submit|preventDefault={handleSubmit}>
				<div class="form-group">
					<label for="title">Title *</label>
					<input
						id="title"
						type="text"
						bind:value={formTitle}
						placeholder="Event title"
						required
					/>
				</div>

				<div class="form-group">
					<label for="description">Description</label>
					<textarea
						id="description"
						bind:value={formDescription}
						placeholder="Add details..."
						rows="2"
					></textarea>
				</div>

				<div class="form-group">
					<label class="checkbox-label">
						<input type="checkbox" bind:checked={formAllDay} />
						All day event
					</label>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="startDate">Start Date *</label>
						<input id="startDate" type="date" bind:value={formStartDate} required />
					</div>
					{#if !formAllDay}
						<div class="form-group">
							<label for="startTime">Start Time</label>
							<input id="startTime" type="time" bind:value={formStartTime} />
						</div>
					{/if}
				</div>

				<div class="form-group">
					<label for="endDate">End Date (optional)</label>
					<input id="endDate" type="date" bind:value={formEndDate} />
				</div>

				<div class="form-group">
					<label>Color</label>
					<div class="color-picker">
						{#each colorOptions as color}
							<button
								type="button"
								class="color-option"
								class:selected={formColor === color}
								style="background-color: {color}"
								on:click={() => formColor = color}
							></button>
						{/each}
					</div>
				</div>

				<div class="form-actions">
					{#if editingEvent}
						<button type="button" class="delete-btn" on:click={() => handleDelete(editingEvent.id)}>
							Delete
						</button>
					{/if}
					<button type="button" class="cancel-btn" on:click={closeModal}>Cancel</button>
					<button type="submit" class="submit-btn">
						{editingEvent ? 'Save Changes' : 'Add Event'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Day Detail Modal -->
{#if showDayModal}
	{@const modalDayTasks = getTasksForDay(new Date($selectedDate))}
	<div class="modal-overlay" on:click|stopPropagation={closeModal}>
		<div class="modal day-modal" on:click|stopPropagation>
			<div class="modal-header">
				<h2>{new Date($selectedDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
				<button class="close-btn" on:click={closeModal}>&times;</button>
			</div>
			<div class="day-detail-content">
				{#if selectedDayEvents.length > 0}
					<div class="detail-section">
						<h4>Events</h4>
						<ul class="event-list">
							{#each selectedDayEvents as event}
								<li class="event-item" on:click={() => { closeModal(); openEditModal(event); }}>
									<div class="event-color" style="background-color: {event.color || '#5865f2'}"></div>
									<div class="event-details">
										<span class="event-title">{event.title}</span>
										{#if event.allDay}
											<span class="event-time">All day</span>
										{:else}
											<span class="event-time">{formatTime(event.startDate)}</span>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if modalDayTasks.length > 0}
					<div class="detail-section">
						<h4>Tasks Due</h4>
						<ul class="event-list">
							{#each modalDayTasks as task}
								<li class="event-item task-item" on:click={() => toggleTaskComplete(task)}>
									<div class="event-color" style="background-color: {getPriorityColor(task.priority)}"></div>
									<div class="event-details">
										<span class="event-title">{task.title}</span>
										<span class="event-time priority-{task.priority}">{task.priority}</span>
									</div>
									<span class="task-check" title="Mark complete">&#10003;</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if selectedDayEvents.length === 0 && modalDayTasks.length === 0}
					<p class="empty-message">No events or tasks scheduled</p>
				{/if}

				<button class="add-event-btn" on:click={() => { closeModal(); openAddModal(new Date($selectedDate)); }}>
					+ Add event for this day
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.calendar-wrapper {
		height: 100%;
		display: flex;
		gap: 1rem;
	}

	.calendar-container {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	/* Tasks Sidebar */
	.tasks-sidebar {
		width: 280px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.sidebar-section {
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 12px;
		padding: 1rem;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.sidebar-section h3 {
		margin: 0 0 0.75rem 0;
		font-size: 0.9rem;
		color: var(--biz-text-secondary, #94a3b8);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.overdue-section {
		border-color: var(--biz-danger, #ef4444);
		background: rgba(239, 68, 68, 0.1);
	}

	.overdue-section h3 {
		color: var(--biz-danger, #ef4444);
	}

	.task-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.sidebar-task {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.sidebar-task:hover {
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.sidebar-task:hover .complete-btn {
		opacity: 1;
	}

	.sidebar-task.overdue {
		background: rgba(239, 68, 68, 0.15);
	}

	.task-priority {
		width: 4px;
		height: 24px;
		border-radius: 2px;
		flex-shrink: 0;
	}

	.task-info {
		flex: 1;
		min-width: 0;
	}

	.task-name {
		display: block;
		font-size: 0.85rem;
		color: var(--biz-text-primary, #f1f5f9);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.task-date {
		font-size: 0.75rem;
		color: var(--biz-text-muted, #64748b);
	}

	.complete-btn {
		opacity: 0;
		color: var(--biz-success, #10b981);
		font-size: 1rem;
		transition: opacity 0.2s;
	}

	.empty-tasks {
		color: var(--biz-text-muted, #64748b);
		font-size: 0.85rem;
		text-align: center;
		padding: 1rem 0;
		margin: 0;
	}

	.see-more {
		font-size: 0.8rem;
		color: var(--biz-text-muted, #64748b);
		text-align: center;
		padding: 0.25rem;
	}

	.calendar-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
		flex-wrap: wrap;
		gap: 1rem;
	}

	.header-left h1 {
		margin: 0;
		font-size: 1.5rem;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.header-center {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.month-label {
		margin: 0;
		font-size: 1.25rem;
		min-width: 180px;
		text-align: center;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.nav-btn {
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		color: var(--biz-text-primary, #f1f5f9);
		padding: 0.5rem 0.75rem;
		border-radius: 8px;
		cursor: pointer;
		font-size: 1rem;
		transition: all 0.2s;
	}

	.nav-btn:hover {
		background: var(--biz-bg-hover, #2a3a4d);
		border-color: var(--biz-accent, #f59e0b);
	}

	.header-right {
		display: flex;
		gap: 0.75rem;
	}

	.today-btn {
		padding: 0.5rem 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		color: var(--biz-text-primary, #f1f5f9);
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.today-btn:hover {
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.add-btn {
		padding: 0.5rem 1rem;
		background: var(--biz-accent, #f59e0b);
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 500;
		transition: all 0.2s;
	}

	.add-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	/* Calendar Grid */
	.calendar-grid {
		flex: 1;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 12px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.weekday-header {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		background: var(--biz-bg-tertiary, #243044);
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
	}

	.weekday {
		padding: 0.75rem;
		text-align: center;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--biz-text-secondary, #94a3b8);
		text-transform: uppercase;
	}

	.days-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		flex: 1;
	}

	.day-cell {
		border-right: 1px solid var(--biz-border, #2d3a4d);
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		padding: 0.5rem;
		min-height: 100px;
		cursor: pointer;
		transition: background 0.2s;
		background: var(--biz-bg-secondary, #1a2332);
	}

	.day-cell:nth-child(7n) {
		border-right: none;
	}

	.day-cell:hover {
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.day-cell.today {
		background: var(--biz-accent-soft, rgba(245, 158, 11, 0.1));
	}

	.day-cell.today .day-number {
		background: var(--biz-accent, #f59e0b);
		color: white;
		border-radius: 50%;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.day-cell.other-month {
		opacity: 0.4;
		background: var(--biz-bg-primary, #0f1419);
	}

	.day-number {
		font-size: 0.9rem;
		font-weight: 500;
		margin-bottom: 0.25rem;
		display: inline-block;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.day-events {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.event-pill {
		font-size: 0.7rem;
		padding: 2px 6px;
		border-radius: 4px;
		color: white;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		display: flex;
		gap: 4px;
	}

	.event-pill:hover {
		filter: brightness(1.15);
	}

	.task-pill {
		font-size: 0.7rem;
		padding: 2px 6px;
		border-radius: 4px;
		background: var(--biz-bg-tertiary, #243044);
		border-left: 3px solid;
		color: var(--biz-text-primary, #f1f5f9);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.task-pill:hover {
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.task-checkbox {
		width: 10px;
		height: 10px;
		border: 1px solid var(--biz-text-muted, #64748b);
		border-radius: 2px;
		flex-shrink: 0;
	}

	.task-pill:hover .task-checkbox {
		border-color: var(--biz-success, #10b981);
		background: rgba(16, 185, 129, 0.2);
	}

	.task-title {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.event-time {
		opacity: 0.8;
	}

	.more-events {
		font-size: 0.7rem;
		color: var(--biz-text-muted, #64748b);
		padding: 2px 0;
	}

	/* Modals */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal {
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 12px;
		width: 100%;
		max-width: 450px;
		max-height: 90vh;
		overflow-y: auto;
		border: 1px solid var(--biz-border, #2d3a4d);
		box-shadow: var(--biz-shadow-lg, 0 10px 25px rgba(0, 0, 0, 0.4));
	}

	.day-modal {
		max-width: 400px;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 1.5rem;
		cursor: pointer;
		line-height: 1;
		transition: color 0.2s;
	}

	.close-btn:hover {
		color: var(--biz-text-primary, #f1f5f9);
	}

	form {
		padding: 1.25rem;
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-group label {
		display: block;
		font-size: 0.85rem;
		margin-bottom: 0.35rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.checkbox-label {
		display: flex !important;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.checkbox-label input {
		width: auto;
		accent-color: var(--biz-accent, #f59e0b);
	}

	.form-group input,
	.form-group textarea {
		width: 100%;
		padding: 0.6rem 0.75rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
	}

	.form-group input:focus,
	.form-group textarea:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.color-picker {
		display: flex;
		gap: 0.5rem;
	}

	.color-option {
		width: 28px;
		height: 28px;
		min-width: 28px;
		min-height: 28px;
		border-radius: 50% !important;
		border: 2px solid transparent;
		cursor: pointer;
		transition: all 0.2s;
		padding: 0;
		/* Reset global button styles - let inline style control background */
		background: transparent;
	}

	.color-option:hover {
		transform: scale(1.1);
	}

	.color-option.selected {
		border-color: white;
		box-shadow: 0 0 0 2px var(--biz-bg-tertiary, #243044);
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}

	.delete-btn {
		padding: 0.6rem 1rem;
		background: var(--biz-danger, #ef4444);
		border: none;
		border-radius: 8px;
		color: white;
		cursor: pointer;
		margin-right: auto;
		transition: background 0.2s;
	}

	.delete-btn:hover {
		background: #dc2626;
	}

	.cancel-btn {
		padding: 0.6rem 1rem;
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
	}

	.cancel-btn:hover {
		background: var(--biz-bg-tertiary, #243044);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.submit-btn {
		padding: 0.6rem 1.25rem;
		background: var(--biz-accent, #f59e0b);
		border: none;
		border-radius: 8px;
		color: white;
		cursor: pointer;
		font-weight: 500;
		transition: background 0.2s;
	}

	.submit-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	/* Day Detail Modal */
	.day-detail-content {
		padding: 1rem;
	}

	.empty-message {
		text-align: center;
		color: var(--biz-text-muted, #64748b);
		padding: 1rem 0;
	}

	.event-list {
		list-style: none;
		padding: 0;
		margin: 0 0 1rem 0;
	}

	.event-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		margin-bottom: 0.5rem;
		cursor: pointer;
		transition: background 0.2s;
	}

	.event-item:hover {
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.event-color {
		width: 4px;
		height: 100%;
		min-height: 32px;
		border-radius: 2px;
	}

	.event-details {
		flex: 1;
	}

	.event-details .event-title {
		display: block;
		font-weight: 500;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.event-details .event-time {
		font-size: 0.8rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.add-event-btn {
		width: 100%;
		padding: 0.75rem;
		background: transparent;
		border: 1px dashed var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
	}

	.add-event-btn:hover {
		background: var(--biz-bg-tertiary, #243044);
		color: var(--biz-accent, #f59e0b);
		border-color: var(--biz-accent, #f59e0b);
	}

	/* Day Detail Modal Sections */
	.detail-section {
		margin-bottom: 1rem;
	}

	.detail-section h4 {
		margin: 0 0 0.5rem 0;
		font-size: 0.8rem;
		color: var(--biz-text-muted, #64748b);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.task-item {
		position: relative;
	}

	.task-check {
		color: var(--biz-success, #10b981);
		font-size: 1rem;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.task-item:hover .task-check {
		opacity: 1;
	}

	.priority-urgent {
		color: #ef4444 !important;
	}

	.priority-high {
		color: #f97316 !important;
	}

	.priority-medium {
		color: #eab308 !important;
	}

	.priority-low {
		color: #22c55e !important;
	}

	@media (max-width: 1024px) {
		.tasks-sidebar {
			width: 240px;
		}
	}

	@media (max-width: 900px) {
		.calendar-wrapper {
			flex-direction: column;
		}

		.tasks-sidebar {
			width: 100%;
			flex-direction: row;
			overflow-x: auto;
		}

		.sidebar-section {
			min-width: 280px;
		}
	}

	@media (max-width: 768px) {
		.calendar-header {
			flex-direction: column;
			align-items: stretch;
		}

		.header-center {
			justify-content: center;
		}

		.header-right {
			justify-content: center;
		}

		.day-cell {
			min-height: 60px;
			padding: 0.25rem;
		}

		.event-pill {
			font-size: 0.6rem;
		}
	}
</style>
