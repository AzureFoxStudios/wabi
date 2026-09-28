<script lang="ts">
	import { onMount } from 'svelte';
	import { derived } from 'svelte/store';
	import MapWorkspace from './MapWorkspace.svelte';
	import MapTokenBoard from './MapTokenBoard.svelte';
	import FieldPilotWorkspace from './FieldPilotWorkspace.svelte';
	import { getFieldCapability } from '$lib/api/field';
	import { currentUser } from '$lib/socket';
	import { activeServerUrl } from '$lib/serverUrl';
	import { focusedMapLayerId, focusedMapPlace } from '$lib/mapWorkspace';

	export let variant: 'compact' | 'full' | 'detached' = 'full';
	export let initialPlaceId: string | null = null;
	let activeView: 'map' | 'field' = 'map';
	let fieldAvailable = false;

	onMount(() => {
		if (variant !== 'full') return;
		let controller: AbortController | null = null;
		let scope = '';
		const unsubscribe = derived([activeServerUrl, currentUser], ([url, user]) => `${url}|${user?.dbUserId ?? 'signed-out'}`)
			.subscribe((nextScope) => {
				if (nextScope === scope) return;
				scope = nextScope;
				controller?.abort();
				controller = new AbortController();
				const requestController = controller;
				fieldAvailable = false;
				activeView = 'map';
				void getFieldCapability(requestController.signal)
					.then((enabled) => { if (controller === requestController) fieldAvailable = enabled; })
					.catch(() => { if (controller === requestController) fieldAvailable = false; });
			});
		return () => { controller?.abort(); unsubscribe(); };
	});
</script>

<div class="maps-addon-root">
	{#if variant === 'full'}
		<nav class="maps-views" aria-label="Maps views">
			<button type="button" class:active={activeView === 'map'} aria-current={activeView === 'map' ? 'page' : undefined} on:click={() => (activeView = 'map')}>Maps</button>
			{#if fieldAvailable}<button type="button" class:active={activeView === 'field'} aria-current={activeView === 'field' ? 'page' : undefined} on:click={() => (activeView = 'field')}>Field pilot</button>{/if}
		</nav>
	{/if}
	<div class="maps-addon-shell" class:compact={variant === 'compact'} class:inactive={activeView === 'field' && variant === 'full'}>
		<div class="map-surface">
			<MapWorkspace {variant} {initialPlaceId} />
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
	{#if variant === 'full' && fieldAvailable && activeView === 'field'}
		<div class="field-view"><FieldPilotWorkspace /></div>
	{/if}
</div>

<style>
	.maps-addon-root { display:flex; flex-direction:column; min-height:0; height:100%; }
	.maps-views { display:flex; gap:.3rem; padding:.35rem .4rem; border-bottom:1px solid var(--color-border-primary, #464158); }
	.maps-views button { border:0; border-radius:.45rem; padding:.45rem .8rem; background:transparent; color:var(--text-secondary, #b7b7c8); cursor:pointer; }
	.maps-views button.active { background:var(--surface-raised, #302d3f); color:var(--text-primary, #fff); font-weight:700; }
	.maps-views button:focus-visible { outline:2px solid var(--accent-primary, #a89cff); }
	.maps-addon-shell { display:grid; flex:1; grid-template-columns:minmax(0,1fr) minmax(250px,320px); min-height:0; gap:.55rem; }
	.maps-addon-shell.inactive { display:none; }
	.field-view { flex:1; min-height:0; }
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
