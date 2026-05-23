<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { hasAddonCapability } from '$lib/addonInventory';
	import { currentUser } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import {
		buildMapEmbedUrl,
		buildMapExternalUrl,
		ensureMapFocus,
		focusMapPlace,
		focusedMapLayerId,
		focusedMapPlace,
		focusedMapPoiId
	} from '$lib/mapWorkspace';
	import { openModelViewport } from '$lib/modelViewportTab';
	import {
		mapDisplayPreferences,
		resolvePoiRenderMode,
		setMapPoiDisplayPreference,
		type MapPoiDisplayPreference
	} from '$lib/mapDisplayPreferences';
	import {
		createEmptyPlaceDraft,
		createEmptyMapLayerDraft,
		createEmptyPoiDraft,
		createPlaceDraft,
		deletePlace,
		loadPlaceRegistry,
		placeRegistry,
		placeRegistryLoading,
		resolvePlaceAssetUrl,
		savePlaceDraft,
		type PlaceDraft,
		type PlaceMapLayerDraft,
		type PlacePoiDraft,
		type PlacePoiThemePreset,
		type PlacePoiRecord,
		type PlaceRecord
	} from '$lib/placeRegistry';
	import {
		buildDraftPreview,
		buildDraftValidationIssues,
		clampNormalized,
		formatMapPlaceMeta,
		formatPoiDisplayPreference,
		formatPoiIconPreset,
		formatPoiThemePreset,
		formatServerPoiTheme,
		normalizeKey,
		normalizeRotationDegrees,
		parseCoordinate,
		resolvePoiMarkerGlyph
	} from './mapWorkspaceHelpers';

	import MapPlaceSidebar from './map/MapPlaceSidebar.svelte';
	import MapCompactToolbar from './map/MapCompactToolbar.svelte';
	import MapPlaceHeader from './map/MapPlaceHeader.svelte';
	import MapEmptyStage from './map/MapEmptyStage.svelte';

	export let variant: 'compact' | 'full' | 'detached' = 'full';
	export let initialPlaceId: string | null = null;

	type SurfaceMode = 'custom' | 'osm';

	type EditorMode = 'view' | 'edit' | 'new';

	const MAP_BASE_WIDTH = 1000;
	const DEFAULT_IMAGE_WIDTH = 1600;
	const DEFAULT_IMAGE_HEIGHT = 1000;
	const MIN_ZOOM = 0.35;
	const MAX_ZOOM = 4;

	let searchQuery = '';
	let loading = false;
	let loadError = '';
	let lastRequestedInitialPlaceId: string | null = null;
	let lastAppliedFocusContextKey = '';
	let lastViewportResetKey = '';

	let surfaceMode: SurfaceMode = 'custom';
	let editorMode: EditorMode = 'view';
	let editorSnapshot = '';
	let saveBusy = false;
	let deleteBusy = false;
	let uploadBusy = false;
	let selectedLayerId = '';
	let selectedPoiId = '';
	let selectedDraftLayerIndex = -1;
	let selectedDraftPoiIndex = -1;
	let placingPoiIndex = -1;

	let placeDraft: PlaceDraft = createEmptyPlaceDraft();
	let customMapViewport: HTMLDivElement | null = null;
	let mapUploadInput: HTMLInputElement | null = null;
	let latitudeInput: HTMLInputElement | null = null;

	let customMapNaturalWidth = DEFAULT_IMAGE_WIDTH;
	let customMapNaturalHeight = DEFAULT_IMAGE_HEIGHT;
	let mapZoom = 1;
	let mapPanX = 0;
	let mapPanY = 0;
	let viewRotation = 0;
	let modelViewerAvailable = false;
	let isPanning = false;
	let panStartX = 0;
	let panStartY = 0;
	let panOriginX = 0;
	let panOriginY = 0;
	let panMoved = false;
	let suppressViewportClick = false;

	$: normalizedQuery = searchQuery.trim().toLowerCase();
	$: visiblePlaces = $placeRegistry.filter((place) => {
		if (!normalizedQuery) return true;
		const haystack = [
			place.name,
			place.slug,
			place.id,
			place.building || '',
			place.floor || '',
			place.description || '',
			...place.aliases,
			...place.tags
		]
			.join(' ')
			.toLowerCase();
		return haystack.includes(normalizedQuery);
	});
	$: activePlace =
		($focusedMapPlace &&
			visiblePlaces.find(
				(place) => place.id === $focusedMapPlace?.id || place.slug === $focusedMapPlace?.slug
			)) ||
		$focusedMapPlace ||
		visiblePlaces[0] ||
		null;
	$: isCompactLayout = variant === 'compact';
	$: compactPlaceSuggestions = normalizedQuery ? visiblePlaces.slice(0, 12) : [];
	$: canManagePlaces =
		variant !== 'compact' &&
		($currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin');
	$: draftPreviewPlace = buildDraftPreview(placeDraft, editorMode !== 'view');
	$: stagePlace = editorMode === 'view' ? activePlace : draftPreviewPlace;
	$: embedUrl = buildMapEmbedUrl(stagePlace, variant);
	$: externalUrl = buildMapExternalUrl(stagePlace);
	$: stageMapLayers = stagePlace?.mapLayers || [];
	$: if (stageMapLayers.length === 0) {
		selectedLayerId = '';
	} else if (!stageMapLayers.some((layer) => layer.id === selectedLayerId)) {
		selectedLayerId = stageMapLayers[0].id;
	}
	$: activeMapLayer =
		stageMapLayers.find((layer) => layer.id === selectedLayerId) || stageMapLayers[0] || null;
	$: mapImageUrl = resolvePlaceAssetUrl(activeMapLayer?.imageUrl || stagePlace?.mapImageUrl);
	$: modelUrl = resolvePlaceAssetUrl(stagePlace?.modelUrl);
	$: surfaceHasCustom = Boolean(mapImageUrl);
	$: surfaceHasOsm = Boolean(embedUrl);
	$: allStagePois = stagePlace?.pois || [];
	$: stagePois =
		stageMapLayers.length === 0
			? allStagePois
			: allStagePois.filter((poi) => !poi.layerId || poi.layerId === selectedLayerId);
	$: {
		const focusContextKey = `${editorMode}:${stagePlace?.id || 'none'}:${$focusedMapLayerId || 'none'}:${$focusedMapPoiId || 'none'}`;
		if (editorMode !== 'view' || !stagePlace) {
			lastAppliedFocusContextKey = '';
		} else if (focusContextKey !== lastAppliedFocusContextKey) {
			lastAppliedFocusContextKey = focusContextKey;
			const focusedPoi =
				$focusedMapPoiId ? allStagePois.find((poi) => poi.id === $focusedMapPoiId) || null : null;
			const nextLayerId =
				(focusedPoi?.layerId && stageMapLayers.some((layer) => layer.id === focusedPoi.layerId)
					? focusedPoi.layerId
					: null) ||
				($focusedMapLayerId && stageMapLayers.some((layer) => layer.id === $focusedMapLayerId)
					? $focusedMapLayerId
					: null);
			if (nextLayerId) {
				selectedLayerId = nextLayerId;
			}
			if (focusedPoi) {
				selectedPoiId = focusedPoi.id;
			}
		}
	}
	$: poiDisplayPreference = $mapDisplayPreferences.poiDisplayMode;
	$: mapBaseHeight = Math.max(
		340,
		Math.round(MAP_BASE_WIDTH * (customMapNaturalHeight / Math.max(customMapNaturalWidth, 1)))
	);
	$: editorDirty = editorMode !== 'view' && JSON.stringify(placeDraft) !== editorSnapshot;
	$: draftPlaceIdPreview = normalizeKey(placeDraft.id || placeDraft.name || 'draft-place');
	$: draftNeedsMapHint =
		editorMode !== 'view' &&
		placeDraft.mapLayers.length === 0 &&
		parseCoordinate(placeDraft.lat) == null &&
		parseCoordinate(placeDraft.lon) == null;
	$: draftValidationIssues = buildDraftValidationIssues(placeDraft);
	$: canSaveDraft =
		Boolean(placeDraft.name.trim()) &&
		draftValidationIssues.length === 0 &&
		!saveBusy &&
		!uploadBusy;

	$: if (stagePois.length === 0) {
		selectedPoiId = '';
	} else if (!stagePois.some((poi) => poi.id === selectedPoiId)) {
		selectedPoiId = stagePois[0].id;
	}
	$: selectedPoi = stagePois.find((poi) => poi.id === selectedPoiId) || null;

	$: if (placeDraft.pois.length === 0) {
		selectedDraftPoiIndex = -1;
		placingPoiIndex = -1;
	} else if (selectedDraftPoiIndex < 0 || selectedDraftPoiIndex >= placeDraft.pois.length) {
		selectedDraftPoiIndex = 0;
	}
	$: if (placeDraft.mapLayers.length === 0) {
		selectedDraftLayerIndex = -1;
	} else if (selectedDraftLayerIndex < 0 || selectedDraftLayerIndex >= placeDraft.mapLayers.length) {
		selectedDraftLayerIndex = 0;
	}
	$: selectedDraftLayer =
		selectedDraftLayerIndex >= 0 ? placeDraft.mapLayers[selectedDraftLayerIndex] || null : null;
	$: selectedDraftPoi =
		selectedDraftPoiIndex >= 0 ? placeDraft.pois[selectedDraftPoiIndex] || null : null;

	$: if (surfaceHasCustom) {
		if (surfaceMode !== 'custom' && !surfaceHasOsm) {
			surfaceMode = 'custom';
		}
	} else if (surfaceHasOsm) {
		surfaceMode = 'osm';
	} else {
		surfaceMode = 'custom';
	}

	$: {
		const resetKey = `${stagePlace?.id || 'none'}:${activeMapLayer?.id || 'none'}:${mapImageUrl || 'none'}:${surfaceMode}`;
		if (resetKey !== lastViewportResetKey) {
			lastViewportResetKey = resetKey;
			viewRotation = normalizeRotationDegrees(activeMapLayer?.rotation ?? stagePlace?.mapRotation ?? 0);
			void scheduleViewportReset();
		}
	}

	$: if (initialPlaceId && initialPlaceId !== lastRequestedInitialPlaceId) {
		lastRequestedInitialPlaceId = initialPlaceId;
		void focusInitialPlace(initialPlaceId);
	}

	onMount(() => {
		void detectAddonCapabilities();
		void hydrateWorkspace();
	});

	async function detectAddonCapabilities(): Promise<void> {
		modelViewerAvailable = await hasAddonCapability('model-viewer');
	}

	function rotatePoint(x: number, y: number, degrees: number): { x: number; y: number } {
		const radians = (degrees * Math.PI) / 180;
		const cosine = Math.cos(radians);
		const sine = Math.sin(radians);
		const centerX = MAP_BASE_WIDTH / 2;
		const centerY = mapBaseHeight / 2;
		const dx = x - centerX;
		const dy = y - centerY;
		return {
			x: dx * cosine - dy * sine + centerX,
			y: dx * sine + dy * cosine + centerY
		};
	}

	function mapPointToViewPoint(x: number, y: number): { x: number; y: number } {
		return rotatePoint(x, y, viewRotation);
	}

	function screenPointToMapPoint(pointerX: number, pointerY: number): { x: number; y: number } {
		const localX = (pointerX - mapPanX) / mapZoom;
		const localY = (pointerY - mapPanY) / mapZoom;
		return rotatePoint(localX, localY, -viewRotation);
	}

	function zoomViewportAroundPoint(nextZoom: number, pointerX: number, pointerY: number): void {
		const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
		const mapPoint = screenPointToMapPoint(pointerX, pointerY);
		mapZoom = clampedZoom;
		const rotatedPoint = mapPointToViewPoint(mapPoint.x, mapPoint.y);
		mapPanX = pointerX - rotatedPoint.x * clampedZoom;
		mapPanY = pointerY - rotatedPoint.y * clampedZoom;
	}

	function syncPrimaryLayerFields(): void {
		const primaryLayer = placeDraft.mapLayers[0] || null;
		const nextMapImageUrl = primaryLayer?.imageUrl || '';
		const nextMapRotation = primaryLayer?.rotation || '0';
		if (placeDraft.mapImageUrl === nextMapImageUrl && placeDraft.mapRotation === nextMapRotation) return;
		placeDraft = {
			...placeDraft,
			mapImageUrl: nextMapImageUrl,
			mapRotation: nextMapRotation
		};
	}

	function setEditorSnapshot(): void {
		editorSnapshot = JSON.stringify(placeDraft);
	}

	function seedEditorFromPlace(place: PlaceRecord | null): void {
		placeDraft = createPlaceDraft(place);
		selectedDraftLayerIndex = placeDraft.mapLayers.length > 0 ? 0 : -1;
		selectedLayerId = placeDraft.mapLayers[0]?.id || place?.mapLayers?.[0]?.id || '';
		selectedDraftPoiIndex = placeDraft.pois.length > 0 ? 0 : -1;
		placingPoiIndex = -1;
		setEditorSnapshot();
	}

	function maybeDiscardDraft(): boolean {
		if (!editorDirty) return true;
		return window.confirm('Discard unsaved map changes?');
	}

	async function hydrateWorkspace(): Promise<void> {
		loading = true;
		loadError = '';
		try {
			await loadPlaceRegistry(true);
			const focused = await ensureMapFocus(initialPlaceId);
			if (editorMode === 'view') {
				seedEditorFromPlace(focused);
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load map places';
		} finally {
			loading = false;
		}
	}

	async function focusInitialPlace(placeId: string | null): Promise<void> {
		try {
			await loadPlaceRegistry();
			const focused = await ensureMapFocus(placeId);
			if (editorMode === 'view') {
				seedEditorFromPlace(focused);
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to focus map place';
		}
	}
	async function selectPlace(place: PlaceRecord): Promise<void> {
		if (!maybeDiscardDraft()) return;
		loadError = '';
		try {
			await focusMapPlace(place.id);
			editorMode = 'view';
			seedEditorFromPlace(place);
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to open selected place';
		}
	}

	function getPlacePreviewUrl(place: PlaceRecord | null): string | null {
		if (!place) return null;
		const firstLayerImage =
			place.mapLayers.find((layer) => Boolean(resolvePlaceAssetUrl(layer.imageUrl)))?.imageUrl || null;
		return resolvePlaceAssetUrl(firstLayerImage || place.mapImageUrl || null);
	}

	function getEffectivePoiRenderMode(poi: PlacePoiRecord): PlacePoiRecord['renderMode'] {
		return resolvePoiRenderMode(poi.renderMode, poiDisplayPreference);
	}

	function getEffectivePoiThemePreset(poi: Pick<PlacePoiRecord, 'themePreset'>): PlacePoiThemePreset {
		return poi.themePreset || stagePlace?.poiThemePreset || 'classic';
	}

	function describeServerPoiTheme(poi: PlacePoiRecord): string {
		return formatServerPoiTheme(poi, stagePlace?.poiThemePreset || 'classic');
	}

	async function scheduleViewportReset(): Promise<void> {
		await tick();
		if (surfaceMode === 'custom' && mapImageUrl) {
			resetCustomMapView();
		}
	}

	function resetCustomMapView(): void {
		if (!customMapViewport) return;
		const rect = customMapViewport.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const fitZoom = Math.min(rect.width / MAP_BASE_WIDTH, rect.height / mapBaseHeight);
		mapZoom = Math.max(MIN_ZOOM, Math.min(Math.max(fitZoom, 0.55), 1.35));
		mapPanX = (rect.width - MAP_BASE_WIDTH * mapZoom) / 2;
		mapPanY = (rect.height - mapBaseHeight * mapZoom) / 2;
	}

	function handleCustomMapImageLoad(event: Event): void {
		const target = event.currentTarget as HTMLImageElement | null;
		if (!target) return;
		if (target.naturalWidth > 0 && target.naturalHeight > 0) {
			customMapNaturalWidth = target.naturalWidth;
			customMapNaturalHeight = target.naturalHeight;
		}
		resetCustomMapView();
	}

	function handleViewportWheel(event: WheelEvent): void {
		if (surfaceMode !== 'custom' || !customMapViewport) return;
		event.preventDefault();
		const rect = customMapViewport.getBoundingClientRect();
		const pointerX = event.clientX - rect.left;
		const pointerY = event.clientY - rect.top;
		zoomViewportAroundPoint(mapZoom * (event.deltaY < 0 ? 1.12 : 0.89), pointerX, pointerY);
	}

	function handleViewportMouseDown(event: MouseEvent): void {
		if (surfaceMode !== 'custom' || event.button !== 0) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('.poi-anchor') || target?.closest('.surface-toolbar')) return;
		isPanning = true;
		panStartX = event.clientX;
		panStartY = event.clientY;
		panOriginX = mapPanX;
		panOriginY = mapPanY;
		panMoved = false;
	}

	function handleWindowMouseMove(event: MouseEvent): void {
		if (!isPanning) return;
		const deltaX = event.clientX - panStartX;
		const deltaY = event.clientY - panStartY;
		if (!panMoved && Math.abs(deltaX) + Math.abs(deltaY) > 4) {
			panMoved = true;
		}
		mapPanX = panOriginX + deltaX;
		mapPanY = panOriginY + deltaY;
	}

	function handleWindowMouseUp(): void {
		if (!isPanning) return;
		isPanning = false;
		if (panMoved) {
			suppressViewportClick = true;
		}
	}

	function handleViewportClick(event: MouseEvent): void {
		if (suppressViewportClick) {
			suppressViewportClick = false;
			return;
		}
		if (surfaceMode !== 'custom' || placingPoiIndex < 0 || !customMapViewport) return;
		const rect = customMapViewport.getBoundingClientRect();
		const pointerX = event.clientX - rect.left;
		const pointerY = event.clientY - rect.top;
		const mapPoint = screenPointToMapPoint(pointerX, pointerY);
		const x = clampNormalized(mapPoint.x / MAP_BASE_WIDTH);
		const y = clampNormalized(mapPoint.y / mapBaseHeight);
		updateDraftPoiField(placingPoiIndex, 'x', x.toFixed(4));
		updateDraftPoiField(placingPoiIndex, 'y', y.toFixed(4));
		selectedDraftPoiIndex = placingPoiIndex;
		placingPoiIndex = -1;
	}

	function handleViewportKeydown(event: KeyboardEvent): void {
		if (surfaceMode !== 'custom' || !customMapViewport) return;
		const rect = customMapViewport.getBoundingClientRect();
		const centerX = rect.width / 2;
		const centerY = rect.height / 2;
		const panStep = Math.max(24, Math.round(36 + mapZoom * 18));

		switch (event.key) {
			case 'ArrowLeft':
				event.preventDefault();
				mapPanX -= panStep;
				return;
			case 'ArrowRight':
				event.preventDefault();
				mapPanX += panStep;
				return;
			case 'ArrowUp':
				event.preventDefault();
				mapPanY -= panStep;
				return;
			case 'ArrowDown':
				event.preventDefault();
				mapPanY += panStep;
				return;
			case '+':
			case '=':
				event.preventDefault();
				zoomViewportAroundPoint(mapZoom * 1.12, centerX, centerY);
				return;
			case '-':
			case '_':
				event.preventDefault();
				zoomViewportAroundPoint(mapZoom * 0.89, centerX, centerY);
				return;
			case '0':
				event.preventDefault();
				resetCustomMapView();
				return;
			case '[':
				event.preventDefault();
				rotateView(-15);
				return;
			case ']':
				event.preventDefault();
				rotateView(15);
				return;
			case 'n':
			case 'N':
				event.preventDefault();
				resetNorth();
				return;
			default:
				return;
		}
	}

	function rotateView(deltaDegrees: number): void {
		viewRotation = normalizeRotationDegrees(viewRotation + deltaDegrees);
	}

	function resetNorth(): void {
		viewRotation = 0;
	}

	function syncDraftRotationToView(): void {
		if (selectedDraftLayerIndex >= 0) {
			updateDraftMapLayerField(selectedDraftLayerIndex, 'rotation', String(viewRotation));
			return;
		}
		updateDraftField('mapRotation', String(viewRotation));
	}

	function beginNewPlace(): void {
		if (!maybeDiscardDraft()) return;
		editorMode = 'new';
		placeDraft = createEmptyPlaceDraft();
		selectedDraftLayerIndex = -1;
		selectedLayerId = '';
		selectedDraftPoiIndex = -1;
		placingPoiIndex = -1;
		setEditorSnapshot();
	}

	function beginEditingCurrentPlace(): void {
		if (!activePlace) return;
		if (!maybeDiscardDraft()) return;
		editorMode = 'edit';
		seedEditorFromPlace(activePlace);
	}

	async function startQuickMapUpload(): Promise<void> {
		if (!canManagePlaces) return;
		if (editorMode === 'view') {
			if (activePlace) {
				beginEditingCurrentPlace();
			} else {
				beginNewPlace();
			}
		}
		if (editorMode === 'view') return;
		if (selectedDraftLayerIndex < 0) {
			addDraftMapLayer();
			await tick();
		}
		surfaceMode = 'custom';
		triggerMapUploadPicker();
	}

	async function startQuickOsmSetup(): Promise<void> {
		if (!canManagePlaces) return;
		if (editorMode === 'view') {
			if (activePlace) {
				beginEditingCurrentPlace();
			} else {
				beginNewPlace();
			}
		}
		if (editorMode === 'view') return;
		surfaceMode = 'osm';
		await tick();
		latitudeInput?.focus();
		latitudeInput?.select();
	}

	function cancelEditing(): void {
		if (!maybeDiscardDraft()) return;
		editorMode = 'view';
		seedEditorFromPlace(activePlace);
	}

	async function saveCurrentPlace(): Promise<void> {
		if (!canManagePlaces || saveBusy) return;
		if (!placeDraft.name.trim()) {
			loadError = 'Place name is required.';
			return;
		}
		saveBusy = true;
		loadError = '';
		try {
			await savePlaceDraft(placeDraft);
			const targetId = normalizeKey(placeDraft.id || placeDraft.name);
			await focusMapPlace(targetId);
			editorMode = 'view';
			await loadPlaceRegistry(true);
			seedEditorFromPlace($focusedMapPlace || null);
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to save place';
		} finally {
			saveBusy = false;
		}
	}

	async function deleteCurrentPlaceRecord(): Promise<void> {
		if (!canManagePlaces || deleteBusy || !activePlace) return;
		if (!window.confirm(`Delete ${activePlace.name}? This removes the place and its custom map upload.`)) {
			return;
		}
		deleteBusy = true;
		loadError = '';
		try {
			await deletePlace(activePlace.id);
			editorMode = 'view';
			await loadPlaceRegistry(true);
			const nextFocus = await ensureMapFocus(null);
			seedEditorFromPlace(nextFocus);
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to delete place';
		} finally {
			deleteBusy = false;
		}
	}

	function updateDraftField(field: keyof PlaceDraft, value: string): void {
		placeDraft = { ...placeDraft, [field]: value };
	}

	function addDraftMapLayer(): void {
		const nextLayer = createEmptyMapLayerDraft();
		const nextLayers = [...placeDraft.mapLayers, nextLayer];
		placeDraft = { ...placeDraft, mapLayers: nextLayers };
		selectedDraftLayerIndex = nextLayers.length - 1;
		syncPrimaryLayerFields();
	}

	function duplicateDraftMapLayer(index: number): void {
		const target = placeDraft.mapLayers[index];
		if (!target) return;
		const copy: PlaceMapLayerDraft = {
			...target,
			id: `${target.id || `layer-${index + 1}`}-copy`,
			name: target.name ? `${target.name} Copy` : `Layer ${index + 2}`
		};
		const nextLayers = placeDraft.mapLayers.slice();
		nextLayers.splice(index + 1, 0, copy);
		placeDraft = { ...placeDraft, mapLayers: nextLayers };
		selectedDraftLayerIndex = index + 1;
		syncPrimaryLayerFields();
	}

	function updateDraftMapLayerField(index: number, field: keyof PlaceMapLayerDraft, value: string): void {
		const nextLayers = placeDraft.mapLayers.slice();
		if (!nextLayers[index]) return;
		nextLayers[index] = { ...nextLayers[index], [field]: value };
		placeDraft = { ...placeDraft, mapLayers: nextLayers };
		if (index === selectedDraftLayerIndex) {
			selectedLayerId = normalizeKey(nextLayers[index].id || nextLayers[index].name || nextLayers[index].floor || '');
		}
		syncPrimaryLayerFields();
	}

	function removeDraftMapLayer(index: number): void {
		const target = placeDraft.mapLayers[index];
		if (!target) return;
		if (!window.confirm(`Remove map layer ${target.name || `#${index + 1}`}?`)) return;
		const removedLayerId = normalizeKey(target.id || target.name || target.floor || '');
		const nextLayers = placeDraft.mapLayers.slice();
		nextLayers.splice(index, 1);
		const nextPois = placeDraft.pois.map((poi) =>
			normalizeKey(poi.layerId) === removedLayerId ? { ...poi, layerId: '' } : poi
		);
		placeDraft = { ...placeDraft, mapLayers: nextLayers, pois: nextPois };
		selectedDraftLayerIndex = nextLayers.length === 0 ? -1 : Math.min(index, nextLayers.length - 1);
		selectedLayerId =
			selectedDraftLayerIndex >= 0
				? normalizeKey(
						nextLayers[selectedDraftLayerIndex].id ||
						nextLayers[selectedDraftLayerIndex].name ||
						nextLayers[selectedDraftLayerIndex].floor ||
						''
					)
				: '';
		syncPrimaryLayerFields();
	}

	function selectDraftMapLayer(index: number): void {
		selectedDraftLayerIndex = index;
		const target = placeDraft.mapLayers[index];
		selectedLayerId = normalizeKey(target?.id || target?.name || target?.floor || '');
	}

	function addDraftPoi(): void {
		const nextPoi = createEmptyPoiDraft();
		if (selectedDraftLayer) {
			nextPoi.layerId = normalizeKey(selectedDraftLayer.id || selectedDraftLayer.name || selectedDraftLayer.floor || '');
		}
		const nextPois = [...placeDraft.pois, nextPoi];
		placeDraft = { ...placeDraft, pois: nextPois };
		selectedDraftPoiIndex = nextPois.length - 1;
		placingPoiIndex = nextPois.length - 1;
	}

	function duplicateDraftPoi(index: number): void {
		const target = placeDraft.pois[index];
		if (!target) return;
		const copy: PlacePoiDraft = {
			...target,
			id: `${target.id || `poi-${index + 1}`}-copy`,
			name: target.name ? `${target.name} Copy` : `POI ${index + 2}`
		};
		const nextPois = placeDraft.pois.slice();
		nextPois.splice(index + 1, 0, copy);
		placeDraft = { ...placeDraft, pois: nextPois };
		selectedDraftPoiIndex = index + 1;
		placingPoiIndex = -1;
	}

	function updateDraftPoiField(index: number, field: keyof PlacePoiDraft, value: string): void {
		const nextPois = placeDraft.pois.slice();
		if (!nextPois[index]) return;
		nextPois[index] = { ...nextPois[index], [field]: value };
		placeDraft = { ...placeDraft, pois: nextPois };
	}
	function removeDraftPoi(index: number): void {
		const target = placeDraft.pois[index];
		if (!target) return;
		if (!window.confirm(`Remove POI ${target.name || `#${index + 1}`}?`)) return;
		const nextPois = placeDraft.pois.slice();
		nextPois.splice(index, 1);
		placeDraft = { ...placeDraft, pois: nextPois };
		selectedDraftPoiIndex = nextPois.length === 0 ? -1 : Math.min(index, nextPois.length - 1);
		if (placingPoiIndex === index) {
			placingPoiIndex = -1;
		} else if (placingPoiIndex > index) {
			placingPoiIndex -= 1;
		}
	}

	function startPoiPlacement(index: number): void {
		selectedDraftPoiIndex = index;
		if (selectedDraftLayer) {
			updateDraftPoiField(
				index,
				'layerId',
				normalizeKey(selectedDraftLayer.id || selectedDraftLayer.name || selectedDraftLayer.floor || '')
			);
			selectedLayerId = normalizeKey(selectedDraftLayer.id || selectedDraftLayer.name || selectedDraftLayer.floor || '');
		}
		placingPoiIndex = index;
		if (surfaceMode !== 'custom') {
			surfaceMode = 'custom';
		}
	}

	function cancelPoiPlacement(): void {
		placingPoiIndex = -1;
	}

	function clearMapImage(): void {
		if (selectedDraftLayerIndex >= 0) {
			updateDraftMapLayerField(selectedDraftLayerIndex, 'imageUrl', '');
		}
		placingPoiIndex = -1;
	}

	function triggerMapUploadPicker(): void {
		mapUploadInput?.click();
	}

	async function handleMapUploadChange(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement | null;
		const file = input?.files?.[0];
		if (!file) return;
		await uploadMapImage(file);
		if (input) {
			input.value = '';
		}
	}

	async function uploadMapImage(file: File): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			loadError = 'You must be logged in as owner/admin to upload map art.';
			return;
		}
		uploadBusy = true;
		loadError = '';
		try {
			const formData = new FormData();
			formData.append('file', file);
			const response = await fetch(`${getServerUrl()}/api/upload`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`
				},
				body: formData
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload?.fileUrl) {
				throw new Error(payload?.error || `Map upload failed (${response.status})`);
			}
			if (selectedDraftLayerIndex < 0) {
				addDraftMapLayer();
				await tick();
			}
			const targetIndex =
				selectedDraftLayerIndex >= 0 ? selectedDraftLayerIndex : Math.max(placeDraft.mapLayers.length - 1, 0);
			updateDraftMapLayerField(targetIndex, 'imageUrl', String(payload.fileUrl));
			surfaceMode = 'custom';
			await tick();
			resetCustomMapView();
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to upload map image';
		} finally {
			uploadBusy = false;
		}
	}

	function selectPoi(poiId: string): void {
		const targetPoi = allStagePois.find((poi) => poi.id === poiId) || null;
		if (targetPoi?.layerId && stageMapLayers.some((layer) => layer.id === targetPoi.layerId)) {
			selectedLayerId = targetPoi.layerId;
		}
		selectedPoiId = poiId;
	}

	function openPlaceModelViewport(): void {
		if (!modelUrl || !stagePlace) return;
		const preferredName = stagePlace.modelUrl
			? stagePlace.modelUrl.split('/').pop() || `${stagePlace.name} 3D`
			: `${stagePlace.name} 3D`;
		openModelViewport(modelUrl, preferredName);
	}
</script>

<svelte:window on:mousemove={handleWindowMouseMove} on:mouseup={handleWindowMouseUp} />

<div class="map-workspace {variant}">
	{#if !isCompactLayout}
	<MapPlaceSidebar
		{variant}
		{searchQuery}
		{loading}
		{loadError}
		{canManagePlaces}
		{visiblePlaces}
		{activePlace}
		{editorMode}
		{normalizedQuery}
		on:refresh={() => void hydrateWorkspace()}
		on:searchChange={(event) => (searchQuery = event.detail)}
		on:newPlace={beginNewPlace}
		on:editPlace={beginEditingCurrentPlace}
		on:selectPlace={(event) => void selectPlace(event.detail)}
	/>
	{/if}

	<div class="map-stage">
		{#if isCompactLayout}
			<MapCompactToolbar
				{searchQuery}
				{compactPlaceSuggestions}
				{activePlace}
				{editorMode}
				{normalizedQuery}
				on:searchChange={(event) => (searchQuery = event.detail)}
				on:selectPlace={(event) => void selectPlace(event.detail)}
			/>
		{/if}
		{#if stagePlace}
			{#if !isCompactLayout}
				<MapPlaceHeader
					{stagePlace}
					{stageMapLayers}
					{allStagePois}
					{surfaceHasCustom}
					{surfaceHasOsm}
					{surfaceMode}
					{canManagePlaces}
					{uploadBusy}
					{externalUrl}
					{modelUrl}
					{modelViewerAvailable}
					{selectedLayerId}
					{poiDisplayPreference}
					{activeMapLayer}
					{stagePois}
					{isCompactLayout}
					{variant}
					on:startQuickMapUpload={() => void startQuickMapUpload()}
					on:startQuickOsmSetup={() => void startQuickOsmSetup()}
					on:openPlaceModelViewport={openPlaceModelViewport}
					on:changeSurfaceMode={(event) => (surfaceMode = event.detail)}
					on:changeLayerId={(event) => (selectedLayerId = event.detail)}
					on:changePoiDisplayPreference={(event) =>
						setMapPoiDisplayPreference(event.detail)}
				/>
			{:else}
				<div class="compact-stage-toolbar">
					<div class="compact-stage-summary">
						<strong>{stagePlace.name}</strong>
						<span>{stageMapLayers.length || (stagePlace.mapImageUrl ? 1 : 0)} layer{(stageMapLayers.length || (stagePlace.mapImageUrl ? 1 : 0)) === 1 ? '' : 's'}{#if allStagePois.length > 0} | {allStagePois.length} POI{allStagePois.length === 1 ? '' : 's'}{/if}</span>
					</div>
					<div class="compact-stage-controls">
						{#if stageMapLayers.length > 1}
							<label class="display-mode-field compact-display-mode-field">
								<span>Layer</span>
								<select value={selectedLayerId} on:change={(event) => (selectedLayerId = (event.currentTarget as HTMLSelectElement).value)}>
									{#each stageMapLayers as layer (layer.id)}
										<option value={layer.id}>{layer.name}{layer.floor ? ` | Floor ${layer.floor}` : ''}</option>
									{/each}
								</select>
							</label>
						{/if}
						{#if surfaceHasCustom && surfaceHasOsm}
							<div class="surface-toggle" role="tablist" aria-label="Map surface selector">
								<button type="button" class:active={surfaceMode === 'custom'} on:click={() => (surfaceMode = 'custom')}>Custom</button>
								<button type="button" class:active={surfaceMode === 'osm'} on:click={() => (surfaceMode = 'osm')}>OSM</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<div class="stage-grid">
				<div class="map-panel">
					{#if surfaceMode === 'custom' && mapImageUrl}
						<div class="surface-toolbar">
							<div class="surface-status">
								<span>Zoom {Math.round(mapZoom * 100)}%</span>
								<span>Rotation {viewRotation.toFixed(0)} deg</span>
								{#if placingPoiIndex >= 0}
									<span class="placing-status">Placing {placeDraft.pois[placingPoiIndex]?.name || 'POI'}...</span>
								{/if}
							</div>
							<div class="surface-buttons">
								<button class="ghost-button" type="button" on:click={() => rotateView(-15)}>Rotate Left</button>
								<button class="ghost-button" type="button" on:click={() => rotateView(15)}>Rotate Right</button>
								<button class="ghost-button" type="button" on:click={resetNorth} disabled={viewRotation === 0}>North</button>
								<button class="ghost-button" type="button" on:click={resetCustomMapView}>Reset View</button>
								{#if placingPoiIndex >= 0}
									<button class="ghost-button danger" type="button" on:click={cancelPoiPlacement}>Cancel Placement</button>
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
							aria-label={`Interactive map for ${stagePlace.name}. Use arrow keys to pan, plus or minus to zoom, bracket keys to rotate, and N to reset north.`}
							on:wheel|preventDefault={handleViewportWheel}
							on:mousedown={handleViewportMouseDown}
							on:click={handleViewportClick}
							on:keydown={handleViewportKeydown}
						>
							<div class="custom-map-content" style={`width:${MAP_BASE_WIDTH}px;height:${mapBaseHeight}px;transform: translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom});`}>
								<div class="rotated-map-layer" style={`transform: rotate(${viewRotation}deg);`}>
									<img class="custom-map-image" src={mapImageUrl} alt={`Map reference for ${stagePlace.name}`} on:load={handleCustomMapImageLoad} />
									{#each stagePois as poi (poi.id)}
										<button type="button" class="poi-anchor" data-poi-theme={getEffectivePoiThemePreset(poi)} class:active={selectedPoi?.id === poi.id} style={`left:${poi.x * 100}%;top:${poi.y * 100}%;--poi-color:${poi.iconColor || '#78b4ff'}`} title={poi.name} on:click|stopPropagation={() => selectPoi(poi.id)}>
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
						<iframe title={`Map for ${stagePlace.name}`} src={embedUrl} loading="lazy"></iframe>
					{:else}
						<div class="visual-fallback">
							{#if canManagePlaces}
								<div class="visual-fallback-card">
									<h4>No map surface yet</h4>
									<p>Upload custom map art for floorplans or add coordinates for OpenStreetMap.</p>
									<div class="surface-buttons visual-fallback-actions">
										<button class="ghost-button" type="button" on:click={() => void startQuickMapUpload()} disabled={uploadBusy}>
											{uploadBusy ? 'Uploading...' : 'Upload Custom Map'}
										</button>
										<button class="ghost-button" type="button" on:click={() => void startQuickOsmSetup()}>
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
								<strong>@{stagePlace.slug}</strong>
							</div>
							<div class="detail-stat">
								<span>Layers</span>
								<strong>{stageMapLayers.length || (stagePlace.mapImageUrl ? 1 : 0)}</strong>
							</div>
							<div class="detail-stat">
								<span>POI View</span>
								<strong>{formatPoiDisplayPreference(poiDisplayPreference)}</strong>
							</div>
							<div class="detail-stat">
								<span>POI Theme</span>
								<strong>{formatPoiThemePreset(stagePlace.poiThemePreset)}</strong>
							</div>
							<div class="detail-stat">
								<span>Rotation</span>
								<strong>{stagePlace.mapRotation.toFixed(0)} deg</strong>
							</div>
							<div class="detail-stat">
								<span>POIs</span>
								<strong>{stagePois.length}{stageMapLayers.length > 1 ? ` visible / ${allStagePois.length} total` : ''}</strong>
							</div>
							<div class="detail-stat detail-stat--wide">
								<span>Aliases</span>
								<strong>{stagePlace.aliases.length ? stagePlace.aliases.join(', ') : 'None'}</strong>
							</div>
							<div class="detail-stat detail-stat--wide">
								<span>Tags</span>
								<strong>{stagePlace.tags.length ? stagePlace.tags.join(', ') : 'None'}</strong>
							</div>
						</div>
					</div>

					{#if stagePois.length > 0}
						<div class="detail-card">
							<h4>Points of Interest</h4>
							<div class="poi-list">
								{#each stagePois as poi (poi.id)}
									<button type="button" class="poi-item" class:active={selectedPoi?.id === poi.id} on:click={() => selectPoi(poi.id)}>
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

					{#if canManagePlaces && variant !== 'compact'}
						<div class="detail-card editor-card">
							<div class="editor-header">
								<h4>{editorMode === 'new' ? 'New Place' : editorMode === 'edit' ? 'Edit Place' : 'Manage Place'}</h4>
								{#if editorMode !== 'view'}
									<span class="editor-status">{editorDirty ? 'Unsaved' : 'Saved locally'}</span>
								{/if}
							</div>

							{#if editorMode === 'view'}
								<div class="editor-actions">
									<button class="ghost-button" type="button" on:click={beginNewPlace}>New Place</button>
									<button class="ghost-button" type="button" on:click={beginEditingCurrentPlace} disabled={!activePlace}>Edit Current</button>
									<button class="ghost-button danger" type="button" on:click={() => void deleteCurrentPlaceRecord()} disabled={!activePlace || deleteBusy}>
										{deleteBusy ? 'Deleting...' : 'Delete'}
									</button>
								</div>
							{:else}
								<div class="editor-grid">
									<label><span>ID</span><input type="text" value={placeDraft.id} on:input={(event) => updateDraftField('id', (event.currentTarget as HTMLInputElement).value)} placeholder="canteen" /></label>
									<label><span>Name</span><input type="text" value={placeDraft.name} on:input={(event) => updateDraftField('name', (event.currentTarget as HTMLInputElement).value)} placeholder="Canteen" /></label>
									<label><span>Building</span><input type="text" value={placeDraft.building} on:input={(event) => updateDraftField('building', (event.currentTarget as HTMLInputElement).value)} /></label>
									<label><span>Floor</span><input type="text" value={placeDraft.floor} on:input={(event) => updateDraftField('floor', (event.currentTarget as HTMLInputElement).value)} /></label>
									<label><span>POI Theme</span><select value={placeDraft.poiThemePreset} on:change={(event) => updateDraftField('poiThemePreset', (event.currentTarget as HTMLSelectElement).value)}><option value="classic">Classic</option><option value="campus">Campus</option><option value="quest">Quest</option><option value="terminal">Terminal</option></select></label>
									<label><span>Latitude</span><input bind:this={latitudeInput} type="text" value={placeDraft.lat} on:input={(event) => updateDraftField('lat', (event.currentTarget as HTMLInputElement).value)} placeholder="13.7563" /></label>
									<label><span>Longitude</span><input type="text" value={placeDraft.lon} on:input={(event) => updateDraftField('lon', (event.currentTarget as HTMLInputElement).value)} placeholder="100.5018" /></label>
									<label class="wide"><span>Aliases</span><input type="text" value={placeDraft.aliases} on:input={(event) => updateDraftField('aliases', (event.currentTarget as HTMLInputElement).value)} placeholder="cafeteria, lunch hall" /></label>
									<label class="wide"><span>Tags</span><input type="text" value={placeDraft.tags} on:input={(event) => updateDraftField('tags', (event.currentTarget as HTMLInputElement).value)} placeholder="food, student-services" /></label>
									<label class="wide"><span>Model URL</span><input type="text" value={placeDraft.modelUrl} on:input={(event) => updateDraftField('modelUrl', (event.currentTarget as HTMLInputElement).value)} placeholder="/uploads/model.glb" /></label>
									<label class="wide"><span>Description</span><textarea rows="3" value={placeDraft.description} on:input={(event) => updateDraftField('description', (event.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
								</div>
								<div class="draft-meta-note">
									<div><strong>Slug preview</strong><span>@{draftPlaceIdPreview}</span></div>
									{#if !placeDraft.name.trim()}
										<div><strong>Save blocked</strong><span>Add a place name before saving.</span></div>
									{:else if draftNeedsMapHint}
										<div><strong>Map hint</strong><span>Add coordinates or upload a layer so this place opens somewhere useful.</span></div>
									{/if}
									{#if draftValidationIssues.length > 0}
										<div><strong>Validation</strong><span>{draftValidationIssues[0]}</span></div>
									{/if}
								</div>
								{#if draftValidationIssues.length > 1}
									<div class="state-message error">
										{#each draftValidationIssues.slice(1) as issue}
											<div>{issue}</div>
										{/each}
									</div>
								{/if}

								<div class="detail-card nested-card poi-editor-card">
									<div class="editor-header">
										<h4>Map Layers</h4>
										<button class="ghost-button" type="button" on:click={addDraftMapLayer}>Add Layer</button>
									</div>
									<input bind:this={mapUploadInput} class="hidden-input" type="file" accept="image/*" on:change={handleMapUploadChange} />
									{#if placeDraft.mapLayers.length === 0}
										<p class="state-message">No custom layers yet. Add one to support floors or alternate map views.</p>
									{:else}
										<div class="poi-editor-list">
											{#each placeDraft.mapLayers as layer, index}
												<div class="poi-editor-item" class:active={selectedDraftLayerIndex === index}>
													<button type="button" class="poi-editor-select" on:click={() => selectDraftMapLayer(index)}>
														<strong>{layer.name || layer.floor || `Layer ${index + 1}`}</strong>
														<small>{layer.floor || (layer.imageUrl ? 'Custom art ready' : 'No image yet')}</small>
													</button>
													<div class="poi-editor-actions">
														<button class="ghost-button" type="button" on:click={() => duplicateDraftMapLayer(index)}>Duplicate</button>
														<button class="ghost-button danger" type="button" on:click={() => removeDraftMapLayer(index)}>Remove</button>
													</div>
												</div>
											{/each}
										</div>
									{/if}

									{#if selectedDraftLayer}
										<div class="editor-grid poi-grid">
											<label><span>Layer ID</span><input type="text" value={selectedDraftLayer.id} on:input={(event) => updateDraftMapLayerField(selectedDraftLayerIndex, 'id', (event.currentTarget as HTMLInputElement).value)} placeholder="floor-1" /></label>
											<label><span>Name</span><input type="text" value={selectedDraftLayer.name} on:input={(event) => updateDraftMapLayerField(selectedDraftLayerIndex, 'name', (event.currentTarget as HTMLInputElement).value)} placeholder="First Floor" /></label>
											<label><span>Floor</span><input type="text" value={selectedDraftLayer.floor} on:input={(event) => updateDraftMapLayerField(selectedDraftLayerIndex, 'floor', (event.currentTarget as HTMLInputElement).value)} placeholder="1" /></label>
											<label><span>Rotation</span><input type="text" value={selectedDraftLayer.rotation} on:input={(event) => updateDraftMapLayerField(selectedDraftLayerIndex, 'rotation', (event.currentTarget as HTMLInputElement).value)} placeholder="0" /></label>
											<label class="wide"><span>Layer Image URL</span><input type="text" value={selectedDraftLayer.imageUrl} on:input={(event) => updateDraftMapLayerField(selectedDraftLayerIndex, 'imageUrl', (event.currentTarget as HTMLInputElement).value)} placeholder="/uploads/map-floor-1.png" /></label>
										</div>

										<div class="upload-row">
											<button class="ghost-button" type="button" on:click={triggerMapUploadPicker} disabled={uploadBusy}>{uploadBusy ? 'Uploading...' : 'Upload Layer Art'}</button>
											<button class="ghost-button" type="button" on:click={clearMapImage} disabled={!selectedDraftLayer.imageUrl}>Clear Layer Art</button>
											<button class="ghost-button" type="button" on:click={syncDraftRotationToView}>Use View Angle</button>
										</div>
									{/if}
								</div>

								<div class="detail-card nested-card poi-editor-card">
									<div class="editor-header">
										<h4>POI Editor</h4>
										<button class="ghost-button" type="button" on:click={addDraftPoi}>Add POI</button>
									</div>
									{#if placeDraft.pois.length === 0}
										<p class="state-message">No POIs in this place yet.</p>
									{:else}
										<div class="poi-editor-list">
											{#each placeDraft.pois as poi, index}
												<div class="poi-editor-item" class:active={selectedDraftPoiIndex === index}>
													<button type="button" class="poi-editor-select" on:click={() => (selectedDraftPoiIndex = index)}>
														<strong>{poi.name || `POI ${index + 1}`}</strong>
														<small>{poi.layerId || 'All layers'} | {poi.x && poi.y ? `${poi.x}, ${poi.y}` : 'Unplaced'}</small>
													</button>
													<div class="poi-editor-actions">
														<button class="ghost-button" type="button" on:click={() => startPoiPlacement(index)} disabled={!selectedDraftLayer || !selectedDraftLayer.imageUrl}>Place</button>
														<button class="ghost-button" type="button" on:click={() => duplicateDraftPoi(index)}>Duplicate</button>
														<button class="ghost-button danger" type="button" on:click={() => removeDraftPoi(index)}>Remove</button>
													</div>
												</div>
											{/each}
										</div>

										{#if selectedDraftPoi}
											<div class="editor-grid poi-grid">
												<label><span>POI ID</span><input type="text" value={selectedDraftPoi.id} on:input={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'id', (event.currentTarget as HTMLInputElement).value)} /></label>
												<label><span>Name</span><input type="text" value={selectedDraftPoi.name} on:input={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'name', (event.currentTarget as HTMLInputElement).value)} /></label>
												<label><span>X</span><input type="text" value={selectedDraftPoi.x} on:input={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'x', (event.currentTarget as HTMLInputElement).value)} /></label>
												<label><span>Y</span><input type="text" value={selectedDraftPoi.y} on:input={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'y', (event.currentTarget as HTMLInputElement).value)} /></label>
												<label><span>Layer</span><select value={selectedDraftPoi.layerId} on:change={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'layerId', (event.currentTarget as HTMLSelectElement).value)}><option value="">All Layers / Legacy</option>{#each placeDraft.mapLayers as layer, index}<option value={layer.id || layer.name || `layer-${index + 1}`}>{layer.name || layer.floor || `Layer ${index + 1}`}</option>{/each}</select></label>
												<label><span>Mode</span><select value={selectedDraftPoi.renderMode} on:change={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'renderMode', (event.currentTarget as HTMLSelectElement).value)}><option value="label">Label</option><option value="pin">Pin</option><option value="both">Both</option></select></label>
												<label><span>Theme</span><select value={selectedDraftPoi.themePreset} on:change={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'themePreset', (event.currentTarget as HTMLSelectElement).value)}><option value="">Place Default</option><option value="classic">Classic</option><option value="campus">Campus</option><option value="quest">Quest</option><option value="terminal">Terminal</option></select></label>
												<label><span>Icon Preset</span><select value={selectedDraftPoi.iconPreset} on:change={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'iconPreset', (event.currentTarget as HTMLSelectElement).value)}><option value="pin">Pin</option><option value="star">Star</option><option value="door">Door</option><option value="food">Food</option><option value="meeting">Meeting</option><option value="warning">Warning</option><option value="vendor">Vendor</option><option value="boss">Boss</option><option value="info">Info</option></select></label>
												<label><span>Icon</span><input type="text" value={selectedDraftPoi.iconGlyph} on:input={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'iconGlyph', (event.currentTarget as HTMLInputElement).value)} placeholder="*" /></label>
												<label><span>Color</span><input type="color" value={selectedDraftPoi.iconColor || '#78b4ff'} on:input={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'iconColor', (event.currentTarget as HTMLInputElement).value)} /></label>
												<label class="wide"><span>Description</span><textarea rows="2" value={selectedDraftPoi.description} on:input={(event) => updateDraftPoiField(selectedDraftPoiIndex, 'description', (event.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
											</div>
										{/if}
									{/if}
								</div>

								<div class="editor-actions final-actions">
									<button class="ghost-button" type="button" on:click={cancelEditing}>Cancel</button>
									<button class="ghost-button" type="button" on:click={() => void saveCurrentPlace()} disabled={!canSaveDraft}>{saveBusy ? 'Saving...' : 'Save Place'}</button>
									{#if editorMode === 'edit' && activePlace}
										<button class="ghost-button danger" type="button" on:click={() => void deleteCurrentPlaceRecord()} disabled={deleteBusy}>{deleteBusy ? 'Deleting...' : 'Delete'}</button>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
				</div>
				{/if}
			</div>
		{:else}
			<MapEmptyStage {isCompactLayout} {canManagePlaces} on:newPlace={beginNewPlace} />
		{/if}
	</div>
</div>

