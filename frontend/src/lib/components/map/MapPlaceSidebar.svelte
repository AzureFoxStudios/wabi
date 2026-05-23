<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { placeRegistryLoading } from '$lib/placeRegistry';
	import type { PlaceRecord } from '$lib/placeRegistry';
	import { resolvePlaceAssetUrl } from '$lib/placeRegistry';

	export let variant: 'compact' | 'full' | 'detached';
	export let searchQuery: string;
	export let loading: boolean;
	export let loadError: string;
	export let canManagePlaces: boolean;
	export let visiblePlaces: PlaceRecord[];
	export let activePlace: PlaceRecord | null;
	export let editorMode: 'view' | 'edit' | 'new';
	export let normalizedQuery: string;

	function getPlacePreviewUrl(place: PlaceRecord | null): string | null {
		if (!place) return null;
		const firstLayerImage =
			place.mapLayers.find((layer) => Boolean(resolvePlaceAssetUrl(layer.imageUrl)))?.imageUrl || null;
		return resolvePlaceAssetUrl(firstLayerImage || place.mapImageUrl || null);
	}

	const dispatch = createEventDispatcher<{
		refresh: void;
		newPlace: void;
		editPlace: void;
		selectPlace: PlaceRecord;
	}>();
</script>

<div class="map-sidebar">
	<div class="map-sidebar-header">
		<div>
			<h2>Server Map</h2>
			<p>Places shared by this Wabi server.</p>
		</div>
		<button class="ghost-button" type="button" on:click={() => dispatch('refresh')} disabled={loading || $placeRegistryLoading}>
			{loading || $placeRegistryLoading ? 'Refreshing...' : 'Refresh'}
		</button>
	</div>

	<label class="search-field">
		<span>Search places</span>
		<input type="text" bind:value={searchQuery} placeholder="building, tag, alias..." />
	</label>

	{#if canManagePlaces && variant !== 'compact'}
		<div class="admin-actions">
			<button class="ghost-button" type="button" on:click={() => dispatch('newPlace')}>New Place</button>
			{#if activePlace}
				<button class="ghost-button" type="button" on:click={() => dispatch('editPlace')}>Edit Place</button>
			{/if}
		</div>
	{/if}

	{#if loadError}
		<p class="state-message error">{loadError}</p>
	{/if}

	<div class="place-list-header">
		<strong>Places</strong>
		<span>{visiblePlaces.length}</span>
	</div>

	{#if loading && visiblePlaces.length === 0}
		<p class="state-message">Loading map places...</p>
	{:else if visiblePlaces.length === 0}
		<div class="state-message">
			<div>{normalizedQuery ? 'No places match this search yet.' : 'No places have been configured yet.'}</div>
			{#if canManagePlaces && !normalizedQuery}
				<div class="admin-actions">
					<button class="ghost-button" type="button" on:click={() => dispatch('newPlace')}>Create First Place</button>
				</div>
			{/if}
		</div>
	{:else}
		<div class="place-list" role="list">
			{#each visiblePlaces as place (place.id)}
				{@const placePreviewUrl = getPlacePreviewUrl(place)}
				<button type="button" class="place-item" class:active={activePlace?.id === place.id && editorMode === 'view'} on:click={() => dispatch('selectPlace', place)}>
					<div class="place-thumb" class:has-preview={Boolean(placePreviewUrl)}>
						{#if placePreviewUrl}
							<img src={placePreviewUrl} alt="" loading="lazy" decoding="async" />
						{:else}
							<span>{place.name.charAt(0).toUpperCase()}</span>
						{/if}
					</div>
					<div class="place-copy">
						<div class="place-copy-heading">
							<strong>{place.name}</strong>
							<small>@{place.slug}</small>
						</div>
						<div class="place-chip-row">
							{#if place.building}
								<span class="place-chip">{place.building}</span>
							{/if}
							{#if place.floor}
								<span class="place-chip">Floor {place.floor}</span>
							{/if}
							{#if place.mapLayers.length > 0 || place.mapImageUrl}
								<span class="place-chip">{place.mapLayers.length || 1} layer{(place.mapLayers.length || 1) === 1 ? '' : 's'}</span>
							{/if}
							{#if place.pois.length > 0}
								<span class="place-chip">{place.pois.length} POI{place.pois.length === 1 ? '' : 's'}</span>
							{/if}
							{#if place.lat != null && place.lon != null}
								<span class="place-chip">OSM</span>
							{/if}
						</div>
					</div>
				</button>
			{/each}
		</div>
	{/if}
</div>
