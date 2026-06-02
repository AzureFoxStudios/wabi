<script lang="ts">
	import type { CalendarEvent } from '$lib/business/types';

	export let editingEvent: CalendarEvent | null = null;
	export let formTitle = '';
	export let formDescription = '';
	export let formStartDate = '';
	export let formStartTime = '';
	export let formEndDate = '';
	export let formAllDay = false;
	export let formColor = '#5865f2';
	export let formRecurring = false;
	export let formRecurringFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly' = 'weekly';
	export let formRecurringInterval = 1;
	export let formRecurringEndDate = '';
	export let willSign = false;
	export let colorOptions: string[] = [];
	export let handleSubmit: () => void;
	export let handleDelete: (id: string) => void;
	export let closeModal: () => void;
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
		class="modal"
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
			<h2>{editingEvent ? 'Edit Event' : 'Add New Event'}</h2>
			<button class="close-btn" on:click={closeModal}>&times;</button>
		</div>
		<form on:submit|preventDefault={handleSubmit}>
			<div class="form-group">
				<label for="title">Title *</label>
				<input id="title" type="text" bind:value={formTitle} placeholder="Event title" required />
			</div>

			<div class="form-group">
				<label for="description">Description</label>
				<textarea id="description" bind:value={formDescription} placeholder="Add details..." rows="3"></textarea>
			</div>

			<div class="form-group">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={formAllDay} />
					<span>All day event</span>
				</label>
			</div>

			<div class="form-group">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={formRecurring} />
					<span>Recurring event</span>
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

			{#if formRecurring}
				<div class="form-row">
					<div class="form-group">
						<label for="frequency">Repeats</label>
						<select id="frequency" bind:value={formRecurringFrequency}>
							<option value="daily">Every day</option>
							<option value="weekly">Every week</option>
							<option value="monthly">Every month</option>
							<option value="yearly">Every year</option>
						</select>
					</div>
					<div class="form-group">
						<label for="interval">Every N:</label>
						<input id="interval" type="number" bind:value={formRecurringInterval} min="1" max="99" />
					</div>
				</div>
				<div class="form-group">
					<label for="recurringEndDate">Repeat until (optional)</label>
					<input id="recurringEndDate" type="date" bind:value={formRecurringEndDate} />
				</div>
			{/if}

			<div class="form-group">
				<span class="form-label">Color</span>
				<div class="color-picker">
					{#each colorOptions as color}
						<button
							type="button"
							class="color-option"
							class:selected={formColor === color}
							style="background-color: {color}"
							on:click={() => formColor = color}
							title={color}
						></button>
					{/each}
				</div>
			</div>

			<div class="form-group checkbox-group">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={willSign} />
					<span>Sign this event with my username</span>
				</label>
			</div>

			<div class="form-actions">
				{#if editingEvent}
					<button type="button" class="delete-btn" on:click={() => handleDelete(editingEvent.id)}>
						Delete
					</button>
				{/if}
				<button type="button" class="cancel-btn" on:click={closeModal}>Cancel</button>
				<button type="submit" class="submit-btn">
					{editingEvent ? 'Update' : 'Create'} Event
				</button>
			</div>
		</form>
	</div>
</div>
