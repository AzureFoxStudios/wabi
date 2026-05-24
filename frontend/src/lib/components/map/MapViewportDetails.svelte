<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import {
		clampNormalized,
		resolvePoiMarkerGlyph,
		formatPoiDisplayPreference,
		formatPoiThemePreset,
		formatPoiIconPreset,
		formatServerPoiTheme
	} from '../mapWorkspaceHelpers';
	import type { MapPoiDisplayPreference } from '$lib/mapDisplayPreferences';
	import { resolvePoiRenderMode } from '$lib/mapDisplayPreferences';
	import type { PlaceRecord, PlacePoiRecord, PlacePoiThemePreset, PlaceDraft } from '$lib/placeRegistry';

	export let stagePlace: PlaceRecord | null;
	export let stageMapLayers: PlaceRecord['mapLayers'];
	export let stagePois: PlaceRecord['pois'];
	export let allStagePois: PlaceRecord['pois'];
	export let selectedPoi: PlacePoiRecord | null;
	export let poiDisplayPreference: 'server' | 'label' | 'pin' | 'both';
	export let surfaceMode: 'custom' | 'osm';
	export let mapImageUrl: string | null;
	export let embedUrl: string | null;
	export let canManagePlaces: boolean;
	export let uploadBusy: boolean;
	export let placingPoiIndex: number;
	export let placeDraft: PlaceDraft | null;
	export let customMapViewport: HTMLDivElement | null = null;
	export let MAP_BASE_WIDTH: number;
	export let mapBaseHeight: number;
	export let mapZoom: number;
	export let mapPanX: number;
	export let mapPanY: number;
	export let viewRotation: number;
	export let isCompactLayout: boolean;

	function getEffectivePoiRenderMode(poi: PlacePoiRecord): PlacePoiRecord['renderMode'] {
		return resolvePoiRenderMode(poi.renderMode, poiDisplayPreference as MapPoiDisplayPreference);
	}
	function getEffectivePoiThemePreset(poi: Pick<PlacePoiRecord, 'themePreset'>): PlacePoiThemePreset {
		return poi.themePreset || stagePlace?.poiThemePreset || 'classic';
	}
	function describeServerPoiTheme(poi: PlacePoiRecord): string {
		return formatServerPoiTheme(poi, stagePlace?.poiThemePreset || 'classic');
	}

	const dispatch = createEventDispatcher<{
		selectPoi: string;
		viewportClick: MouseEvent;
		viewportWheel: WheelEvent;
		viewportMouseDown: MouseEvent;
		viewportKeydown: KeyboardEvent;
		customMapImageLoad: Event;
		rotateView: number;
		resetNorth: void;
		resetCustomMapView: void;
		cancelPoiPlacement: void;
		startQuickMapUpload: void;
		startQuickOsmSetup: void;
	}>();
</script>

