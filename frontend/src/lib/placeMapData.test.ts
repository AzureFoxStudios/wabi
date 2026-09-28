import { describe, expect, test } from 'bun:test';
import { buildDraftValidationIssues, createEmptyPlaceDraft, createPlaceDraft, serializePlaceDraft } from './placeDraft';
import { normalizeRegistryPayload } from './placeNormalization';

describe('place map data', () => {
	test('serializes Bangkok latitude and longitude without image-coordinate clamping', () => {
		const draft = createEmptyPlaceDraft();
		draft.name = 'Bangkok base';
		draft.lat = '13.7563';
		draft.lon = '100.5018';

		const serialized = serializePlaceDraft(draft);
		expect(serialized.lat).toBe(13.7563);
		expect(serialized.lon).toBe(100.5018);
		expect(buildDraftValidationIssues(draft)).toEqual([]);
	});

	test('accepts signed geographic coordinates and rejects out-of-range values', () => {
		const draft = createEmptyPlaceDraft();
		draft.name = 'Field base';
		draft.lat = '-33.8688';
		draft.lon = '151.2093';
		expect(serializePlaceDraft(draft)).toMatchObject({ lat: -33.8688, lon: 151.2093 });

		draft.lat = '91';
		draft.lon = '181';
		expect(buildDraftValidationIssues(draft)).toEqual([
			'Latitude must be between -90 and 90.',
			'Longitude must be between -180 and 180.'
		]);
		expect(serializePlaceDraft(draft)).not.toHaveProperty('lat');
		expect(serializePlaceDraft(draft)).not.toHaveProperty('lon');
	});

	test('preserves object-valued map layers and POIs through registry normalization', () => {
		const draft = createEmptyPlaceDraft();
		draft.name = 'Trailhead';
		draft.lat = '13.7563';
		draft.lon = '100.5018';
		draft.mapLayers = [{
			id: 'trail-map', name: 'Trail map', floor: '', imageUrl: '/uploads/trail.png', rotation: '15'
		}];
		draft.pois = [{
			id: 'meeting-point', name: 'Meeting point', x: '0.25', y: '0.75',
			layerId: 'trail-map', description: '', renderMode: 'both', themePreset: '',
			iconPreset: 'meeting', iconGlyph: '●', iconColor: '#78b4ff'
		}];

		const serialized = serializePlaceDraft(draft);
		const [place] = normalizeRegistryPayload([serialized]);
		expect(place).toMatchObject({
			lat: 13.7563,
			lon: 100.5018,
			mapLayers: [{ id: 'trail-map', imageUrl: '/uploads/trail.png', rotation: 15 }],
			pois: [{ id: 'meeting-point', x: 0.25, y: 0.75, layerId: 'trail-map' }]
		});

		const restored = createPlaceDraft(place);
		expect(serializePlaceDraft(restored)).toMatchObject({
			lat: 13.7563,
			lon: 100.5018,
			mapLayers: [{ id: 'trail-map', imageUrl: '/uploads/trail.png', rotation: 15 }],
			pois: [{ id: 'meeting-point', x: 0.25, y: 0.75, layerId: 'trail-map' }]
		});
	});
});
