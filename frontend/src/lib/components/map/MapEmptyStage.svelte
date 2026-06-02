<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let isCompactLayout: boolean;
	export let canManagePlaces: boolean;

	const dispatch = createEventDispatcher<{
		newPlace: void;
	}>();
</script>

<div class="empty-stage">
	<div class="empty-stage-copy">
		<h3>No place selected</h3>
		<p>{isCompactLayout ? 'Search for a place to open the server map.' : 'Choose a saved place from the list to open the server map.'}</p>
		{#if canManagePlaces}
			<div class="surface-buttons">
				<button class="ghost-button" type="button" on:click={() => dispatch('newPlace')}>Create First Place</button>
			</div>
		{/if}
	</div>
</div>
