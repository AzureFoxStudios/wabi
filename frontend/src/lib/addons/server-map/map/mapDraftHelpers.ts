
import { createEmptyMapLayerDraft, createEmptyPoiDraft } from '$lib/placeRegistry';
import type { PlaceDraft, PlaceMapLayerDraft, PlacePoiDraft } from '$lib/placeRegistry';
import { normalizeKey } from '../mapWorkspaceHelpers';

export function updateDraftField(draft: PlaceDraft, field: keyof PlaceDraft, value: string): PlaceDraft {
	return { ...draft, [field]: value };
}

export function addDraftMapLayer(draft: PlaceDraft): { draft: PlaceDraft; selectedLayerIndex: number } {
	const nextLayer = createEmptyMapLayerDraft();
	const nextLayers = [...draft.mapLayers, nextLayer];
	return { draft: { ...draft, mapLayers: nextLayers }, selectedLayerIndex: nextLayers.length - 1 };
}

export function duplicateDraftMapLayer(draft: PlaceDraft, index: number): { draft: PlaceDraft; selectedLayerIndex: number } | null {
	const target = draft.mapLayers[index];
	if (!target) return null;
	const copy: PlaceMapLayerDraft = {
		...target,
		id: `${target.id || `layer-${index + 1}`}-copy`,
		name: target.name ? `${target.name} Copy` : `Layer ${index + 2}`
	};
	const nextLayers = draft.mapLayers.slice();
	nextLayers.splice(index + 1, 0, copy);
	return { draft: { ...draft, mapLayers: nextLayers }, selectedLayerIndex: index + 1 };
}

export function updateDraftMapLayerField(
	draft: PlaceDraft,
	index: number,
	field: keyof PlaceMapLayerDraft,
	value: string
): PlaceDraft {
	const nextLayers = draft.mapLayers.slice();
	if (!nextLayers[index]) return draft;
	nextLayers[index] = { ...nextLayers[index], [field]: value };
	return { ...draft, mapLayers: nextLayers };
}

export function removeDraftMapLayer(draft: PlaceDraft, index: number): { draft: PlaceDraft; selectedLayerIndex: number; selectedLayerId: string } | null {
	const target = draft.mapLayers[index];
	if (!target) return null;
	if (!window.confirm(`Remove map layer ${target.name || `#${index + 1}`}?`)) return null;
	const removedLayerId = normalizeKey(target.id || target.name || target.floor || '');
	const nextLayers = draft.mapLayers.slice();
	nextLayers.splice(index, 1);
	const nextPois = draft.pois.map((poi) =>
		normalizeKey(poi.layerId) === removedLayerId ? { ...poi, layerId: '' } : poi
	);
	const nextDraft = { ...draft, mapLayers: nextLayers, pois: nextPois };
	const selectedLayerIndex = nextLayers.length === 0 ? -1 : Math.min(index, nextLayers.length - 1);
	const selectedLayerId =
		selectedLayerIndex >= 0
			? normalizeKey(
					nextLayers[selectedLayerIndex].id ||
					nextLayers[selectedLayerIndex].name ||
					nextLayers[selectedLayerIndex].floor ||
						''
					)
			: '';
	return { draft: nextDraft, selectedLayerIndex, selectedLayerId };
}

export function addDraftPoi(draft: PlaceDraft, selectedLayerIndex: number): { draft: PlaceDraft; selectedPoiIndex: number; placingPoiIndex: number } {
	const nextPoi = createEmptyPoiDraft();
	const layer = draft.mapLayers[selectedLayerIndex];
	if (layer) {
		nextPoi.layerId = normalizeKey(layer.id || layer.name || layer.floor || '');
	}
	const nextPois = [...draft.pois, nextPoi];
	const nextIndex = nextPois.length - 1;
	return { draft: { ...draft, pois: nextPois }, selectedPoiIndex: nextIndex, placingPoiIndex: nextIndex };
}

export function duplicateDraftPoi(draft: PlaceDraft, index: number): { draft: PlaceDraft; selectedPoiIndex: number } | null {
	const target = draft.pois[index];
	if (!target) return null;
	const copy: PlacePoiDraft = {
		...target,
		id: `${target.id || `poi-${index + 1}`}-copy`,
		name: target.name ? `${target.name} Copy` : `POI ${index + 2}`
	};
	const nextPois = draft.pois.slice();
	nextPois.splice(index + 1, 0, copy);
	return { draft: { ...draft, pois: nextPois }, selectedPoiIndex: index + 1 };
}

export function updateDraftPoiField(draft: PlaceDraft, index: number, field: keyof PlacePoiDraft, value: string): PlaceDraft {
	const nextPois = draft.pois.slice();
	if (!nextPois[index]) return draft;
	nextPois[index] = { ...nextPois[index], [field]: value };
	return { ...draft, pois: nextPois };
}

export function removeDraftPoi(draft: PlaceDraft, index: number): { draft: PlaceDraft; selectedPoiIndex: number; placingPoiIndex: number | null } | null {
	const target = draft.pois[index];
	if (!target) return null;
	if (!window.confirm(`Remove POI ${target.name || `#${index + 1}`}?`)) return null;
	const nextPois = draft.pois.slice();
	nextPois.splice(index, 1);
	const selectedPoiIndex = nextPois.length === 0 ? -1 : Math.min(index, nextPois.length - 1);
	let placingPoiIndex: number | null = null;
	return { draft: { ...draft, pois: nextPois }, selectedPoiIndex, placingPoiIndex };
}
