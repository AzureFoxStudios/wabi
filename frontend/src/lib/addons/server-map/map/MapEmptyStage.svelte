<script lang="ts">
 import MapVectorStage from './MapVectorStage.svelte';
 import { createEventDispatcher } from 'svelte';
 export let isCompactLayout: boolean;
 export let canManagePlaces: boolean;
 export let placesAvailable = false;
 export let placesLoading = false;
 const dispatch = createEventDispatcher<{ newPlace: void; retry: void }>();
</script>
<div class="world-map" class:compact={isCompactLayout}>
 <MapVectorStage />
 <div class="world-map-caption"><strong>Explore the map</strong><span>{placesLoading ? 'Loading saved places…' : placesAvailable ? 'No saved places on this server yet.' : 'Saved places are unavailable. You can still explore.'}</span>{#if !placesAvailable && !placesLoading}<button type="button" on:click={() => dispatch('retry')}>Retry places</button>{/if}{#if canManagePlaces && placesAvailable}<button type="button" on:click={() => dispatch('newPlace')}>Add a place</button>{/if}<a href="https://www.openstreetmap.org/" target="_blank" rel="noopener noreferrer">Open map ↗</a></div>
</div>
<style>
 .world-map { flex: 1; position: relative; min-height: 320px; height: 100%; background: var(--bg-primary); }
 .world-map-caption { position: absolute; left: 16px; bottom: 32px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; max-width: calc(100% - 80px); padding: 12px 16px; border-radius: 12px; background: var(--bg-primary, #172326); color: var(--text-heading); box-shadow: 0 4px 20px #0003; }
 .world-map-caption span { color: var(--text-muted); font-size: 12px; }
 button { min-height: 36px; background: var(--bg-secondary); color: var(--text-heading); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
 a { font-size: 12px; }
</style>
