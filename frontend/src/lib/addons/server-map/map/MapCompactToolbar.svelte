<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { formatMapPlaceMeta } from '../mapWorkspaceHelpers';
	import type { PlaceRecord } from '$lib/placeRegistry';

	export let searchQuery: string;
	export let compactPlaceSuggestions: PlaceRecord[];
	export let activePlace: PlaceRecord | null;
	export let editorMode: 'view' | 'edit' | 'new';
	export let normalizedQuery: string;

	const dispatch = createEventDispatcher<{
		selectPlace: PlaceRecord;
	}>();
</script>

<div class="compact-map-toolbar">
	<label class="search-field compact-map-search">
		<span>Search places</span>
		<input type="text" bind:value={searchQuery} placeholder="Search this server map..." />
	</label>
	{#if compactPlaceSuggestions.length > 0}
		<div class="compact-place-picker" role="list">
			{#each compactPlaceSuggestions as place (place.id)}
				<button
					type="button"
					class="compact-place-chip"
					class:active={activePlace?.id === place.id && editorMode === 'view'}
					on:click={() => dispatch('selectPlace', place)}
				>
					{place.name}
				</button>
			{/each}
		</div>
	{:else if normalizedQuery}
		<div class="compact-map-empty">No places match this search yet.</div>
	{:else if activePlace}
		<div class="compact-active-place">
			<strong>{activePlace.name}</strong>
			<span>{activePlace.description || formatMapPlaceMeta(activePlace)}</span>
		</div>
	{/if}
</div>
