<script lang="ts">
	import { _ } from '$lib/i18n';
	import MapVectorStage from './MapVectorStage.svelte';
	import { createEventDispatcher } from 'svelte';
	import MapTokenOverlay from '../MapTokenOverlay.svelte';
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
				<span>{$_('mvd.zoom', { values: { zoom: Math.round(mapZoom * 100) } })}</span>
				<span>{$_('mvd.rotation', { values: { deg: viewRotation.toFixed(0) } })}</span>
				{#if placingPoiIndex >= 0}
					<span class="placing-status">{$_('map_details.placing', { values: { name: placeDraft?.pois[placingPoiIndex]?.name || $_('message_content.poi_label') } })}</span>
				{/if}
			</div>
			<div class="surface-buttons">
				<button class="ghost-button" type="button" on:click={() => dispatch('rotateView', -15)}>{$_('map_details.rotate_left')}</button>
				<button class="ghost-button" type="button" on:click={() => dispatch('rotateView', 15)}>{$_('map_details.rotate_right')}</button>
				<button class="ghost-button" type="button" on:click={() => dispatch('resetNorth')} disabled={viewRotation === 0}>{$_('map_details.north')}</button>
				<button class="ghost-button" type="button" on:click={() => dispatch('resetCustomMapView')}>{$_('map_details.reset_view')}</button>
				{#if placingPoiIndex >= 0}
					<button class="ghost-button danger" type="button" on:click={() => dispatch('cancelPoiPlacement')}>{$_('map_details.cancel_placement')}</button>
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
			aria-label={$_('map_details.interactive_label', { values: { name: stagePlace?.name || $_('map_details.this_place') } })}
			on:wheel|preventDefault={(e) => dispatch('viewportWheel', e)}
			on:mousedown={(e) => dispatch('viewportMouseDown', e)}
			on:click={(e) => dispatch('viewportClick', e)}
			on:keydown={(e) => dispatch('viewportKeydown', e)}
		>
			<div class="custom-map-content" style={`width:${MAP_BASE_WIDTH}px;height:${mapBaseHeight}px;transform: translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom});`}>
				<div class="rotated-map-layer" style={`transform: rotate(${viewRotation}deg);`}>
					<img class="custom-map-image" src={mapImageUrl} alt={$_('map_details.map_ref_alt', { values: { name: stagePlace?.name } })} on:load={(e) => dispatch('customMapImageLoad', e)} />
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
					<MapTokenOverlay placeId={stagePlace?.id || null} layerId={stageMapLayers.length ? (stagePois[0]?.layerId || null) : null} {viewRotation} />
				</div>
			</div>
			<div class="compass-overlay" aria-hidden="true">
				<div class="compass-rose">
					<span class="compass-arrow" style={`transform: translateX(-50%) rotate(${viewRotation}deg);`}></span>
					<span class="compass-letter">N</span>
				</div>
			</div>
			{#if stagePois.length === 0}
				<div class="viewport-overlay">{$_('map_details.no_pois')}</div>
			{/if}
			{#if placingPoiIndex >= 0}
				<div class="viewport-overlay place-hint">{$_('map_details.click_to_place')}</div>
			{/if}
		</div>
	{:else if surfaceMode === 'osm' && embedUrl}
		<MapVectorStage latitude={stagePlace?.lat ?? undefined} longitude={stagePlace?.lon ?? undefined} />
	{:else}
		<div class="visual-fallback">
			{#if canManagePlaces}
				<div class="visual-fallback-card">
					<h4>{$_('map_details.no_surface')}</h4>
					<p>{$_('map_details.upload_hint')}</p>
					<div class="surface-buttons visual-fallback-actions">
						<button class="ghost-button" type="button" on:click={() => dispatch('startQuickMapUpload')} disabled={uploadBusy}>
							{uploadBusy ? $_('message_content.uploading_ellipsis') : $_('mp.upload_custom')}
						</button>
						<button class="ghost-button" type="button" on:click={() => dispatch('startQuickOsmSetup')}>
							{$_('mp.add_osm')}
						</button>
					</div>
					<small>{$_('map_details.osm_note')}</small>
				</div>
			{:else}
				<div class="visual-fallback-card">
					<h4>{$_('map_details.no_surface')}</h4>
					<p>{$_('map_details.no_visual_map')}</p>
					<small>{$_('map_details.ask_owner')}</small>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if !isCompactLayout}
	<div class="detail-panel">
		<div class="detail-card">
			<h4>{$_('map_details.place_details')}</h4>
			<div class="detail-stat-grid">
				<div class="detail-stat">
					<span>{$_('map_details.slug')}</span>
					<strong>@{stagePlace?.slug}</strong>
				</div>
				<div class="detail-stat">
					<span>{$_('wb.layers')}</span>
					<strong>{stageMapLayers.length || (stagePlace?.mapImageUrl ? 1 : 0)}</strong>
				</div>
				<div class="detail-stat">
					<span>{$_('mp.poi_view')}</span>
					<strong>{formatPoiDisplayPreference(poiDisplayPreference)}</strong>
				</div>
				<div class="detail-stat">
					<span>{$_('map.poi_theme')}</span>
					<strong>{formatPoiThemePreset(stagePlace?.poiThemePreset)}</strong>
				</div>
				<div class="detail-stat">
					<span>{$_('map.rotation')}</span>
					<strong>{$_('mvd.deg_value', { values: { deg: stagePlace?.mapRotation.toFixed(0) } })}</strong>
				</div>
				<div class="detail-stat">
					<span>{$_('map_details.pois')}</span>
					<strong>{stagePois.length}{stageMapLayers.length > 1 ? $_('map_details.visible_total', { values: { total: allStagePois.length } }) : ''}</strong>
				</div>
				<div class="detail-stat detail-stat--wide">
					<span>{$_('map.aliases')}</span>
					<strong>{stagePlace?.aliases.length ? stagePlace.aliases.join(', ') : $_('wb.pattern_none')}</strong>
				</div>
				<div class="detail-stat detail-stat--wide">
					<span>{$_('map.tags')}</span>
					<strong>{stagePlace?.tags.length ? stagePlace.tags.join(', ') : $_('wb.pattern_none')}</strong>
				</div>
			</div>
		</div>

		{#if stagePois.length > 0}
			<div class="detail-card">
				<h4>{$_('map_details.points_of_interest')}</h4>
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
				<h4>{$_('map_details.selected_poi')}</h4>
				<div class="poi-summary">
					<div class="poi-badge" data-poi-theme={getEffectivePoiThemePreset(selectedPoi)} style={`--poi-color:${selectedPoi.iconColor || '#78b4ff'}`}>
						{resolvePoiMarkerGlyph(selectedPoi)}
					</div>
					<div>
						<strong>{selectedPoi.name}</strong>
						<p>{selectedPoi.description || $_('map_details.no_description')}</p>
					</div>
				</div>
				<ul>
					<li><strong>{$_('map_details.server_style')}</strong><span>{selectedPoi.renderMode}</span></li>
					<li><strong>{$_('map_details.shown_as')}</strong><span>{getEffectivePoiRenderMode(selectedPoi)}</span></li>
					<li><strong>{$_('map_details.server_theme')}</strong><span>{describeServerPoiTheme(selectedPoi)}</span></li>
					<li><strong>{$_('map_details.shown_theme')}</strong><span>{formatPoiThemePreset(getEffectivePoiThemePreset(selectedPoi))}</span></li>
					<li><strong>{$_('map.icon_preset')}</strong><span>{formatPoiIconPreset(selectedPoi.iconPreset || 'pin')}</span></li>
					<li><strong>{$_('network_health.anchor')}</strong><span>{selectedPoi.x.toFixed(3)}, {selectedPoi.y.toFixed(3)}</span></li>
				</ul>
			</div>
		{/if}

		<slot />
	</div>
{/if}
