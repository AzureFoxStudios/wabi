<script lang="ts">
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
		<h3>Manage Columns</h3>
		<button class="close-btn" on:click={() => managingColumns = false}>×</button>
	</div>

	<div class="add-column-form">
		<h4>Add New Column</h4>
		<input
			type="text"
			bind:value={newColumnName}
			placeholder="Column name"
			on:keydown={(event) => event.key === 'Enter' && addNewColumn()}
		/>
		<div class="color-picker">
			<label for="new-column-color">Color:</label>
			<input id="new-column-color" type="color" bind:value={newColumnColor} />
			<div class="color-preview" style="background-color: {newColumnColor}"></div>
		</div>
		<button class="add-column-btn" on:click={addNewColumn} disabled={!newColumnName.trim()}>
			Add Column
		</button>
	</div>

	<div class="existing-columns">
		<h4>Existing Columns</h4>
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
							Delete
						</button>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>
