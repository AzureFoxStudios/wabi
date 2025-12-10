<script lang="ts">
	import {
		calendarEvents,
		selectedDate,
		addCalendarEvent,
		updateCalendarEvent,
		deleteCalendarEvent
	} from '$lib/business/store';
	import type { CalendarEvent } from '$lib/business/types';

	// Current view state
	let currentMonth = new Date();
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

		return $calendarEvents.filter(event => {
			const eventStart = new Date(event.startDate);
			const eventEnd = event.endDate ? new Date(event.endDate) : eventStart;
			return (
				(eventStart >= dayStart && eventStart <= dayEnd) ||
				(eventEnd >= dayStart && eventEnd <= dayEnd) ||
				(eventStart <= dayStart && eventEnd >= dayEnd)
			);
		}).sort((a, b) => a.startDate - b.startDate);
	}

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
		return date.toISOString().split('T')[0];
	}

	function formatTimeForInput(date: Date): string {
		return date.toTimeString().slice(0, 5);
	}

	// Modal handlers
	function openAddModal(date?: Date) {
		resetForm();
		if (date) {
			formStartDate = formatDateForInput(date);
		}
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
		selectedDayEvents = getEventsForDay(date);
		showDayModal = true;
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

	$: days = getDaysInMonth(currentMonth);
	$: monthLabel = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
</script>

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
				<div
					class="day-cell"
					class:today={isToday(day)}
					class:other-month={!isCurrentMonth(day)}
					class:has-events={dayEvents.length > 0}
					on:click={() => openDayModal(day)}
				>
					<span class="day-number">{day.getDate()}</span>
					<div class="day-events">
						{#each dayEvents.slice(0, 3) as event}
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
						{#if dayEvents.length > 3}
							<div class="more-events">+{dayEvents.length - 3} more</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
</div>

<!-- Event Modal -->
{#if showEventModal}
	<div class="modal-overlay" on:click={closeModal}>
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
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal day-modal" on:click|stopPropagation>
			<div class="modal-header">
				<h2>{new Date($selectedDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
				<button class="close-btn" on:click={closeModal}>&times;</button>
			</div>
			<div class="day-detail-content">
				{#if selectedDayEvents.length === 0}
					<p class="empty-message">No events scheduled</p>
				{:else}
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
				{/if}
				<button class="add-event-btn" on:click={() => { closeModal(); openAddModal(new Date($selectedDate)); }}>
					+ Add event for this day
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.calendar-container {
		height: 100%;
		display: flex;
		flex-direction: column;
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
	}

	.nav-btn {
		background: var(--bg-secondary, #16213e);
		border: 1px solid var(--border-color, #2a2a4a);
		color: var(--text-primary, #eee);
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 1rem;
		transition: all 0.2s;
	}

	.nav-btn:hover {
		background: var(--bg-tertiary, #1f2937);
	}

	.header-right {
		display: flex;
		gap: 0.75rem;
	}

	.today-btn {
		padding: 0.5rem 1rem;
		background: var(--bg-secondary, #16213e);
		border: 1px solid var(--border-color, #2a2a4a);
		color: var(--text-primary, #eee);
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.today-btn:hover {
		background: var(--bg-tertiary, #1f2937);
	}

	.add-btn {
		padding: 0.5rem 1rem;
		background: var(--accent, #5865f2);
		color: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-weight: 500;
		transition: all 0.2s;
	}

	.add-btn:hover {
		background: #4752c4;
	}

	/* Calendar Grid */
	.calendar-grid {
		flex: 1;
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.weekday-header {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		background: var(--bg-tertiary, #1f2937);
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.weekday {
		padding: 0.75rem;
		text-align: center;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary, #888);
		text-transform: uppercase;
	}

	.days-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		flex: 1;
	}

	.day-cell {
		border-right: 1px solid var(--border-color, #2a2a4a);
		border-bottom: 1px solid var(--border-color, #2a2a4a);
		padding: 0.5rem;
		min-height: 100px;
		cursor: pointer;
		transition: background 0.2s;
	}

	.day-cell:nth-child(7n) {
		border-right: none;
	}

	.day-cell:hover {
		background: var(--bg-tertiary, #1f2937);
	}

	.day-cell.today {
		background: rgba(88, 101, 242, 0.1);
	}

	.day-cell.today .day-number {
		background: var(--accent, #5865f2);
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
	}

	.day-number {
		font-size: 0.9rem;
		font-weight: 500;
		margin-bottom: 0.25rem;
		display: inline-block;
	}

	.day-events {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.event-pill {
		font-size: 0.7rem;
		padding: 2px 4px;
		border-radius: 3px;
		color: white;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		display: flex;
		gap: 4px;
	}

	.event-pill:hover {
		filter: brightness(1.1);
	}

	.event-time {
		opacity: 0.8;
	}

	.more-events {
		font-size: 0.7rem;
		color: var(--text-secondary, #888);
		padding: 2px 0;
	}

	/* Modals */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		width: 100%;
		max-width: 450px;
		max-height: 90vh;
		overflow-y: auto;
	}

	.day-modal {
		max-width: 400px;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary, #888);
		font-size: 1.5rem;
		cursor: pointer;
		line-height: 1;
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
		color: var(--text-secondary, #aaa);
	}

	.checkbox-label {
		display: flex !important;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.checkbox-label input {
		width: auto;
	}

	.form-group input,
	.form-group textarea {
		width: 100%;
		padding: 0.6rem 0.75rem;
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-primary, #eee);
		font-size: 0.9rem;
	}

	.form-group input:focus,
	.form-group textarea:focus {
		outline: none;
		border-color: var(--accent, #5865f2);
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
		border-radius: 50%;
		border: 2px solid transparent;
		cursor: pointer;
		transition: all 0.2s;
	}

	.color-option:hover {
		transform: scale(1.1);
	}

	.color-option.selected {
		border-color: white;
		box-shadow: 0 0 0 2px var(--bg-tertiary, #1f2937);
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}

	.delete-btn {
		padding: 0.6rem 1rem;
		background: #ef4444;
		border: none;
		border-radius: 6px;
		color: white;
		cursor: pointer;
		margin-right: auto;
	}

	.delete-btn:hover {
		background: #dc2626;
	}

	.cancel-btn {
		padding: 0.6rem 1rem;
		background: transparent;
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
	}

	.cancel-btn:hover {
		background: var(--bg-tertiary, #1f2937);
	}

	.submit-btn {
		padding: 0.6rem 1.25rem;
		background: var(--accent, #5865f2);
		border: none;
		border-radius: 6px;
		color: white;
		cursor: pointer;
		font-weight: 500;
	}

	.submit-btn:hover {
		background: #4752c4;
	}

	/* Day Detail Modal */
	.day-detail-content {
		padding: 1rem;
	}

	.empty-message {
		text-align: center;
		color: var(--text-secondary, #888);
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
		background: var(--bg-tertiary, #1f2937);
		border-radius: 8px;
		margin-bottom: 0.5rem;
		cursor: pointer;
		transition: background 0.2s;
	}

	.event-item:hover {
		background: var(--bg-hover, #2a3441);
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
	}

	.event-details .event-time {
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
	}

	.add-event-btn {
		width: 100%;
		padding: 0.75rem;
		background: transparent;
		border: 1px dashed var(--border-color, #2a2a4a);
		border-radius: 8px;
		color: var(--text-secondary, #888);
		cursor: pointer;
		transition: all 0.2s;
	}

	.add-event-btn:hover {
		background: var(--bg-tertiary, #1f2937);
		color: var(--text-primary, #eee);
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
