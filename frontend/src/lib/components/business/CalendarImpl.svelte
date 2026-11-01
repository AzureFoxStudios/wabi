<script lang="ts">
	/**
	 * My Planner calendar (design contract §8.6). A quiet month grid on the page: mono weekday
	 * kickers, today as an accent disc, events as tinted pills that never clip (overflow becomes
	 * "+N more"), tasks with their own checkbox (the title opens the task, it never completes it).
	 * Titles take up to two lines; how many lines a day shows is measured from the cell's height
	 * (calendarFit.ts), never a fixed count, and "+N more" sits in the day's head row beside the
	 * date so the lines keep the cell's height. Day cells are gridcells, not buttons: each has a
	 * separate "Add on <date>" button, and a click on the day itself (or Enter) opens the day.
	 * Below a 720px stage the month becomes an agenda list.
	 *
	 * The side list (Overdue, Upcoming) sits beside the month only while every day column keeps
	 * 140px (a container query in calendar-view-part1.css); otherwise, and while a Tasks list is
	 * on screen, it steps aside and the head says "1 overdue · 7 due this week", each opening the
	 * Tasks companion on that filter.
	 *
	 * Keyboard: the grid is one tab stop; arrows move a day or a week, Home/End to the week's
	 * ends, PageUp/PageDown by a month, Enter opens the day. Tab moves into the day's controls.
	 */
	import { onMount, tick } from 'svelte';
	import { plannerActor as currentUser } from '$lib/business/personalWorkspace';
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
	import PlannerTaskDialog from './PlannerTaskDialog.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { ensurePlannerDirectory } from '$lib/business/plannerUsers';
	import { showToast, toast } from '$lib/toast';
	import { confirmAction } from '$lib/confirm';
	import { occurrencesForRange } from '$lib/business/calendarOccurrences';
	import { buildCalendarEventData } from '$lib/business/calendarForm';
	import { dateWords } from '$lib/business/plannerBoard';
	import { openPlannerTasksPanel, tasksListShown } from '$lib/business/plannerTasksPanel';
	import { fitDayLines } from './calendarFit';
	import {
		AGENDA_BELOW,
		SIDE_LIST_ROWS,
		agendaDays,
		completeTask,
		dayKey,
		eventTint,
		isGridKey,
		monthWeeks,
		moveDay,
		overdueTasks as overdueOf,
		sameDay,
		tasksByDay as groupTasksByDay,
		upcomingTasks as upcomingOf
	} from '$lib/business/plannerCalendar';

	// Props
	export let isReadOnly = false;
	export let embedded = false;
	export let addSignal = 0;

	const uid = Math.random().toString(36).slice(2, 8);
	const titleId = `planner-cal-title-${uid}`;

	// Current view state
	let currentMonth = new Date();
	let showEventModal = false;
	let editingEvent: CalendarEvent | null = null;
	let selectedDayEvents: CalendarEvent[] = [];
	let showDayModal = false;
	let lastAddSignal = 0;
	/** The task open in the task dialog (a title was pressed). */
	let openTodo: Todo | null = null;
	/** The roving day of the grid (one tab stop): the key of the day that takes focus. */
	let activeDay = new Date();
	let gridEl: HTMLElement | null = null;
	let width = 0;
	let now = Date.now();

	onMount(() => {
		// Shared one-shot user directory for assignee names.
		ensurePlannerDirectory();
		// "Today" moves on at midnight without a reload.
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

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
	// Event colours are the person's choice (user data); the palette lives in the event dialog.
	let formColor = '#5865f2';
	let formRecurring = false;
	let formRecurringFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly' = 'weekly';
	let formRecurringInterval = 1;
	let formRecurringEndDate = '';
	/** Draft sign-offs for the open event modal (multi-sign). */
	let draftSignatures: CalendarEvent['signatures'] = [];
	/** Legacy signer name of the event being edited (read-only display). */
	let legacySignedBy: string | undefined = undefined;

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


	// ── the month ──
	$: weeks = monthWeeks(currentMonth);
	$: monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(currentMonth);
	$: today = new Date(now);
	$: showingThisMonth = currentMonth.getFullYear() === today.getFullYear() && currentMonth.getMonth() === today.getMonth();
	$: agenda = width > 0 && width < AGENDA_BELOW;
	$: weekdays = weeks[0].map((day) => ({
		short: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day),
		long: new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(day)
	}));

	/** Events by day over the visible weeks (occurrences of repeating events included). */
	$: eventsByDay = (() => {
		const map = new Map<string, CalendarEvent[]>();
		const first = weeks[0][0];
		const lastWeek = weeks[weeks.length - 1];
		const last = lastWeek[lastWeek.length - 1];
		for (const event of $calendarEvents) {
			for (const occurrence of occurrencesForRange(event, first, last)) {
				const start = new Date(occurrence.start);
				const end = new Date(occurrence.end);
				const cursor = new Date(Math.max(first.getTime(), new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()));
				const endDay = new Date(Math.min(last.getTime(), new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime()));
				const displayed = { ...event, startDate: occurrence.start, endDate: occurrence.end };
				while (cursor <= endDay) {
					const key = dayKey(cursor);
					const list = map.get(key);
					if (list) list.push(displayed);
					else map.set(key, [displayed]);
					cursor.setDate(cursor.getDate() + 1);
				}
			}
		}
		for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startDate - b.startDate);
		return map;
	})();
	$: taskMap = groupTasksByDay($todos);

	function eventsOn(date: Date, map: Map<string, CalendarEvent[]>): CalendarEvent[] {
		return map.get(dayKey(date)) ?? [];
	}
	function tasksOn(date: Date, map: Map<string, Todo[]>): Todo[] {
		return map.get(dayKey(date)) ?? [];
	}

	$: overdue = overdueOf($todos, now);
	$: upcoming = upcomingOf($todos, now);
	$: agendaList = agenda ? agendaDays(currentMonth, eventsByDay, taskMap, now) : [];
	// The side list steps aside while a Tasks list (the companion, or the Planner's in-surface
	// split) shows the same tasks beside the page; the CSS also hides it when the month is narrow.
	$: showAside = !agenda && !$tasksListShown;
	// The head's counts stand in for the side list whenever it is not beside the month.
	$: showSummary = !$tasksListShown && (overdue.length > 0 || upcoming.length > 0);

	/** Lines behind each day's "+N more", as measured by fitDayLines. */
	let hiddenByDay: Record<string, number> = {};
	function onFit(key: string, hidden: number): void {
		if ((hiddenByDay[key] ?? 0) !== hidden) hiddenByDay = { ...hiddenByDay, [key]: hidden };
	}

	// The roving day stays inside the month on screen.
	$: if (activeDay.getMonth() !== currentMonth.getMonth() || activeDay.getFullYear() !== currentMonth.getFullYear()) {
		activeDay = showingThisMonth ? new Date(now) : new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
	}
	$: activeKey = dayKey(activeDay);

	// ── words ──
	const fullDateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
	const dayMonthFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' });
	const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
	const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

	function formatTime(timestamp: number): string {
		return timeFormat.format(new Date(timestamp));
	}
	/** The short time a day cell shows: "7 PM" on the hour, "7:30 PM" otherwise (19 / 19:30 in 24-hour locales). */
	function shortTime(timestamp: number): string {
		const d = new Date(timestamp);
		return d.getMinutes() === 0 ? hourFormat.format(d) : timeFormat.format(d);
	}
	function plural(count: number, one: string, many: string): string {
		return `${count} ${count === 1 ? one : many}`;
	}
	/** "Tuesday 22 September, 2 events, 1 task due" (the cell's name for assistive tech). */
	function cellLabel(day: Date, events: number, tasks: number): string {
		const parts = [fullDateFormat.format(day)];
		if (sameDay(day, today)) parts[0] = `Today, ${parts[0]}`;
		if (events) parts.push(plural(events, 'event', 'events'));
		if (tasks) parts.push(`${plural(tasks, 'task', 'tasks')} due`);
		return parts.join(', ');
	}
	/** The day words a person reads in an agenda heading: "Today", "Tomorrow", or the date. */
	function relativeWord(day: Date): string | null {
		const words = dateWords(day.getTime(), now);
		return words === 'Today' || words === 'Tomorrow' || words === 'Yesterday' ? words : null;
	}

	// ── moves ──
	function prevMonth() {
		currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
	}
	function nextMonth() {
		currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
	}
	function goToToday() {
		currentMonth = new Date(now);
		activeDay = new Date(now);
	}

	async function focusDay(day: Date) {
		if (day.getMonth() !== currentMonth.getMonth() || day.getFullYear() !== currentMonth.getFullYear()) {
			currentMonth = new Date(day.getFullYear(), day.getMonth(), 1);
		}
		activeDay = day;
		await tick();
		gridEl?.querySelector<HTMLElement>(`[data-day="${dayKey(day)}"]`)?.focus();
	}

	/** Keys on a day cell itself (not on the controls inside it). */
	function onCellKey(event: KeyboardEvent, day: Date) {
		if (event.target !== event.currentTarget) return;
		if (isGridKey(event.key)) {
			event.preventDefault();
			void focusDay(moveDay(day, event.key));
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			openDayModal(day);
		}
	}

	/** A control inside a day (clicked or tabbed to) makes that day the grid's tab stop. */
	function onCellFocus(day: Date) {
		if (dayKey(day) !== activeKey) activeDay = day;
	}

	/** A click on the day itself (not on one of its controls) opens the day, as Enter does. */
	function onCellClick(event: MouseEvent, day: Date) {
		const target = event.target as Element | null;
		if (target?.closest('button, input, label, a')) return;
		openDayModal(day);
	}

	// ── tasks ──
	function openTask(todo: Todo) {
		openTodo = todo;
	}

	/** The checkbox is the only thing that completes a task, and Undo puts it back. */
	function complete(todo: Todo) {
		if (isReadOnly) return;
		const { patch, undo } = completeTask(todo);
		updateTodo(todo.id, patch);
		toast(`Marked “${todo.title}” done`, {
			action: 'Undo',
			onAction: () => updateTodo(todo.id, { status: undo.status, completedAt: undo.completedAt })
		});
	}

	function priorityColor(priority: string): string {
		switch (priority) {
			case 'urgent':
				return 'var(--w-danger)';
			case 'high':
				return 'var(--w-warn)';
			default:
				return 'var(--w-line-strong)';
		}
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

	function openEditModal(displayed: CalendarEvent) {
		// Occurrence clicks edit the original series, never replace its starting date.
		const event = $calendarEvents.find(item => item.id === displayed.id);
		if (!event) return;
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
		draftSignatures = event.signatures ? [...event.signatures] : [];
		legacySignedBy = event.signatures?.length ? undefined : event.signedBy;
		showEventModal = true;
	}

	function openDayModal(date: Date) {
		selectedDate.set(date.getTime());
		showDayModal = true;
	}

	/** The day dialog's task rows open the task too (never complete it): close the day, open the task. */
	function openTaskFromDay(todo: Todo) {
		showDayModal = false;
		openTask(todo);
	}

	// The day dialog follows the events store while it is open.
	$: if (showDayModal) selectedDayEvents = eventsOn(new Date($selectedDate), eventsByDay);

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
		draftSignatures = [];
		legacySignedBy = undefined;
		editingEvent = null;
	}

	function handleSubmit() {
		if (!formTitle.trim() || !formStartDate) {
			showToast('Title and start date are required', 'error');
			return;
		}

		const { eventData, errors } = buildCalendarEventData({
			formTitle,
			formDescription,
			formStartDate,
			formStartTime,
			formEndDate,
			formAllDay,
			formColor,
			formRecurring,
			formRecurringFrequency,
			formRecurringInterval,
			formRecurringEndDate,
			draftSignatures,
			currentUserId: $currentUser?.id || 'unknown'
		});

		if (!eventData) {
			showToast(errors[0], 'error');
			return;
		}

		if (editingEvent) {
			updateCalendarEvent(editingEvent.id, eventData);
		} else {
			addCalendarEvent(eventData);
		}

		closeModal();
	}

	async function handleDelete(id: string) {
		const event = $calendarEvents.find((item) => item.id === id);
		const confirmed = await confirmAction({
			title: 'Delete this event?',
			body: event?.recurring
				? `“${event.title}” and every time it repeats will be removed from your Planner.`
				: `“${event?.title ?? 'This event'}” will be removed from your Planner.`,
			confirm: 'Delete event',
			danger: true
		});
		if (!confirmed) return;
		deleteCalendarEvent(id);
		closeModal();
	}

