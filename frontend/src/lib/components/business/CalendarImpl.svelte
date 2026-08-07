<script lang="ts">
	import { get } from 'svelte/store';
	import { currentUser } from '$lib/socket';
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
	import CalendarDayModal from './CalendarDayModal.svelte';
	import CalendarEventModal from './CalendarEventModal.svelte';

	// Props
	export let isReadOnly = false;
	export let embedded = false;
	export let addSignal = 0;

	// Current view state
	let currentMonth = new Date();
	let days: Date[] = [];
	let showEventModal = false;
	let editingEvent: CalendarEvent | null = null;
	let selectedDayEvents: CalendarEvent[] = [];
	let showDayModal = false;
	let lastAddSignal = 0;

	// Host "New ▾ → event" trigger
	$: if (addSignal > lastAddSignal) {
		lastAddSignal = addSignal;
		openAddModal();
	}

	// Form state
	let formTitle = '';
	let formDescription = '';
	let formStartDate = '';
	let formStartTime = '';
	let formEndDate = '';
	let formAllDay = false;
	let formColor = '#5865f2';
	let formRecurring = false;
	let formRecurringFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly' = 'weekly';
	let formRecurringInterval = 1;
	let formRecurringEndDate = '';
	let willSign = false;

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
		// Updated to use CSS variable values for consistency with theme system
		switch (priority) {
			case 'urgent': return 'var(--priority-urgent)';
			case 'high': return 'var(--priority-high)';
			case 'medium': return 'var(--priority-medium)';
			case 'low': return 'var(--priority-low)';
			default: return 'var(--biz-text-muted, #64748b)';
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
		formRecurring = !!event.recurring;
		formRecurringFrequency = event.recurring?.frequency || 'weekly';
		formRecurringInterval = event.recurring?.interval || 1;
		formRecurringEndDate = event.recurring?.endDate ? formatDateForInput(new Date(event.recurring.endDate)) : '';
		willSign = !!event.signedBy;
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
		formRecurring = false;
		formRecurringFrequency = 'weekly';
		formRecurringInterval = 1;
		formRecurringEndDate = '';
		willSign = false;
		editingEvent = null;
	}

	function handleSubmit() {
		if (!formTitle.trim() || !formStartDate) return;

		const startDate = new Date(formStartDate);
		if (!formAllDay && formStartTime) {
			const [hours, minutes] = formStartTime.split(':');
			startDate.setHours(parseInt(hours), parseInt(minutes));
		}

		const eventData: any = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			startDate: startDate.getTime(),
			endDate: formEndDate ? new Date(formEndDate).getTime() : undefined,
			allDay: formAllDay,
			color: formColor,
			createdBy: $currentUser?.id || 'unknown',
			signedBy: willSign ? ($currentUser?.username || 'Guest') : undefined
		};

		// Add recurring data if enabled
		if (formRecurring) {
			eventData.recurring = {
				frequency: formRecurringFrequency,
				interval: formRecurringInterval,
				endDate: formRecurringEndDate ? new Date(formRecurringEndDate).getTime() : undefined
			};
		}

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
		<header class="calendar-header" class:embedded={embedded}>
			{#if !embedded}
				<div class="header-left">
					<h1>Calendar</h1>
				</div>
			{/if}
			<div class="header-center">
				<button class="nav-btn icon" aria-label="Previous month" on:click={prevMonth}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="15 18 9 12 15 6"/>
					</svg>
				</button>
				<h2 class="month-label">{monthLabel}</h2>
				<button class="nav-btn icon" aria-label="Next month" on:click={nextMonth}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="9 18 15 12 9 6"/>
					</svg>
				</button>
			</div>
			<div class="header-right">
				<button class="today-btn" on:click={goToToday}>Today</button>
				<button class="add-btn" on:click={() => openAddModal()} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add new event'}>+ Add Event</button>
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
				{@const visibleEvents = dayEvents.slice(0, 3)}
				{@const visibleTasks = dayTasks.slice(0, Math.max(0, 3 - dayEvents.length))}
				{@const hiddenCount = totalItems - visibleEvents.length - visibleTasks.length}
				<div
					class="day-cell"
					class:today={isToday(day)}
					class:other-month={!isCurrentMonth(day)}
					class:has-events={totalItems > 0}
					role="button"
					tabindex="0"
					on:click={() => openDayModal(day)}
					on:keydown={(keyboardEvent) => {
						if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
							keyboardEvent.preventDefault();
							openDayModal(day);
						}
					}}
				>
					<span class="day-number">{day.getDate()}</span>
					<div class="day-events">
						{#each visibleEvents as event}
							<button
								type="button"
								class="event-pill"
								style="background-color: {event.color || '#5865f2'}"
								aria-label={`Edit event ${event.title}`}
								on:click|stopPropagation={() => openEditModal(event)}
							>
								{#if !event.allDay}
									<span class="event-time">{formatTime(event.startDate)}</span>
								{/if}
								<span class="event-title">{event.title}</span>
							</button>
						{/each}
						{#each visibleTasks as task}
							<button
								type="button"
								class="task-pill"
								style="border-left-color: {getPriorityColor(task.priority)}"
								aria-label={`Mark task ${task.title} complete`}
								on:click|stopPropagation={() => toggleTaskComplete(task)}
								title="Click to complete"
							>
								<span class="task-checkbox"></span>
								<span class="task-title">{task.title}</span>
							</button>
						{/each}
						{#if hiddenCount > 0}
							<div class="more-events">+{hiddenCount} more</div>
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
						<div
							class="sidebar-task overdue"
							role="button"
							tabindex="0"
							on:click={() => toggleTaskComplete(task)}
							on:keydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									toggleTaskComplete(task);
								}
							}}
						>
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
						<div
							class="sidebar-task"
							role="button"
							tabindex="0"
							on:click={() => toggleTaskComplete(task)}
							on:keydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									toggleTaskComplete(task);
								}
							}}
						>
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
	<CalendarEventModal
		{editingEvent}
		bind:formTitle
		bind:formDescription
		bind:formStartDate
		bind:formStartTime
		bind:formEndDate
		bind:formAllDay
		bind:formColor
		bind:formRecurring
		bind:formRecurringFrequency
		bind:formRecurringInterval
		bind:formRecurringEndDate
		bind:willSign
		{colorOptions}
		{handleSubmit}
		{handleDelete}
		{closeModal}
	/>
{/if}

<!-- Day Detail Modal -->
{#if showDayModal}
	<CalendarDayModal
		{selectedDayEvents}
		modalDayTasks={getTasksForDay(new Date($selectedDate))}
		{isReadOnly}
		{formatTime}
		{getPriorityColor}
		{openEditModal}
		{toggleTaskComplete}
		{closeModal}
		{openAddModal}
	/>
{/if}
