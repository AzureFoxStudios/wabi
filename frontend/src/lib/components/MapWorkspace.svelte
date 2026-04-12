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
		type PlaceMapLayerRecord,
		type PlacePoiDraft,
		type PlacePoiIconPreset,
		type PlacePoiThemePreset,
		type PlacePoiRecord,
		type PlaceRecord
	} from '$lib/placeRegistry';

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
	$: draftPreviewPlace = buildDraftPreview(placeDraft);
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

	function normalizeKey(value: string): string {
		return value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}

	function splitCsvInput(value: string): string[] {
		return value
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	function parseCoordinate(value: string): number | null {
		if (!value.trim()) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function clampNormalized(value: number): number {
		return Math.max(0, Math.min(1, value));
	}

	function buildDraftValidationIssues(draft: PlaceDraft): string[] {
		const issues: string[] = [];
		const layerIds = new Map<string, number[]>();
		const poiIds = new Map<string, number[]>();

		draft.mapLayers.forEach((layer, index) => {
			const normalized = normalizeKey(layer.id || layer.name || layer.floor || '');
			if (!normalized) {
				issues.push(`Layer ${index + 1} needs an ID, name, or floor.`);
				return;
			}
			layerIds.set(normalized, [...(layerIds.get(normalized) || []), index + 1]);
		});

		draft.pois.forEach((poi, index) => {
			const normalized = normalizeKey(poi.id || poi.name || '');
			if (!normalized) {
				issues.push(`POI ${index + 1} needs an ID or name.`);
				return;
			}
			poiIds.set(normalized, [...(poiIds.get(normalized) || []), index + 1]);
		});

		for (const [id, indexes] of layerIds.entries()) {
			if (indexes.length > 1) {
				issues.push(`Duplicate layer ID "${id}" on layers ${indexes.join(', ')}.`);
			}
		}
		for (const [id, indexes] of poiIds.entries()) {
			if (indexes.length > 1) {
				issues.push(`Duplicate POI ID "${id}" on POIs ${indexes.join(', ')}.`);
			}
		}

		return issues;
	}

	function normalizeRotationDegrees(value: number): number {
		const normalized = ((value % 360) + 360) % 360;
		return Number(normalized.toFixed(3));
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

	function draftPoiToRecord(draft: PlacePoiDraft): PlacePoiRecord | null {
		const name = draft.name.trim();
		const id = normalizeKey(draft.id || draft.name);
		const x = parseCoordinate(draft.x);
		const y = parseCoordinate(draft.y);
		if (!name || !id || x == null || y == null) return null;
		return {
			id,
			name,
			x: clampNormalized(x),
			y: clampNormalized(y),
			layerId: normalizeKey(draft.layerId) || null,
			description: draft.description.trim() || undefined,
			renderMode: draft.renderMode,
			themePreset: draft.themePreset || undefined,
			iconPreset: draft.iconPreset,
			iconGlyph: draft.iconGlyph.trim() || null,
			iconColor: draft.iconColor.trim() || null
		};
	}

	function draftMapLayerToRecord(draft: PlaceMapLayerDraft): PlaceMapLayerRecord | null {
		const imageUrl = draft.imageUrl.trim();
		if (!imageUrl) return null;
		const id = normalizeKey(draft.id || draft.name || draft.floor || 'map-layer');
		const name = draft.name.trim() || draft.floor.trim() || 'Map Layer';
		return {
			id,
			name,
			floor: draft.floor.trim() || undefined,
			imageUrl,
			rotation: normalizeRotationDegrees(parseCoordinate(draft.rotation) ?? 0)
		};
	}

	function buildDraftPreview(draft: PlaceDraft): PlaceRecord | null {
		if (editorMode === 'view' && !draft.name.trim() && !draft.id.trim()) {
			return null;
		}
		const id = normalizeKey(draft.id || draft.name || 'draft-place');
		const name = draft.name.trim() || 'Untitled Place';
		const mapLayers = draft.mapLayers
			.map((layer) => draftMapLayerToRecord(layer))
			.filter((layer): layer is PlaceMapLayerRecord => Boolean(layer));
		const primaryLayer = mapLayers[0] || null;
		return {
			id,
			slug: id,
			name,
			aliases: splitCsvInput(draft.aliases),
			building: draft.building.trim() || undefined,
			floor: draft.floor.trim() || undefined,
			lat: parseCoordinate(draft.lat),
			lon: parseCoordinate(draft.lon),
			description: draft.description.trim() || undefined,
			modelUrl: draft.modelUrl.trim() || null,
			mapImageUrl: primaryLayer?.imageUrl || null,
			mapRotation: primaryLayer?.rotation ?? normalizeRotationDegrees(parseCoordinate(draft.mapRotation) ?? 0),
			poiThemePreset: draft.poiThemePreset,
			mapLayers,
			pois: draft.pois.map((poi) => draftPoiToRecord(poi)).filter((poi): poi is PlacePoiRecord => Boolean(poi)),
			tags: splitCsvInput(draft.tags)
		};
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

	function formatMeta(place: PlaceRecord | null): string {
		if (!place) return 'No place selected';
		const parts: string[] = [];
		if (place.building) parts.push(place.building);
		if (place.floor) parts.push(`Floor ${place.floor}`);
		if (place.lat != null && place.lon != null) parts.push(`${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`);
		return parts.join(' - ') || `@${place.slug}`;
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

	function formatPoiThemePreset(preset: PlacePoiThemePreset): string {
		if (preset === 'campus') return 'Campus';
		if (preset === 'quest') return 'Quest';
		if (preset === 'terminal') return 'Terminal';
		return 'Classic';
	}

	function formatPoiIconPreset(preset: PlacePoiIconPreset): string {
		if (preset === 'star') return 'Star';
		if (preset === 'door') return 'Door';
		if (preset === 'food') return 'Food';
		if (preset === 'meeting') return 'Meeting';
		if (preset === 'warning') return 'Warning';
		if (preset === 'vendor') return 'Vendor';
		if (preset === 'boss') return 'Boss';
		if (preset === 'info') return 'Info';
		return 'Pin';
	}

	function resolvePoiMarkerGlyph(poi: Pick<PlacePoiRecord, 'iconGlyph' | 'iconPreset'>): string {
		if (poi.iconGlyph && poi.iconGlyph.trim()) {
			return poi.iconGlyph.trim();
		}
		switch (poi.iconPreset || 'pin') {
			case 'star':
				return '*';
			case 'door':
				return 'D';
			case 'food':
				return 'F';
			case 'meeting':
				return 'M';
			case 'warning':
				return '!';
			case 'vendor':
				return '$';
			case 'boss':
				return 'B';
			case 'info':
				return 'i';
			default:
				return '+';
		}
	}

	function describeServerPoiTheme(poi: PlacePoiRecord): string {
		if (poi.themePreset) {
			return formatPoiThemePreset(poi.themePreset);
		}
		return `Place default (${formatPoiThemePreset(stagePlace?.poiThemePreset || 'classic')})`;
	}

	function formatPoiDisplayPreference(mode: MapPoiDisplayPreference): string {
		if (mode === 'label') return 'Labels only';
		if (mode === 'pin') return 'Pins only';
		if (mode === 'both') return 'Labels + Pins';
		return 'Server default';
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
	<div class="map-sidebar">
		<div class="map-sidebar-header">
			<div>
				<h2>{variant === 'compact' ? 'Map' : 'Server Map'}</h2>
				<p>Places shared by this Wabi server.</p>
			</div>
			<button class="ghost-button" type="button" on:click={() => void hydrateWorkspace()} disabled={loading || $placeRegistryLoading}>
				{loading || $placeRegistryLoading ? 'Refreshing...' : 'Refresh'}
			</button>
		</div>

		<label class="search-field">
			<span>Search places</span>
			<input type="text" bind:value={searchQuery} placeholder="building, tag, alias..." />
		</label>

		{#if canManagePlaces && variant !== 'compact'}
			<div class="admin-actions">
				<button class="ghost-button" type="button" on:click={beginNewPlace}>New Place</button>
				{#if activePlace}
					<button class="ghost-button" type="button" on:click={beginEditingCurrentPlace}>Edit Place</button>
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

		{#if loading && $placeRegistry.length === 0}
			<p class="state-message">Loading map places...</p>
		{:else if visiblePlaces.length === 0}
			<div class="state-message">
				<div>{normalizedQuery ? 'No places match this search yet.' : 'No places have been configured yet.'}</div>
				{#if canManagePlaces && !normalizedQuery}
					<div class="admin-actions">
						<button class="ghost-button" type="button" on:click={beginNewPlace}>Create First Place</button>
					</div>
				{/if}
			</div>
		{:else}
			<div class="place-list" role="list">
				{#each visiblePlaces as place (place.id)}
					{@const placePreviewUrl = getPlacePreviewUrl(place)}
					<button type="button" class="place-item" class:active={activePlace?.id === place.id && editorMode === 'view'} on:click={() => void selectPlace(place)}>
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
	{/if}

	<div class="map-stage">
		{#if isCompactLayout}
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
								on:click={() => void selectPlace(place)}
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
						<span>{activePlace.description || formatMeta(activePlace)}</span>
					</div>
				{/if}
			</div>
		{/if}
		{#if stagePlace}
			{#if !isCompactLayout}
				<div class="place-header">
					<div class="place-heading">
						<div class="place-kicker">Map Place</div>
						<h3>{stagePlace.name}</h3>
						<p>{stagePlace.description || formatMeta(stagePlace)}</p>
						<div class="place-chip-row place-chip-row--hero">
							{#if stagePlace.building}
								<span class="place-chip">{stagePlace.building}</span>
							{/if}
							{#if stagePlace.floor}
								<span class="place-chip">Floor {stagePlace.floor}</span>
							{/if}
							<span class="place-chip">{stageMapLayers.length || (stagePlace.mapImageUrl ? 1 : 0)} layer{(stageMapLayers.length || (stagePlace.mapImageUrl ? 1 : 0)) === 1 ? '' : 's'}</span>
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
							<button class="ghost-button" type="button" on:click={() => void startQuickMapUpload()} disabled={uploadBusy}>
								{uploadBusy ? 'Uploading...' : 'Upload Custom Map'}
							</button>
						{/if}
						{#if canManagePlaces && !surfaceHasOsm}
							<button class="ghost-button" type="button" on:click={() => void startQuickOsmSetup()}>
								Add OSM Coordinates
							</button>
						{/if}
						{#if surfaceHasCustom && surfaceHasOsm}
							<div class="surface-toggle" role="tablist" aria-label="Map surface selector">
								<button type="button" class:active={surfaceMode === 'custom'} on:click={() => (surfaceMode = 'custom')}>Custom</button>
								<button type="button" class:active={surfaceMode === 'osm'} on:click={() => (surfaceMode = 'osm')}>OSM</button>
							</div>
						{/if}
						{#if externalUrl}
							<a class="ghost-button" href={externalUrl} target="_blank" rel="noreferrer noopener">Open External Map</a>
						{/if}
						{#if modelUrl}
							{#if modelViewerAvailable}
							<button class="ghost-button" type="button" on:click={openPlaceModelViewport}>Open 3D Tab</button>
							{/if}
							<a class="ghost-button" href={modelUrl} target="_blank" rel="noreferrer noopener">Open Model</a>
						{/if}
					</div>
				</div>

				{#if stagePlace.description}
					<p class="place-description">{stagePlace.description}</p>
				{/if}

				{#if stageMapLayers.length > 1 || stagePois.length > 0}
					<div class="display-preference-row">
						{#if stageMapLayers.length > 1}
							<label class="display-mode-field">
								<span>Map Layer</span>
								<select value={selectedLayerId} on:change={(event) => (selectedLayerId = (event.currentTarget as HTMLSelectElement).value)}>
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
										setMapPoiDisplayPreference(
											(event.currentTarget as HTMLSelectElement).value as MapPoiDisplayPreference
										)}
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
			<div class="empty-stage">
				<div class="empty-stage-copy">
					<h3>No place selected</h3>
					<p>{isCompactLayout ? 'Search for a place to open the server map.' : 'Choose a saved place from the list to open the server map.'}</p>
					{#if canManagePlaces}
						<div class="surface-buttons">
							<button class="ghost-button" type="button" on:click={beginNewPlace}>Create First Place</button>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
<style>
	.map-workspace {
		display: grid;
		grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
		height: 100%;
		min-height: 0;
		background:
			radial-gradient(circle at top left, rgba(82, 163, 255, 0.16), transparent 30%),
			linear-gradient(180deg, rgba(16, 22, 38, 0.96), rgba(10, 14, 24, 0.98));
		color: var(--text-primary, #eef3ff);
	}

	.map-workspace.compact {
		grid-template-columns: 1fr;
	}

	.map-workspace.detached {
		grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
	}

	.map-sidebar {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		padding: 1.05rem;
		border-right: 1px solid rgba(140, 167, 214, 0.16);
		background:
			linear-gradient(180deg, rgba(9, 13, 24, 0.82), rgba(9, 13, 24, 0.62)),
			rgba(9, 13, 24, 0.66);
		min-height: 0;
	}

	.map-sidebar-header,
	.place-header,
	.editor-header,
	.surface-toolbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.map-sidebar-header h2,
	.place-header h3,
	.editor-header h4,
	.detail-card h4 {
		margin: 0;
	}

	.map-sidebar-header p,
	.place-header p,
	.place-description,
	.selected-poi-card p {
		margin: 0.2rem 0 0;
		color: var(--text-secondary, #b0b8d0);
	}

	.place-list-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.2rem 0 0;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-secondary, #b0b8d0);
	}

	.place-list-header span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 2rem;
		height: 1.55rem;
		padding: 0 0.55rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(148, 163, 184, 0.16);
		color: var(--text-primary, #eef3ff);
		font-size: 0.74rem;
	}

	.display-preference-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.8rem 0.95rem;
		border: 1px solid rgba(148, 163, 184, 0.18);
		border-radius: 0.95rem;
		background: rgba(10, 16, 28, 0.56);
	}

	.display-mode-field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: var(--text-secondary, #b0b8d0);
	}

	.display-mode-field select {
		border: 1px solid rgba(148, 163, 184, 0.24);
		background: rgba(14, 20, 34, 0.82);
		color: inherit;
		border-radius: 0.75rem;
		padding: 0.7rem 0.8rem;
		min-width: 12rem;
	}

	.display-mode-note {
		color: var(--text-secondary, #b0b8d0);
	}

	.search-field,
	.editor-grid label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: var(--text-secondary, #b0b8d0);
	}

	.search-field input,
	.editor-grid input,
	.editor-grid textarea,
	.editor-grid select {
		border: 1px solid rgba(148, 163, 184, 0.24);
		background: rgba(14, 20, 34, 0.82);
		color: inherit;
		border-radius: 0.75rem;
		padding: 0.7rem 0.8rem;
	}

	.editor-grid textarea {
		resize: vertical;
		min-height: 76px;
	}

	.state-message {
		margin: 0;
		padding: 0.8rem 0.9rem;
		border-radius: 0.85rem;
		background: rgba(17, 24, 39, 0.74);
		color: var(--text-secondary, #b0b8d0);
	}

	.state-message.error {
		color: #ffd7e2;
		background: rgba(92, 18, 45, 0.44);
	}

	.draft-meta-note {
		display: grid;
		gap: 0.5rem;
		padding: 0.8rem 0.9rem;
		border: 1px solid rgba(148, 163, 184, 0.18);
		border-radius: 0.85rem;
		background: rgba(12, 18, 30, 0.66);
		color: var(--text-secondary, #b0b8d0);
		font-size: 0.82rem;
	}

	.draft-meta-note div {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.place-list,
	.poi-list,
	.poi-editor-list {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		overflow: auto;
		min-height: 0;
	}

	.place-item,
	.poi-item,
	.poi-editor-item {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		align-items: stretch;
		text-align: left;
		border: 1px solid rgba(148, 163, 184, 0.18);
		background: rgba(15, 21, 35, 0.78);
		color: inherit;
		border-radius: 0.95rem;
		padding: 0.8rem 0.85rem;
	}

	.place-item,
	.poi-item,
	.poi-editor-select {
		cursor: pointer;
	}

	.place-item {
		display: grid;
		grid-template-columns: 72px minmax(0, 1fr);
		align-items: stretch;
		gap: 0.8rem;
		padding: 0.75rem;
	}

	.place-item.active,
	.poi-item.active,
	.poi-editor-item.active {
		border-color: rgba(112, 197, 255, 0.5);
		background: rgba(25, 48, 79, 0.74);
		box-shadow: inset 0 0 0 1px rgba(122, 201, 255, 0.2);
	}

	.poi-item {
		width: 100%;
	}

	.place-copy,
	.poi-summary {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.place-copy {
		justify-content: center;
		min-width: 0;
	}

	.place-copy-heading {
		display: grid;
		gap: 0.18rem;
	}

	.place-thumb {
		width: 72px;
		height: 72px;
		border-radius: 16px;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
		background:
			linear-gradient(145deg, rgba(37, 99, 235, 0.22), rgba(45, 212, 191, 0.12)),
			rgba(15, 23, 42, 0.7);
		border: 1px solid rgba(148, 163, 184, 0.2);
		font-size: 1.35rem;
		font-weight: 800;
		color: #f8fafc;
	}

	.place-thumb.has-preview {
		background: rgba(15, 23, 42, 0.48);
	}

	.place-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.place-chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.38rem;
		margin-top: 0.45rem;
	}

	.place-chip {
		display: inline-flex;
		align-items: center;
		min-height: 1.5rem;
		padding: 0.12rem 0.5rem;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.18);
		background: rgba(255, 255, 255, 0.06);
		color: var(--text-secondary, #d6deef);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.place-chip-row--hero {
		margin-top: 0.72rem;
	}

	.place-copy small,
	.place-meta,
	.poi-item small,
	.editor-status,
	.surface-status,
	.placing-status {
		color: var(--text-secondary, #b0b8d0);
	}

	.admin-actions,
	.place-actions,
	.surface-buttons,
	.upload-row,
	.editor-actions,
	.poi-editor-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.map-stage {
		display: flex;
		flex-direction: column;
		gap: 0.95rem;
		padding: 1.05rem;
		min-width: 0;
		min-height: 0;
	}

	.map-workspace.compact .map-stage {
		gap: 0.75rem;
		padding: 0.9rem;
	}

	.compact-map-toolbar,
	.compact-stage-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.85rem 0.95rem;
		border: 1px solid rgba(148, 163, 184, 0.16);
		border-radius: 1rem;
		background:
			linear-gradient(145deg, rgba(17, 24, 39, 0.88), rgba(8, 13, 24, 0.8)),
			rgba(10, 16, 28, 0.82);
	}

	.compact-map-search {
		flex: 1 1 18rem;
		min-width: min(100%, 18rem);
	}

	.compact-place-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		width: 100%;
	}

	.compact-place-chip {
		border: 1px solid rgba(148, 163, 184, 0.2);
		border-radius: 999px;
		padding: 0.45rem 0.75rem;
		background: rgba(17, 24, 39, 0.72);
		color: var(--text-primary, #eef3ff);
		font-size: 0.82rem;
		cursor: pointer;
	}

	.compact-place-chip.active {
		border-color: rgba(122, 201, 255, 0.46);
		background: rgba(76, 138, 255, 0.26);
	}

	.compact-active-place,
	.compact-stage-summary {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}

	.compact-active-place span,
	.compact-stage-summary span,
	.compact-map-empty {
		color: var(--text-secondary, #b0b8d0);
		font-size: 0.82rem;
	}

	.compact-stage-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	.compact-display-mode-field {
		min-width: 10rem;
	}

	.stage-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.72fr) minmax(300px, 0.9fr);
		gap: 1rem;
		min-height: 0;
		flex: 1;
	}

	.map-workspace.compact .stage-grid {
		grid-template-columns: 1fr;
	}

	.map-panel,
	.detail-card,
	.empty-stage,
	.viewport-overlay {
		border: 1px solid rgba(148, 163, 184, 0.18);
		background: rgba(10, 16, 28, 0.82);
		border-radius: 1rem;
	}

	.map-panel {
		display: flex;
		flex-direction: column;
		min-height: 420px;
		overflow: hidden;
	}

	.place-header {
		padding: 1rem 1.05rem;
		border: 1px solid rgba(148, 163, 184, 0.16);
		border-radius: 1rem;
		background:
			linear-gradient(145deg, rgba(17, 24, 39, 0.9), rgba(8, 13, 24, 0.82)),
			rgba(10, 16, 28, 0.82);
	}

	.place-kicker {
		font-size: 0.72rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: rgba(125, 211, 252, 0.88);
	}

	.map-panel iframe {
		width: 100%;
		height: 100%;
		min-height: 420px;
		border: 0;
		display: block;
	}

	.detail-panel {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-height: 0;
	}

	.detail-card,
	.nested-card {
		padding: 1rem;
	}

	.detail-stat-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.7rem;
		margin-top: 0.9rem;
	}

	.detail-stat {
		display: grid;
		gap: 0.28rem;
		padding: 0.8rem 0.85rem;
		border-radius: 0.9rem;
		border: 1px solid rgba(148, 163, 184, 0.16);
		background: rgba(255, 255, 255, 0.04);
		min-width: 0;
	}

	.detail-stat span {
		color: var(--text-secondary, #b0b8d0);
		font-size: 0.74rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.detail-stat strong {
		min-width: 0;
		color: var(--text-primary, #eef3ff);
		font-size: 0.9rem;
		word-break: break-word;
	}

	.detail-stat--wide {
		grid-column: 1 / -1;
	}

	.detail-card ul {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.detail-card li {
		display: flex;
		justify-content: space-between;
		gap: 0.8rem;
		padding-bottom: 0.55rem;
		border-bottom: 1px solid rgba(148, 163, 184, 0.12);
	}
	.detail-card li:last-child {
		padding-bottom: 0;
		border-bottom: 0;
	}

	.detail-card span {
		color: var(--text-secondary, #b0b8d0);
		text-align: right;
	}

	.surface-toolbar {
		padding: 0.85rem 1rem;
		border-bottom: 1px solid rgba(148, 163, 184, 0.12);
	}

	.custom-map-viewport {
		position: relative;
		flex: 1;
		min-height: 420px;
		overflow: hidden;
		cursor: grab;
		background:
			linear-gradient(45deg, rgba(255, 255, 255, 0.03) 25%, transparent 25%),
			linear-gradient(-45deg, rgba(255, 255, 255, 0.03) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.03) 75%),
			linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.03) 75%),
			rgba(8, 12, 21, 0.9);
		background-size: 28px 28px;
		background-position: 0 0, 0 14px, 14px -14px, -14px 0;
	}

	.custom-map-viewport:focus-visible {
		outline: 2px solid rgba(122, 201, 255, 0.78);
		outline-offset: -2px;
	}

	.custom-map-content {
		position: absolute;
		top: 0;
		left: 0;
		transform-origin: top left;
		user-select: none;
	}

	.rotated-map-layer {
		position: relative;
		width: 100%;
		height: 100%;
		transform-origin: center center;
	}

	.custom-map-image {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: fill;
		pointer-events: none;
	}

	.poi-anchor {
		--poi-fill: color-mix(in srgb, var(--poi-color, #78b4ff) 34%, rgba(12, 19, 34, 0.94));
		--poi-border: color-mix(in srgb, var(--poi-color, #78b4ff) 72%, white 12%);
		--poi-label-bg: rgba(8, 12, 21, 0.88);
		--poi-label-border: rgba(148, 163, 184, 0.26);
		position: absolute;
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		transform: translate(-50%, -50%);
		border: 0;
		background: transparent;
		color: inherit;
		padding: 0;
	}

	.poi-pin,
	.poi-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		background: var(--poi-fill);
		border: 1px solid var(--poi-border);
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
	}

	.poi-label {
		padding: 0.35rem 0.6rem;
		border-radius: 999px;
		background: var(--poi-label-bg);
		border: 1px solid var(--poi-label-border);
		box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24);
		font-size: 0.82rem;
		white-space: nowrap;
	}

	.poi-anchor[data-poi-theme='campus'],
	.poi-badge[data-poi-theme='campus'] {
		--poi-fill: color-mix(in srgb, var(--poi-color, #54d7c1) 36%, rgba(12, 25, 28, 0.94));
		--poi-border: color-mix(in srgb, var(--poi-color, #54d7c1) 76%, white 16%);
		--poi-label-bg: rgba(7, 24, 28, 0.9);
		--poi-label-border: rgba(84, 215, 193, 0.42);
	}

	.poi-anchor[data-poi-theme='quest'],
	.poi-badge[data-poi-theme='quest'] {
		--poi-fill: color-mix(in srgb, var(--poi-color, #e8a541) 42%, rgba(28, 17, 7, 0.94));
		--poi-border: color-mix(in srgb, var(--poi-color, #e8a541) 80%, white 12%);
		--poi-label-bg: rgba(33, 20, 8, 0.9);
		--poi-label-border: rgba(232, 165, 65, 0.46);
	}

	.poi-anchor[data-poi-theme='terminal'],
	.poi-badge[data-poi-theme='terminal'] {
		--poi-fill: color-mix(in srgb, var(--poi-color, #7aff8b) 30%, rgba(5, 16, 8, 0.96));
		--poi-border: color-mix(in srgb, var(--poi-color, #7aff8b) 82%, white 8%);
		--poi-label-bg: rgba(4, 13, 8, 0.92);
		--poi-label-border: rgba(122, 255, 139, 0.5);
	}

	.poi-anchor[data-poi-theme='campus'] .poi-label {
		border-radius: 0.8rem;
	}

	.poi-anchor[data-poi-theme='quest'] .poi-pin,
	.poi-badge[data-poi-theme='quest'] {
		border-radius: 0.65rem;
	}

	.poi-anchor[data-poi-theme='terminal'] .poi-pin,
	.poi-badge[data-poi-theme='terminal'] {
		border-radius: 0.45rem;
	}

	.poi-anchor[data-poi-theme='terminal'] .poi-label {
		border-radius: 0.45rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.poi-anchor.active .poi-pin,
	.poi-anchor.active .poi-label {
		outline: 2px solid rgba(122, 201, 255, 0.68);
		outline-offset: 2px;
	}

	.viewport-overlay {
		position: absolute;
		left: 1rem;
		bottom: 1rem;
		padding: 0.55rem 0.75rem;
		background: rgba(8, 12, 21, 0.86);
		color: var(--text-secondary, #b0b8d0);
		pointer-events: none;
	}

	.viewport-overlay.place-hint {
		top: 1rem;
		bottom: auto;
		color: #fff7cb;
		background: rgba(80, 54, 6, 0.88);
	}

	.compass-overlay {
		position: absolute;
		top: 1rem;
		right: 1rem;
		pointer-events: none;
		opacity: 0.58;
	}

	.compass-rose {
		position: relative;
		width: 3.2rem;
		height: 3.2rem;
		border-radius: 999px;
		border: 1px solid rgba(191, 214, 254, 0.32);
		background: rgba(8, 12, 21, 0.76);
		box-shadow: 0 8px 18px rgba(0, 0, 0, 0.2);
	}

	.compass-arrow {
		position: absolute;
		left: 50%;
		top: 0.35rem;
		width: 0;
		height: 1.3rem;
		border-left: 2px solid transparent;
		border-right: 2px solid transparent;
		border-bottom: 1.1rem solid rgba(122, 201, 255, 0.92);
		transform-origin: 50% calc(100% - 0.05rem);
	}

	.compass-letter {
		position: absolute;
		left: 50%;
		bottom: 0.38rem;
		transform: translateX(-50%);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		color: rgba(224, 234, 255, 0.92);
	}

	.visual-fallback,
	.empty-stage {
		display: grid;
		place-items: center;
		min-height: 220px;
		padding: 1rem;
		text-align: center;
		color: var(--text-secondary, #b0b8d0);
	}

	.visual-fallback-card,
	.empty-stage-copy {
		display: grid;
		gap: 0.75rem;
		max-width: 28rem;
	}

	.visual-fallback-card h4,
	.visual-fallback-card p,
	.visual-fallback-card small,
	.empty-stage-copy h3,
	.empty-stage-copy p {
		margin: 0;
	}

	.visual-fallback-actions {
		justify-content: center;
	}

	.surface-toggle {
		display: inline-flex;
		border: 1px solid rgba(148, 163, 184, 0.22);
		border-radius: 999px;
		overflow: hidden;
	}

	.surface-toggle button,
	.poi-editor-select,
	.ghost-button {
		border: 0;
		background: rgba(17, 24, 39, 0.74);
		color: inherit;
	}

	.surface-toggle button {
		padding: 0.5rem 0.75rem;
	}

	.surface-toggle button.active {
		background: rgba(76, 138, 255, 0.34);
	}

	.ghost-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		border: 1px solid rgba(148, 163, 184, 0.24);
		border-radius: 999px;
		padding: 0.55rem 0.85rem;
		text-decoration: none;
		cursor: pointer;
	}

	.ghost-button.danger {
		border-color: rgba(244, 114, 182, 0.34);
		color: #ffd6e7;
	}

	.ghost-button:disabled,
	.surface-toggle button:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.editor-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8rem;
	}

	.editor-grid .wide,
	.poi-grid .wide {
		grid-column: 1 / -1;
	}
	.editor-card,
	.poi-editor-card {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.poi-editor-item {
		padding: 0.65rem 0.75rem;
	}

	.poi-editor-select {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0;
		text-align: left;
	}

	.selected-poi-card .poi-summary {
		flex-direction: row;
		align-items: center;
		gap: 0.8rem;
		margin-bottom: 0.8rem;
	}

	.hidden-input {
		display: none;
	}

	@media (max-width: 1120px) {
		.stage-grid {
			grid-template-columns: 1fr;
		}

		.detail-stat-grid {
			grid-template-columns: 1fr 1fr;
		}
	}

	@media (max-width: 960px) {
		.map-workspace,
		.map-workspace.detached {
			grid-template-columns: 1fr;
		}

		.map-sidebar {
			border-right: 0;
			border-bottom: 1px solid rgba(140, 167, 214, 0.16);
		}

		.place-item {
			grid-template-columns: 64px minmax(0, 1fr);
		}

		.place-thumb {
			width: 64px;
			height: 64px;
		}

		.editor-grid {
			grid-template-columns: 1fr;
		}

		.display-preference-row {
			align-items: stretch;
		}

		.detail-stat-grid {
			grid-template-columns: 1fr;
		}

		.display-mode-field select {
			min-width: 0;
			width: 100%;
		}

		.compact-map-toolbar,
		.compact-stage-toolbar {
			padding: 0.8rem;
		}

		.compact-map-search,
		.compact-display-mode-field {
			flex-basis: 100%;
			min-width: 0;
		}
	}
</style>

