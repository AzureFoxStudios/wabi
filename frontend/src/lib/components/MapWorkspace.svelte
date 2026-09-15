<script lang="ts">
	/**
	 * Compatibility shim. The Maps implementation now lives in the bundled
	 * server-map addon. Existing core call sites can keep this import while
	 * migration finishes without owning map feature code themselves.
	 */
	import MapAddonWorkspace from '$lib/addons/server-map/MapAddonWorkspace.svelte';
	export let variant: 'compact' | 'full' | 'detached' = 'full';
	export let initialPlaceId: string | null = null;
</script>

<MapAddonWorkspace {variant} {initialPlaceId} />
