<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	export let lat: number;
	export let lon: number;
	export let zoom = 15;
	export let pitch = 60;
	export let bearing = 0;
	export let pois: { id: string; lat: number; lon: number; label?: string; height?: number; color?: string }[] = [];
	export let interactive = true;
	export let extrusionField: 'height' | null = 'height';

	// Public free style. Swap for self-hosted Protomaps PMTiles later (see notes below).
	export let styleUrl: string = 'https://demotiles.maplibre.org/style.json';

	let container: HTMLDivElement | null = null;
	let map: any = null;
	let disposed = false;

	const POI_SOURCE_ID = 'wabi-pois';
	const POI_FILL_LAYER_ID = 'wabi-pois-extrude';
	const POI_CIRCLE_LAYER_ID = 'wabi-pois-circle';

	function poiToFeature(p: typeof pois[number]) {
		const r = 0.00012; // ~13m square at the equator; good enough for a marker pad
		const ring = [
			[p.lon - r, p.lat - r],
			[p.lon + r, p.lat - r],
			[p.lon + r, p.lat + r],
			[p.lon - r, p.lat + r],
			[p.lon - r, p.lat - r]
		];
		return {
			type: 'Feature' as const,
			properties: {
				id: p.id,
				label: p.label ?? '',
				height: typeof p.height === 'number' ? p.height : 40,
				color: p.color ?? '#3b82f6'
			},
			geometry: { type: 'Polygon' as const, coordinates: [ring] }
		};
	}

	function poisToFC() {
		return { type: 'FeatureCollection' as const, features: pois.map(poiToFeature) };
	}

	async function init() {
		if (!container || typeof window === 'undefined') return;
		const maplibregl = (await import('maplibre-gl')).default;
		// Inject CSS once.
		if (!document.getElementById('maplibre-gl-css')) {
			const link = document.createElement('link');
			link.id = 'maplibre-gl-css';
			link.rel = 'stylesheet';
			link.href = 'https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css';
			document.head.appendChild(link);
		}

		if (disposed) return;

		map = new maplibregl.Map({
			container,
			style: styleUrl,
			center: [lon, lat],
			zoom,
			pitch,
			bearing,
			interactive,
			attributionControl: { compact: true }
		});

		map.on('load', () => {
			if (disposed) return;
			map.addSource(POI_SOURCE_ID, { type: 'geojson', data: poisToFC() });

			if (extrusionField) {
				map.addLayer({
					id: POI_FILL_LAYER_ID,
					type: 'fill-extrusion',
					source: POI_SOURCE_ID,
					paint: {
						'fill-extrusion-color': ['get', 'color'],
						'fill-extrusion-height': ['get', 'height'],
						'fill-extrusion-base': 0,
						'fill-extrusion-opacity': 0.85
					}
				});
			}

			map.addLayer({
				id: POI_CIRCLE_LAYER_ID,
				type: 'circle',
				source: POI_SOURCE_ID,
				paint: {
					'circle-radius': 5,
					'circle-color': ['get', 'color'],
					'circle-stroke-width': 1.5,
					'circle-stroke-color': '#0a0a0a'
				}
			});
		});
	}

	function syncPois() {
		if (!map) return;
		const src = map.getSource(POI_SOURCE_ID);
		if (src && 'setData' in src) (src as any).setData(poisToFC());
	}

	function syncCamera() {
		if (!map) return;
		map.jumpTo({ center: [lon, lat], zoom, pitch, bearing });
	}

	onMount(() => { void init(); });
	onDestroy(() => {
		disposed = true;
		if (map) { map.remove(); map = null; }
	});

	$: if (map) { syncPois(); }
	$: if (map) { void [lat, lon, zoom, pitch, bearing]; syncCamera(); }
</script>

<div bind:this={container} class="maplibre-canvas"></div>

<style>
	.maplibre-canvas {
		width: 100%;
		height: 100%;
		min-height: 240px;
		background: #0a0a0a;
	}
	.maplibre-canvas :global(.maplibregl-ctrl-attrib) {
		font-size: 10px;
	}
</style>
