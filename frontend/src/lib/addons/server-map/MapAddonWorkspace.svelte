<script lang="ts">
	import CoreMapWorkspace from '$lib/components/MapWorkspace.svelte';
	import MapTokenBoard from './MapTokenBoard.svelte';
	import { focusedMapLayerId, focusedMapPlace } from '$lib/mapWorkspace';

	export let variant: 'compact' | 'full' | 'detached' = 'full';
	export let initialPlaceId: string | null = null;
</script>

<div class="maps-addon-shell" class:compact={variant === 'compact'}>
	<div class="map-surface">
		<CoreMapWorkspace {variant} {initialPlaceId} />
	</div>
	{#if variant !== 'detached'}
		<aside class="board-rail">
			<MapTokenBoard
				placeId={$focusedMapPlace?.id || null}
				layerId={$focusedMapLayerId}
				compact={variant === 'compact'}
			/>
		</aside>
	{/if}
</div>

<style>
	.maps-addon-shell { display:grid; grid-template-columns:minmax(0,1fr) minmax(250px,320px); min-height:0; height:100%; gap:.55rem; }
	.map-surface { min-width:0; min-height:0; }
	.board-rail { min-width:0; overflow:auto; padding:.35rem; }
	.maps-addon-shell.compact { display:flex; flex-direction:column; overflow:auto; }
	.maps-addon-shell.compact .map-surface { min-height:320px; }
	.maps-addon-shell.compact .board-rail { flex:0 0 auto; }
	@media (max-width: 900px) {
		.maps-addon-shell { display:flex; flex-direction:column; overflow:auto; }
		.map-surface { min-height:420px; }
	}
</style>
