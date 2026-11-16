<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { CalendarEvent } from '$lib/business/types';
	import SignatureRow from './SignatureRow.svelte';

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
	/** Draft sign-offs (two-way bound with the host form). */
	export let draftSignatures: import('$lib/business/types').ItemSignature[] = [];
	/** Legacy read-only signer shown when the event predates multi-sign. */
	export let legacySignedBy: string | undefined = undefined;
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
			<h2>{editingEvent?.recurring ? $_('cal.edit_series') : editingEvent ? $_('cal.edit_event') : $_('cal.add_event')}</h2>
			<button class="close-btn" aria-label={$_('cal.close')} on:click={closeModal}>&times;</button>
		</div>
		<form on:submit|preventDefault={handleSubmit}>
			{#if editingEvent?.recurring}<p>{$_('cal.series_note')}</p>{/if}
			<div class="form-group">
				<label for="title">{$_('reader_doc.title_label')} *</label>
				<input id="title" type="text" bind:value={formTitle} placeholder={$_('cal.title_ph')} required />
			</div>

			<div class="form-group">
				<label for="description">{$_('donation_config.description')}</label>
				<textarea id="description" bind:value={formDescription} placeholder={$_('cal.desc_ph')} rows="3"></textarea>
			</div>

			<div class="form-group">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={formAllDay} />
					<span>{$_('cal.all_day')}</span>
				</label>
			</div>

			<div class="form-group">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={formRecurring} />
					<span>{$_('cal.recurring')}</span>
				</label>
			</div>

			<div class="form-row">
				<div class="form-group">
					<label for="startDate">{$_('project_modal.start_date')} *</label>
					<input id="startDate" type="date" bind:value={formStartDate} required />
				</div>
				{#if !formAllDay}
					<div class="form-group">
						<label for="startTime">{$_('cal.start_time')}</label>
						<input id="startTime" type="time" bind:value={formStartTime} />
					</div>
				{/if}
			</div>

			<div class="form-group">
				<label for="endDate">{$_('cal.end_date')}</label>
				<input id="endDate" type="date" bind:value={formEndDate} />
			</div>

			{#if formRecurring}
				<div class="form-row">
					<div class="form-group">
						<label for="frequency">{$_('cal.repeats')}</label>
						<select id="frequency" bind:value={formRecurringFrequency}>
							<option value="daily">{$_('cal.every_day')}</option>
							<option value="weekly">{$_('cal.every_week')}</option>
							<option value="monthly">{$_('cal.every_month')}</option>
							<option value="yearly">{$_('cal.every_year')}</option>
						</select>
					</div>
					<div class="form-group">
						{#if formRecurringFrequency === 'monthly' || formRecurringFrequency === 'yearly'}<p>{$_('cal.skip_note')}</p>{/if}
					<label for="interval">{$_('cal.every_n')}</label>
						<input id="interval" type="number" bind:value={formRecurringInterval} min="1" max="99" />
					</div>
				</div>
				<div class="form-group">
					<label for="recurringEndDate">{$_('cal.repeat_until')}</label>
					<input id="recurringEndDate" type="date" bind:value={formRecurringEndDate} />
				</div>
			{/if}

			<div class="form-group">
				<span class="form-label">{$_('project_modal.color')}</span>
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

			<div class="form-group">
				<SignatureRow bind:draftSignatures {legacySignedBy} label={$_('project_modal.names_attached')} />
			</div>

			<div class="form-actions">
				{#if editingEvent}
					<button type="button" class="delete-btn" on:click={() => handleDelete(editingEvent.id)}>
						{$_('admin.actions.delete')}
					</button>
				{/if}
				<button type="button" class="cancel-btn" on:click={closeModal}>{$_('common.cancel')}</button>
				<button type="submit" class="submit-btn">
					{editingEvent ? $_('cal.update_event') : $_('cal.create_event')}
				</button>
			</div>
		</form>
	</div>
</div>
