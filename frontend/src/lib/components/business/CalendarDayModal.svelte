<script lang="ts">
	import { selectedDate } from '$lib/business/store';
	import type { CalendarEvent, Todo } from '$lib/business/types';

	export let selectedDayEvents: CalendarEvent[] = [];
	export let modalDayTasks: Todo[] = [];
	export let isReadOnly = false;
	export let formatTime: (timestamp: number) => string;
	export let getPriorityColor: (priority: string) => string;
	export let openEditModal: (event: CalendarEvent) => void;
	export let toggleTaskComplete: (todo: Todo) => void;
	export let closeModal: () => void;
	export let openAddModal: (date?: Date) => void;
</script>

<div
	class="modal-overlay"
	role="button"
	tabindex="0"
	on:click={closeModal}
	on:keydown={(event) => {
		const tag = (event.target as HTMLElement).tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			closeModal();
		}
	}}
>
	<div
		class="modal day-detail-modal"
		role="button"
		tabindex="0"
		on:click|stopPropagation
		on:keydown|stopPropagation={(event) => {
			const tag = (event.target as HTMLElement).tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
			}
		}}
	>
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
							<li>
								<button class="event-detail-item" on:click={() => openEditModal(event)}>
									<div class="event-color" style="background-color: {event.color || '#5865f2'}"></div>
									<div class="event-details">
										<span class="event-title">{event.title}</span>
										<div class="event-meta">
											{#if event.allDay}
												<span class="event-time">All day</span>
											{:else}
												<span class="event-time">{formatTime(event.startDate)}</span>
											{/if}
											{#if event.signedBy}
												<span class="signature" title="Signed by {event.signedBy}">
													✍ {event.signedBy}
												</span>
											{/if}
										</div>
									</div>
								</button>
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
							<li>
								<button class="event-detail-item task-item" on:click={() => toggleTaskComplete(task)}>
									<div class="event-color" style="background-color: {getPriorityColor(task.priority)}"></div>
									<div class="event-details">
										<span class="event-title">{task.title}</span>
										<span class="event-time priority-{task.priority}">{task.priority}</span>
									</div>
									<span class="task-check" title="Mark complete">&#10003;</span>
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if selectedDayEvents.length === 0 && modalDayTasks.length === 0}
				<p class="empty-message">No events or tasks scheduled</p>
			{/if}

			<button class="add-event-btn" on:click={() => { closeModal(); openAddModal(new Date($selectedDate)); }} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add event for this day'}>
				+ Add Event
			</button>
		</div>
	</div>
</div>
