<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { formatMapPlaceMeta } from '../mapWorkspaceHelpers';
	import type { PlaceRecord } from '$lib/placeRegistry';

	export let stagePlace: PlaceRecord | null;
	export let stageMapLayers: PlaceRecord['mapLayers'];
	export let allStagePois: PlaceRecord['pois'];
	export let surfaceHasCustom: boolean;
	export let surfaceHasOsm: boolean;
	export let surfaceMode: 'custom' | 'osm';
	export let canManagePlaces: boolean;
	export let uploadBusy: boolean;
	export let externalUrl: string | null;
	export let modelUrl: string | null;
	export let modelViewerAvailable: boolean;
	export let selectedLayerId: string;
	export let poiDisplayPreference: 'server' | 'label' | 'pin' | 'both';
	export let activeMapLayer: PlaceRecord['mapLayers'][number] | null;
	export let stagePois: PlaceRecord['pois'];
	export let isCompactLayout: boolean;
	export let variant: 'compact' | 'full' | 'detached';

	import {
		formatPoiDisplayPreference,
		formatPoiThemePreset
	} from '../mapWorkspaceHelpers';
	import { setMapPoiDisplayPreference, type MapPoiDisplayPreference } from '$lib/mapDisplayPreferences';

	const dispatch = createEventDispatcher<{
		startQuickMapUpload: void;
		startQuickOsmSetup: void;
		openPlaceModelViewport: void;
		changeSurfaceMode: 'custom' | 'osm';
		changeLayerId: string;
		changePoiDisplayPreference: MapPoiDisplayPreference;
	}>();
</script>

{#if !isCompactLayout}
	<div class="place-header">
		<div class="place-heading">
			<div class="place-kicker">Map Place</div>
			<h3>{stagePlace?.name}</h3>
			<p>{stagePlace?.description || formatMapPlaceMeta(stagePlace)}</p>
			<div class="place-chip-row place-chip-row--hero">
				{#if stagePlace?.building}
					<span class="place-chip">{stagePlace.building}</span>
				{/if}
				{#if stagePlace?.floor}
					<span class="place-chip">Floor {stagePlace.floor}</span>
				{/if}
				<span class="place-chip">{stageMapLayers.length || (stagePlace?.mapImageUrl ? 1 : 0)} layer{(stageMapLayers.length || (stagePlace?.mapImageUrl ? 1 : 0)) === 1 ? '' : 's'}</span>
				<span class="place-chip">{allStagePois.length} POI{allStagePois.length === 1 ? '' : 's'}</span>
				{#if surfaceHasCustom}
					<span class="place-chip">Custom Map</span>
				{/if}
				{#if surfaceHasOsm}
					<span class="place-chip">OSM Ready</span>
				{/if}
			</div>
		</div>
		<div class="place-actions">
			{#if canManagePlaces && !surfaceHasCustom}
				<button class="ghost-button" type="button" on:click={() => dispatch('startQuickMapUpload')} disabled={uploadBusy}>
					{uploadBusy ? 'Uploading...' : 'Upload Custom Map'}
				</button>
			{/if}
			{#if canManagePlaces && !surfaceHasOsm}
				<button class="ghost-button" type="button" on:click={() => dispatch('startQuickOsmSetup')}>
					Add OSM Coordinates
				</button>
			{/if}
			{#if surfaceHasCustom && surfaceHasOsm}
				<div class="surface-toggle" role="tablist" aria-label="Map surface selector">
					<button type="button" class:active={surfaceMode === 'custom'} on:click={() => dispatch('changeSurfaceMode', 'custom')}>Custom</button>
					<button type="button" class:active={surfaceMode === 'osm'} on:click={() => dispatch('changeSurfaceMode', 'osm')}>OSM</button>
				</div>
			{/if}
			{#if externalUrl}
				<a class="ghost-button" href={externalUrl} target="_blank" rel="noreferrer noopener">Open External Map</a>
			{/if}
			{#if modelUrl}
				{#if modelViewerAvailable}
					<button class="ghost-button" type="button" on:click={() => dispatch('openPlaceModelViewport')}>Open 3D Tab</button>
				{/if}
				<a class="ghost-button" href={modelUrl} target="_blank" rel="noreferrer noopener">Open Model</a>
			{/if}
		</div>
	</div>

	{#if stagePlace?.description}
		<p class="place-description">{stagePlace.description}</p>
	{/if}

	{#if stageMapLayers.length > 1 || stagePois.length > 0}
		<div class="display-preference-row">
			{#if stageMapLayers.length > 1}
				<label class="display-mode-field">
					<span>Map Layer</span>
					<select value={selectedLayerId} on:change={(event) => dispatch('changeLayerId', (event.currentTarget as HTMLSelectElement).value)}>
						{#each stageMapLayers as layer (layer.id)}
							<option value={layer.id}>{layer.name}{layer.floor ? ` | Floor ${layer.floor}` : ''}</option>
						{/each}
					</select>
				</label>
			{/if}
			{#if stagePois.length > 0}
				<label class="display-mode-field">
					<span>POI View</span>
					<select
						value={poiDisplayPreference}
						on:change={(event) =>
							dispatch('changePoiDisplayPreference', (event.currentTarget as HTMLSelectElement).value as MapPoiDisplayPreference)}
					>
						<option value="server">Server Default</option>
						<option value="label">Labels Only</option>
						<option value="pin">Pins Only</option>
						<option value="both">Labels + Pins</option>
					</select>
				</label>
			{/if}
			<small class="display-mode-note">
				{#if stageMapLayers.length > 1}
					Showing {activeMapLayer?.name || 'selected layer'}
					{#if stagePois.length > 0} | {/if}
				{/if}
				{#if stagePois.length > 0}
					Local POI override only. Server defaults remain unchanged.
					{/if}
			</small>
		</div>
	{/if}
{:else}
	<div class="compact-stage-toolbar">
		<div class="compact-stage-summary">
			<strong>{stagePlace?.name}</strong>
			<span>{stageMapLayers.length || (stagePlace?.mapImageUrl ? 1 : 0)} layer{(stageMapLayers.length || (stagePlace?.mapImageUrl ? 1 : 0)) === 1 ? '' : 's'}{#if allStagePois.length > 0} | {allStagePois.length} POI{allStagePois.length === 1 ? '' : 's'}{/if}</span>
		</div>
		<div class="compact-stage-controls">
			{#if stageMapLayers.length > 1}
				<label class="display-mode-field compact-display-mode-field">
					<span>Layer</span>
					<select value={selectedLayerId} on:change={(event) => dispatch('changeLayerId', (event.currentTarget as HTMLSelectElement).value)}>
						{#each stageMapLayers as layer (layer.id)}
							<option value={layer.id}>{layer.name}{layer.floor ? ` | Floor ${layer.floor}` : ''}</option>
						{/each}
					</select>
				</label>
			{/if}
			{#if surfaceHasCustom && surfaceHasOsm}
				<div class="surface-toggle" role="tablist" aria-label="Map surface selector">
					<button type="button" class:active={surfaceMode === 'custom'} on:click={() => dispatch('changeSurfaceMode', 'custom')}>Custom</button>
					<button type="button" class:active={surfaceMode === 'osm'} on:click={() => dispatch('changeSurfaceMode', 'osm')}>OSM</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