<div class="map-panel">
	{#if surfaceMode === 'custom' && mapImageUrl}
		<div class="surface-toolbar">
			<div class="surface-status">
				<span>Zoom {Math.round(mapZoom * 100)}%</span>
				<span>Rotation {viewRotation.toFixed(0)} deg</span>
				{#if placingPoiIndex >= 0}
					<span class="placing-status">Placing {placeDraft?.pois[placingPoiIndex]?.name || 'POI'}...</span>
				{/if}
			</div>
			<div class="surface-buttons">
				<button class="ghost-button" type="button" on:click={() => dispatch('rotateView', -15)}>Rotate Left</button>
				<button class="ghost-button" type="button" on:click={() => dispatch('rotateView', 15)}>Rotate Right</button>
				<button class="ghost-button" type="button" on:click={() => dispatch('resetNorth')} disabled={viewRotation === 0}>North</button>
				<button class="ghost-button" type="button" on:click={() => dispatch('resetCustomMapView')}>Reset View</button>
				{#if placingPoiIndex >= 0}
					<button class="ghost-button danger" type="button" on:click={() => dispatch('cancelPoiPlacement')}>Cancel Placement</button>
				{/if}
			</div>
		</div>
		<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
		<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
		<div
			class="custom-map-viewport"
			bind:this={customMapViewport}
			role="application"
			tabindex="0"
			aria-label={`Interactive map for ${stagePlace?.name || 'this place'}. Use arrow keys to pan, plus or minus to zoom, bracket keys to rotate, and N to reset north.`}
			on:wheel|preventDefault={(e) => dispatch('viewportWheel', e)}
			on:mousedown={(e) => dispatch('viewportMouseDown', e)}
			on:click={(e) => dispatch('viewportClick', e)}
			on:keydown={(e) => dispatch('viewportKeydown', e)}
		>
			<div class="custom-map-content" style={`width:${MAP_BASE_WIDTH}px;height:${mapBaseHeight}px;transform: translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom});`}>
				<div class="rotated-map-layer" style={`transform: rotate(${viewRotation}deg);`}>
					<img class="custom-map-image" src={mapImageUrl} alt={`Map reference for ${stagePlace?.name}`} on:load={(e) => dispatch('customMapImageLoad', e)} />
					{#each stagePois as poi (poi.id)}
						<button
							type="button"
							class="poi-anchor"
							data-poi-theme={getEffectivePoiThemePreset(poi)}
							class:active={selectedPoi?.id === poi.id}
							style={`left:${poi.x * 100}%;top:${poi.y * 100}%;--poi-color:${poi.iconColor || '#78b4ff'}`}
							title={poi.name}
							on:click|stopPropagation={() => dispatch('selectPoi', poi.id)}
						>
							{#if getEffectivePoiRenderMode(poi) !== 'label'}
								<span class="poi-pin">{resolvePoiMarkerGlyph(poi)}</span>
							{/if}
							{#if getEffectivePoiRenderMode(poi) !== 'pin'}
								<span class="poi-label">{poi.name}</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>
			<div class="compass-overlay" aria-hidden="true">
				<div class="compass-rose">
					<span class="compass-arrow" style={`transform: translateX(-50%) rotate(${viewRotation}deg);`}></span>
					<span class="compass-letter">N</span>
				</div>
			</div>
			{#if stagePois.length === 0}
				<div class="viewport-overlay">No POIs placed on this custom map yet.</div>
			{/if}
			{#if placingPoiIndex >= 0}
				<div class="viewport-overlay place-hint">Click anywhere on the map to place this POI.</div>
			{/if}
		</div>
	{:else if surfaceMode === 'osm' && embedUrl}
		<iframe title={`Map for ${stagePlace?.name}`} src={embedUrl} loading="lazy"></iframe>
	{:else}
		<div class="visual-fallback">
			{#if canManagePlaces}
				<div class="visual-fallback-card">
					<h4>No map surface yet</h4>
					<p>Upload custom map art for floorplans or add coordinates for OpenStreetMap.</p>
					<div class="surface-buttons visual-fallback-actions">
						<button class="ghost-button" type="button" on:click={() => dispatch('startQuickMapUpload')} disabled={uploadBusy}>
							{uploadBusy ? 'Uploading...' : 'Upload Custom Map'}
						</button>
						<button class="ghost-button" type="button" on:click={() => dispatch('startQuickOsmSetup')}>
							Add OSM Coordinates
						</button>
					</div>
					<small>"OSM here please" is just latitude and longitude in the place editor.</small>
				</div>
			{:else}
				<div class="visual-fallback-card">
					<h4>No map surface yet</h4>
					<p>No visual map is configured for this place yet.</p>
					<small>Ask an owner or admin to upload map art or add coordinates.</small>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if !isCompactLayout}
	<div class="detail-panel">
		<div class="detail-card">
			<h4>Place Details</h4>
			<div class="detail-stat-grid">
				<div class="detail-stat">
					<span>Slug</span>
					<strong>@{stagePlace?.slug}</strong>
				</div>
				<div class="detail-stat">
					<span>Layers</span>
					<strong>{stageMapLayers.length || (stagePlace?.mapImageUrl ? 1 : 0)}</strong>
				</div>
				<div class="detail-stat">
					<span>POI View</span>
					<strong>{formatPoiDisplayPreference(poiDisplayPreference)}</strong>
				</div>
				<div class="detail-stat">
					<span>POI Theme</span>
					<strong>{formatPoiThemePreset(stagePlace?.poiThemePreset)}</strong>
				</div>
				<div class="detail-stat">
					<span>Rotation</span>
					<strong>{stagePlace?.mapRotation.toFixed(0)} deg</strong>
				</div>
				<div class="detail-stat">
					<span>POIs</span>
					<strong>{stagePois.length}{stageMapLayers.length > 1 ? ` visible / ${allStagePois.length} total` : ''}</strong>
				</div>
				<div class="detail-stat detail-stat--wide">
					<span>Aliases</span>
					<strong>{stagePlace?.aliases.length ? stagePlace.aliases.join(', ') : 'None'}</strong>
				</div>
				<div class="detail-stat detail-stat--wide">
					<span>Tags</span>
					<strong>{stagePlace?.tags.length ? stagePlace.tags.join(', ') : 'None'}</strong>
				</div>
			</div>
		</div>

		{#if stagePois.length > 0}
			<div class="detail-card">
				<h4>Points of Interest</h4>
				<div class="poi-list">
					{#each stagePois as poi (poi.id)}
						<button type="button" class="poi-item" class:active={selectedPoi?.id === poi.id} on:click={() => dispatch('selectPoi', poi.id)}>
							<strong>{poi.name}</strong>
							<small>{poi.description || getEffectivePoiRenderMode(poi)}</small>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		{#if selectedPoi}
			<div class="detail-card selected-poi-card">
				<h4>Selected POI</h4>
				<div class="poi-summary">
					<div class="poi-badge" data-poi-theme={getEffectivePoiThemePreset(selectedPoi)} style={`--poi-color:${selectedPoi.iconColor || '#78b4ff'}`}>
						{resolvePoiMarkerGlyph(selectedPoi)}
					</div>
					<div>
						<strong>{selectedPoi.name}</strong>
						<p>{selectedPoi.description || 'No description saved.'}</p>
					</div>
				</div>
				<ul>
					<li><strong>Server Style</strong><span>{selectedPoi.renderMode}</span></li>
					<li><strong>Shown As</strong><span>{getEffectivePoiRenderMode(selectedPoi)}</span></li>
					<li><strong>Server Theme</strong><span>{describeServerPoiTheme(selectedPoi)}</span></li>
					<li><strong>Shown Theme</strong><span>{formatPoiThemePreset(getEffectivePoiThemePreset(selectedPoi))}</span></li>
					<li><strong>Icon Preset</strong><span>{formatPoiIconPreset(selectedPoi.iconPreset || 'pin')}</span></li>
					<li><strong>Anchor</strong><span>{selectedPoi.x.toFixed(3)}, {selectedPoi.y.toFixed(3)}</span></li>
				</ul>
			</div>
		{/if}

		<slot />
	</div>
{/if}