</script>

{#snippet taskLine(task: Todo, inCell: boolean, active: boolean)}
	<!-- The checkbox completes (with Undo); the title opens the task. Never one control for both.
	     The label is the checkbox's hit area (§7.7), kept clear of the title. -->
	<label class="cal-task__hit">
		<input
			type="checkbox"
			class="w-check cal-task__check"
			aria-label={`Mark “${task.title}” done`}
			checked={false}
			disabled={isReadOnly}
			tabindex={inCell && !active ? -1 : 0}
			on:change={() => complete(task)}
		/>
	</label>
	<button type="button" class="cal-task__title" tabindex={inCell && !active ? -1 : 0} on:click={() => openTask(task)}>
		<span class="cal-task__text">{task.title}</span>
	</button>
{/snippet}

{#snippet eventPill(event: CalendarEvent, inCell: boolean, active: boolean)}
	<button
		type="button"
		class="cal-pill"
		style:--pill={eventTint(event)}
		tabindex={inCell && !active ? -1 : 0}
		aria-label={`${event.title}, ${event.allDay ? 'all day' : formatTime(event.startDate)}. Edit event`}
		on:click={() => openEditModal(event)}
	>
		<span class="cal-pill__dot" aria-hidden="true"></span>
		<span class="cal-pill__text">
			{#if !event.allDay}<span class="cal-pill__time">{inCell ? shortTime(event.startDate) : formatTime(event.startDate)}</span>{' '}{/if}<span class="cal-pill__title">{event.title}</span>
		</span>
	</button>
{/snippet}

<div class="cal" class:cal--embedded={embedded} class:cal--agenda={agenda} class:cal--aside={showAside} bind:clientWidth={width}>
	<header class="cal-head">
		<div class="cal-steps">
			<Tooltip text="Previous month">
				<button type="button" class="w-ibtn" aria-label="Previous month" on:click={prevMonth}><Icon name="chevLeft" /></button>
			</Tooltip>
			<Tooltip text="Next month">
				<button type="button" class="w-ibtn" aria-label="Next month" on:click={nextMonth}><Icon name="chevRight" /></button>
			</Tooltip>
		</div>
		<h2 class="cal-title" id={titleId} aria-live="polite">{monthLabel}</h2>
		{#if showSummary}
			<!-- Stands in for the side list when it is not beside the month: each count opens the
			     Tasks companion on that filter (center stage keeps the month). -->
			<div class="cal-sum" role="group" aria-label="Tasks with a due date">
				{#if overdue.length > 0}
					<Tooltip text="Show overdue tasks in the Tasks panel">
						<button type="button" class="cal-sum__item cal-sum__item--danger" on:click={() => openPlannerTasksPanel('overdue')}>
							<b>{overdue.length}</b> overdue
						</button>
					</Tooltip>
				{/if}
				{#if overdue.length > 0 && upcoming.length > 0}<span class="cal-sum__sep" aria-hidden="true">·</span>{/if}
				{#if upcoming.length > 0}
					<Tooltip text="Show this week’s tasks in the Tasks panel">
						<button type="button" class="cal-sum__item" on:click={() => openPlannerTasksPanel('week')}>
							<b>{upcoming.length}</b> due this week
						</button>
					</Tooltip>
				{/if}
			</div>
		{/if}
		<div class="cal-head__end">
			<button type="button" class="w-btn w-btn--sm" on:click={goToToday}>Today</button>
			{#if !embedded}
				<button type="button" class="w-btn w-btn--sm w-btn--primary" on:click={() => openAddModal()} disabled={isReadOnly} title={isReadOnly ? 'Read-only: events cannot be added here' : undefined}>
					<Icon name="plus" size={16} />Add event
				</button>
			{/if}
		</div>
	</header>

	<div class="cal-body" class:cal-body--aside={showAside}>
		{#if agenda}
			<!-- Narrow stage: the month as a list of the days that have something on them. -->
			<section class="cal-agenda" aria-labelledby={titleId}>
				{#if agendaList.length === 0}
					<EmptyState
						icon="calendar"
						as="h3"
						title={`Nothing planned in ${new Intl.DateTimeFormat(undefined, { month: 'long' }).format(currentMonth)}`}
						text="Events and tasks with a date in this month show up here."
						action={isReadOnly ? undefined : 'Add event'}
						onaction={() => openAddModal(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1))}
					/>
				{:else}
					{#each agendaList as day (dayKey(day.date))}
						{@const word = relativeWord(day.date)}
						<section class="cal-agenda__day" aria-label={fullDateFormat.format(day.date)}>
							<div class="cal-agenda__head">
								<h3 class="cal-agenda__date">{#if word}<strong>{word}</strong>{' · '}{/if}{fullDateFormat.format(day.date)}</h3>
								{#if !isReadOnly}
									<Tooltip text={`Add on ${dayMonthFormat.format(day.date)}`}>
										<button type="button" class="w-ibtn w-ibtn--sm" aria-label={`Add on ${dayMonthFormat.format(day.date)}`} on:click={() => openAddModal(day.date)}>
											<Icon name="plus" size={16} />
										</button>
									</Tooltip>
								{/if}
							</div>
							{#if day.events.length === 0 && day.tasks.length === 0}
								<p class="cal-agenda__none">Nothing planned yet.</p>
							{:else}
								<ul class="cal-agenda__list">
									{#each day.events as event (`${event.id}-${event.startDate}`)}
										<li class="cal-agenda__row">{@render eventPill(event, false, true)}</li>
									{/each}
									{#each day.tasks as task (task.id)}
										<li class="cal-agenda__row cal-task">{@render taskLine(task, false, true)}</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/each}
				{/if}
			</section>
		{:else}
			<div class="cal-grid" role="grid" aria-labelledby={titleId} bind:this={gridEl}>
				<div class="cal-row cal-row--head" role="row">
					{#each weekdays as weekday}
						<div class="cal-weekday" role="columnheader" aria-label={weekday.long}>{weekday.short}</div>
					{/each}
				</div>
				{#each weeks as week (dayKey(week[0]))}
					<div class="cal-row" role="row">
						{#each week as day (dayKey(day))}
							{@const key = dayKey(day)}
							{@const dayEvents = eventsOn(day, eventsByDay)}
							{@const dayTasks = tasksOn(day, taskMap)}
							{@const active = key === activeKey}
							{@const isToday = sameDay(day, today)}
							{@const total = dayEvents.length + dayTasks.length}
							{@const hidden = total ? Math.min(total, hiddenByDay[key] ?? 0) : 0}
							<div
								class="cal-cell"
								class:is-today={isToday}
								class:is-out={day.getMonth() !== currentMonth.getMonth()}
								role="gridcell"
								tabindex={active ? 0 : -1}
								data-day={key}
								aria-label={cellLabel(day, dayEvents.length, dayTasks.length)}
								aria-current={isToday ? 'date' : undefined}
								on:keydown={(event) => onCellKey(event, day)}
								on:focusin={() => onCellFocus(day)}
								on:click={(event) => onCellClick(event, day)}
							>
								<div class="cal-cell__head">
									<span class="cal-date" aria-hidden="true">{day.getDate()}</span>
									{#if hidden > 0}
										<!-- In the head row beside the date, so the lines below keep the cell's
										     height for titles. Narrow days drop the word ("+4"); the name and
										     the tooltip say it in full. -->
										<Tooltip text={`Show all ${total} items`}>
											<button
												type="button"
												class="cal-more"
												tabindex={active ? 0 : -1}
												aria-label={`${hidden} more: show all ${total} items on ${dayMonthFormat.format(day)}`}
												on:click={() => openDayModal(day)}
											>
												<span>+{hidden}</span><span class="cal-more__word">more</span>
											</button>
										</Tooltip>
									{/if}
									{#if !isReadOnly}
										<Tooltip text={`Add on ${dayMonthFormat.format(day)}`}>
											<button
												type="button"
												class="w-ibtn w-ibtn--sm cal-add"
												tabindex={active ? 0 : -1}
												aria-label={`Add on ${dayMonthFormat.format(day)}`}
												on:click={() => openAddModal(day)}
											>
												<Icon name="plus" size={14} />
											</button>
										</Tooltip>
									{/if}
								</div>
								{#if dayEvents.length || dayTasks.length}
									<!-- Every line is here; fitDayLines hides what does not fit and counts it
									     for the head's "+N more". -->
									<ul class="cal-lines" use:fitDayLines={{ key, onfit: onFit }}>
										{#each dayEvents as event (`${event.id}-${event.startDate}`)}
											<li data-fit-item>{@render eventPill(event, true, active)}</li>
										{/each}
										{#each dayTasks as task (task.id)}
											<li class="cal-task" data-fit-item>{@render taskLine(task, true, active)}</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			</div>
		{/if}

		{#if showAside}
			<aside class="cal-aside" aria-label="Tasks with a due date">
				{#if overdue.length > 0}
					<section class="cal-aside__group" aria-labelledby={`${titleId}-overdue`}>
						<h3 class="cal-aside__kicker cal-aside__kicker--overdue" id={`${titleId}-overdue`}>
							Overdue <span class="cal-aside__count">{overdue.length}</span>
						</h3>
						<ul class="cal-aside__list">
							{#each overdue.slice(0, SIDE_LIST_ROWS) as task (task.id)}
								<li class="cal-aside__row cal-task">
									{@render taskLine(task, false, true)}
									<span class="cal-aside__date is-overdue">{dateWords(task.dueDate ?? now, now)}</span>
								</li>
							{/each}
						</ul>
						{#if overdue.length > SIDE_LIST_ROWS}
							<button type="button" class="cal-aside__more" on:click={() => openPlannerTasksPanel('overdue')}>
								and {overdue.length - SIDE_LIST_ROWS} more overdue
							</button>
						{/if}
					</section>
				{/if}
				<section class="cal-aside__group" aria-labelledby={`${titleId}-upcoming`}>
					<h3 class="cal-aside__kicker" id={`${titleId}-upcoming`}>
						Upcoming {#if upcoming.length}<span class="cal-aside__count">{upcoming.length}</span>{/if}
					</h3>
					{#if upcoming.length === 0}
						<p class="cal-aside__empty">Nothing due in the next seven days.</p>
					{:else}
						<ul class="cal-aside__list">
							{#each upcoming.slice(0, SIDE_LIST_ROWS) as task (task.id)}
								<li class="cal-aside__row cal-task">
									{@render taskLine(task, false, true)}
									<span class="cal-aside__date">{dateWords(task.dueDate ?? now, now)}</span>
								</li>
							{/each}
						</ul>
						{#if upcoming.length > SIDE_LIST_ROWS}
							<button type="button" class="cal-aside__more" on:click={() => openPlannerTasksPanel('week')}>
								and {upcoming.length - SIDE_LIST_ROWS} more this week
							</button>
						{/if}
					{/if}
				</section>
			</aside>
		{/if}
	</div>
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
		bind:draftSignatures
		{legacySignedBy}
		{colorOptions}
		{handleSubmit}
		{handleDelete}
		{closeModal}
	/>
{/if}

<!-- Day Detail Modal: its task rows open the task (the prop keeps its old name). -->
{#if showDayModal}
	<CalendarDayModal
		{selectedDayEvents}
		modalDayTasks={tasksOn(new Date($selectedDate), taskMap)}
		{isReadOnly}
		{formatTime}
		getPriorityColor={priorityColor}
		{openEditModal}
		toggleTaskComplete={openTaskFromDay}
		{closeModal}
		{openAddModal}
	/>
{/if}

{#if openTodo}
	<PlannerTaskDialog todo={openTodo} {isReadOnly} onclose={() => (openTodo = null)} />
{/if}
