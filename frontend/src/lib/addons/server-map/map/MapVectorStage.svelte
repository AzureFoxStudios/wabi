<script lang="ts">
 import { get } from 'svelte/store';
 import { currentUser } from '$lib/presenceIdentity';
 import { getServerUrl } from '$lib/serverUrl';
 import { normalizeWaypoints, waypointVolumes, type MapWaypoint } from './mapWaypoints';
 import type { GeoJSONSource } from 'maplibre-gl';
 import { onMount } from 'svelte';
 import type { Map as VectorMap } from 'maplibre-gl';
 import 'maplibre-gl/dist/maplibre-gl.css';
 let { latitude = 22.2975, longitude = 114.1723 }: { latitude?: number; longitude?: number } = $props();
 let host: HTMLDivElement;
 let map: VectorMap | undefined;
 let ready = $state(false);
 let error = $state('');
 let palette = $state('atlas');
 let tilted = $state(false);
 let pins = $state<MapWaypoint[]>([]);
 let placingPin = $state(false);
 let selectedPin = $state('');
 let pinName = $state('Waypoint');
 let pinHeight = $state(0);
 let pinStorageKey = '';
 function updatePins() {
  if (!map?.getSource('wabi-waypoints')) return;
  const pointData = { type: 'FeatureCollection' as const, features: pins.map(pin => ({ type: 'Feature' as const, properties: { name: pin.name }, geometry: { type: 'Point' as const, coordinates: [pin.longitude, pin.latitude] } })) };
  (map.getSource('wabi-waypoints') as GeoJSONSource).setData(pointData);
  (map.getSource('wabi-waypoint-volumes') as GeoJSONSource).setData(waypointVolumes(pins));
  map.setLayoutProperty('wabi-waypoint-3d', 'visibility', tilted ? 'visible' : 'none');
  map.setLayoutProperty('wabi-waypoint-flat', 'visibility', tilted ? 'none' : 'visible');
 }
 function savePins() {
  try { localStorage.setItem(pinStorageKey, JSON.stringify(pins)); } catch { error = 'Could not save waypoints on this device.'; }
  updatePins();
 }
 function editPin() {
  if (!Number.isFinite(pinHeight)) return;
  pins = pins.map(pin => pin.id === selectedPin ? { ...pin, name: pinName.trim().slice(0,80) || 'Waypoint', height: Math.min(500, Math.max(0,pinHeight)) } : pin);
  savePins();
 }
 let buildingOpacity = $state(0.65);
 function setView(immersive: boolean) {
  tilted = immersive;
  if (!map) return;
  map.dragRotate[immersive ? 'enable' : 'disable']();
  map.touchZoomRotate[immersive ? 'enableRotation' : 'disableRotation']();
  map.easeTo({ pitch: immersive ? 55 : 0, bearing: immersive ? -25 : 0, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350 });
  updateBuildingOpacity();
  updatePins();
 }
 function navigate(event: KeyboardEvent) {
  if (!tilted || (event.target !== host && !(event.target instanceof HTMLCanvasElement)) || !map || event.altKey || event.ctrlKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  const step = event.shiftKey ? 90 : 35;
  const offsets: Record<string, [number, number]> = { w: [0, -step], s: [0, step], a: [-step, 0], d: [step, 0] };
  if (offsets[key]) { event.preventDefault(); map.panBy(offsets[key], { duration: 0 }); }
  else if (key === 'q' || key === 'e') { event.preventDefault(); map.setBearing(map.getBearing() + (key === 'q' ? -5 : 5)); }
  else if (key === 'escape') { event.preventDefault(); setView(false); }
 }
 function updateBuildingOpacity() {
  if (!map?.getStyle()?.layers) return;
  for (const layer of map.getStyle().layers) {
   if (layer.type === 'fill-extrusion' && layer.id !== 'wabi-waypoint-3d') map.setPaintProperty(layer.id, 'fill-extrusion-opacity', tilted ? buildingOpacity : 0);
  }
  try { localStorage.setItem('wabi:map-building-opacity:v1', String(buildingOpacity)); } catch { /* Keep the current view without persistence. */ }
 }
 const colors: Record<string, { land: string; water: string; park: string; road: string; building: string; text: string }> = {
  atlas: { land: '#f3edda', water: '#8bcde3', park: '#cad8ae', road: '#ffdda0', building: '#d8cbb3', text: '#423f37' },
  parchment: { land: '#ead9b6', water: '#a9c4bf', park: '#b8bc91', road: '#faf0d4', building: '#bd9e75', text: '#51402c' },
  moonlight: { land: '#252b43', water: '#131c32', park: '#344e53', road: '#5d668a', building: '#8992b8', text: '#f2eafc' },
  sakura: { land: '#f4e5ed', water: '#b3d6e3', park: '#c8d7c1', road: '#fff2d8', building: '#d8a8bb', text: '#654658' }
 };
 function recolor() {
  if (!map?.getStyle()?.layers) return;
  try { localStorage.setItem('wabi:map-palette:v1', palette); } catch { /* Rendering remains available without device storage. */ }
  const c = colors[palette];
  for (const layer of map.getStyle().layers) {
   const source = 'source-layer' in layer ? layer['source-layer'] : '';
   if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', c.land);
   else if (layer.type === 'fill') {
    const color = source === 'water' ? c.water : source === 'building' ? c.building : source === 'park' || source === 'landcover' ? c.park : c.land;
    if (color) map.setPaintProperty(layer.id, 'fill-color', color);
   } else if (layer.type === 'line' && source === 'transportation') map.setPaintProperty(layer.id, 'line-color', c.road);
   else if (layer.type === 'symbol' && layer.layout?.['text-field']) {
    map.setPaintProperty(layer.id, 'text-color', c.text);
    map.setPaintProperty(layer.id, 'text-halo-color', c.land);
   } else if (layer.type === 'fill-extrusion' && layer.id !== 'wabi-waypoint-3d') { map.setPaintProperty(layer.id, 'fill-extrusion-color', c.building); map.setPaintProperty(layer.id, 'fill-extrusion-opacity', tilted ? buildingOpacity : 0); }
  }
 }
 onMount(() => {
  try { const stored = localStorage.getItem('wabi:map-palette:v1'); if (stored && Object.hasOwn(colors, stored)) palette = stored; } catch { /* Use the default palette. */ }
  try { const value = Number(localStorage.getItem('wabi:map-building-opacity:v1') ?? '0.65'); if (Number.isFinite(value)) buildingOpacity = Math.min(1, Math.max(0, value)); } catch { /* Use the default translucency. */ }
  pinStorageKey = `wabi:map-waypoints:v1:${encodeURIComponent(getServerUrl())}:${get(currentUser)?.id || 'offline'}`;
  try { pins = normalizeWaypoints(JSON.parse(localStorage.getItem(pinStorageKey) || '[]')); } catch { pins = []; }
  let disposed = false;
  let resize: ResizeObserver | undefined;
  const loadingDeadline = setTimeout(() => { if (!ready) error = 'Map loading is taking longer than expected. You can open the standard map while it reconnects.'; }, 25000);
  void import('maplibre-gl').then(({ Map, NavigationControl, FullscreenControl }) => {
   if (disposed) return;
   map = new Map({ container: host, style: import.meta.env.VITE_WABI_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/liberty', center: [longitude, latitude], zoom: 15, pitch: 0, bearing: 0, maxPitch: 70, fadeDuration: 0, maxTileCacheSize: 64, attributionControl: { compact: true } });
   map.dragRotate.disable();
   map.touchZoomRotate.disableRotation();
   map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
   map.addControl(new FullscreenControl({ container: host.parentElement! }), 'bottom-right');
   map.on('load', () => {
    if (!map) return;
    const existing = map.getStyle().layers;
    if (!existing.some(layer => layer.type === 'fill-extrusion')) {
     const building = existing.find(layer => 'source-layer' in layer && layer['source-layer'] === 'building');
     if (building && 'source' in building) map.addLayer({ id: 'wabi-buildings', type: 'fill-extrusion', source: building.source, 'source-layer': 'building', minzoom: 14, paint: { 'fill-extrusion-color': colors[palette].building, 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0 } }, existing.find(layer => layer.type === 'symbol')?.id);
    }
    map.addSource('wabi-waypoints', {type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addSource('wabi-waypoint-volumes', {type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'wabi-waypoint-flat',type:'circle',source:'wabi-waypoints',paint:{'circle-radius':7,'circle-color':'#f59e0b','circle-stroke-color':'#ffffff','circle-stroke-width':2}});
    map.addLayer({id:'wabi-waypoint-3d',type:'fill-extrusion',source:'wabi-waypoint-volumes',paint:{'fill-extrusion-base':['get','base'],'fill-extrusion-height':['get','top'],'fill-extrusion-color':'#f59e0b','fill-extrusion-opacity':0.95}});
    map.on('click', event => {
     if (!placingPin || pins.length >= 100) return;
     const pin = {id:crypto.randomUUID(),name:'Waypoint',latitude:event.lngLat.lat,longitude:event.lngLat.lng,height:0};
     pins = [...pins,pin]; selectedPin = pin.id; pinName = pin.name; pinHeight = 0; placingPin = false; savePins();
    });
    updatePins(); recolor(); ready = true; error = ''; clearTimeout(loadingDeadline);
   });
   map.on('error', () => { if (!ready) error = 'Map tiles could not load. Check your connection or open the standard map.'; });
   resize = new ResizeObserver(() => map?.resize()); resize.observe(host);
  }).catch(() => { error = 'This device could not start the 3D map.'; });
  return () => { disposed = true; clearTimeout(loadingDeadline); resize?.disconnect(); map?.remove(); map = undefined; };
 });
 $effect(() => { const lat = latitude, lon = longitude; if (ready) map?.jumpTo({ center: [lon, lat] }); });
</script>
<div class="vector-stage">
 <div bind:this={host} class="map-host" tabindex="0" role="application" onkeydown={navigate} aria-label="Interactive street map" aria-describedby={tilted ? 'map-navigation-help' : undefined}></div>
 <div class="map-style-controls">
  <label>Map style <select aria-label="Map style" bind:value={palette} onchange={recolor}><option value="atlas">Atlas</option><option value="parchment">Parchment</option><option value="moonlight">Moonlight</option><option value="sakura">Sakura</option></select></label>
  <button type="button" aria-pressed={tilted} onclick={() => setView(!tilted)}>{tilted ? 'Return to 2D' : 'Explore in 3D'}</button>
  {#if tilted}<label class="building-control">Buildings <input aria-label="Building opacity" type="range" min="0" max="1" step="0.05" bind:value={buildingOpacity} oninput={updateBuildingOpacity} /><output>{Math.round(buildingOpacity * 100)}%</output></label>{/if}
  <details class="waypoints"><summary>Waypoints · {pins.length}</summary><div class="waypoint-menu">
   <p>Personal waypoints · saved on this device</p>
   <button type="button" disabled={!ready || pins.length >= 100} aria-pressed={placingPin} onclick={() => placingPin = !placingPin}>{placingPin ? 'Cancel placement' : 'Place on map'}</button>
   {#if placingPin}<p>Click a location on the map.</p>{/if}
   {#each pins as pin (pin.id)}<button type="button" onclick={() => { selectedPin = pin.id; pinName = pin.name; pinHeight = pin.height; map?.easeTo({center:[pin.longitude,pin.latitude]}); }}>{pin.name} · {pin.height} m</button>{/each}
   {#if selectedPin}<label>Name <input aria-label="Waypoint name" maxlength="80" bind:value={pinName} /></label><label>Height above ground (m) <input aria-label="Waypoint height" type="number" min="0" max="500" bind:value={pinHeight}/></label><button type="button" onclick={editPin}>Save waypoint</button><button type="button" onclick={() => {pins = pins.filter(pin => pin.id !== selectedPin); selectedPin = ''; savePins();}}>Remove waypoint</button>{/if}
  </div></details>
 </div>
 {#if tilted}<div id="map-navigation-help" class="navigation-help">Focus the map · WASD move · Q/E turn · Shift move faster · Esc return to 2D</div>{/if}
 {#if !ready}<div class="map-status" role="status">{error || 'Loading street map…'}{#if error}<a href={`https://www.openstreetmap.org/#map=15/${latitude}/${longitude}`} target="_blank" rel="noopener noreferrer">Open standard map ↗</a>{/if}</div>{/if}
</div>
<style>
 .vector-stage { position: relative; height: 100%; min-height: 400px; flex: 1; }
 .map-host { position: absolute; inset: 0; }
 .map-style-controls { position: absolute; top: 16px; right: 16px; z-index: 2; display: flex; flex-wrap: wrap; max-width: calc(100% - 32px); gap: 8px; align-items: center; padding: 8px; border-radius: 12px; background: var(--bg-primary); color: var(--text-heading); box-shadow: 0 4px 20px #0003; }
 .waypoints { position: relative; font-size: 12px; }
 summary { cursor: pointer; padding: 8px; }
 .waypoint-menu { position: absolute; top: 36px; right: 0; width: min(260px,70vw); max-height: 55vh; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--bg-primary); border: 1px solid var(--border-subtle); border-radius: 10px; box-shadow: 0 6px 24px #0004; }
 .waypoint-menu label { flex-wrap: wrap; }
 .waypoint-menu input { width: 100%; box-sizing: border-box; color: var(--text-heading); background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 8px; }
 .building-control input { width: 90px; accent-color: var(--accent-primary); }
 output { min-width: 32px; font-variant-numeric: tabular-nums; }
 label { display: flex; align-items: center; gap: 8px; font-size: 12px; }
 select, button { min-height: 36px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-secondary); color: var(--text-heading); padding: 6px 10px; }
 .navigation-help { position: absolute; bottom: 12px; left: 12px; right: 64px; pointer-events: none; padding: 8px 12px; border-radius: 8px; background: var(--bg-primary); color: var(--text-secondary); font-size: 12px; }
 .map-host:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -3px; }
 .map-status { position: absolute; top: 80px; left: 16px; right: 16px; padding: 12px; background: var(--bg-primary); color: var(--text-heading); border-radius: 10px; }
 a { display: block; margin-top: 8px; }
 @media(max-width: 480px) { .map-style-controls { top: 64px; } .map-status { top: 120px; } }
</style>
