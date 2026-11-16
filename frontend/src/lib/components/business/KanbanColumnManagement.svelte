<script lang="ts">
	import { _ } from '$lib/i18n';
	import { kanbanColumns } from '$lib/business';
	import type { TodoStatus } from '$lib/business/types';

	export let managingColumns = false;
	export let newColumnName = '';
	export let newColumnColor = '#3b82f6';
	export let addNewColumn: () => void;
	export let deleteColumn: (columnId: TodoStatus) => void;
</script>

<div class="column-management">
	<div class="management-header">
		<h3>{$_('kanban_cols.title')}</h3>
		<button class="close-btn" on:click={() => managingColumns = false}>×</button>
	</div>

	<div class="add-column-form">
		<h4>{$_('kanban_cols.add_heading')}</h4>
		<input
			type="text"
			bind:value={newColumnName}
			placeholder={$_('kanban_cols.name_placeholder')}
			on:keydown={(event) => event.key === 'Enter' && addNewColumn()}
		/>
		<div class="color-picker">
			<label for="new-column-color">{$_('kanban_cols.color')}</label>
			<input id="new-column-color" type="color" bind:value={newColumnColor} />
			<div class="color-preview" style="background-color: {newColumnColor}"></div>
		</div>
		<button class="add-column-btn" on:click={addNewColumn} disabled={!newColumnName.trim()}>
			{$_('kanban_cols.add_btn')}
		</button>
	</div>

	<div class="existing-columns">
		<h4>{$_('kanban_cols.existing')}</h4>
		<div class="columns-list">
			{#each $kanbanColumns as column}
				<div class="column-item">
					<div class="column-info">
						<div class="column-color" style="background-color: {column.color}"></div>
						<span>{column.label}</span>
						<span class="column-id">({column.id})</span>
					</div>
					{#if !['todo', 'done', 'in_progress'].includes(column.id)}
						<button class="delete-column-btn" on:click={() => deleteColumn(column.id)}>
							{$_('kanban_cols.delete')}
						</button>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>
