<script lang="ts">
	import MapAddonWorkspace from '$lib/addons/server-map/MapAddonWorkspace.svelte';
	export let variant: 'compact' | 'full' | 'detached' = 'full';
	export let initialPlaceId: string | null = null;
</script>

<MapAddonWorkspace {variant} {initialPlaceId} />
