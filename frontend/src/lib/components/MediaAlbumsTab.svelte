<script lang="ts">
	import MediaAlbumsTabImpl from './media-albums/MediaAlbumsTabImpl.svelte';

	export let variant: 'compact' | 'full' = 'compact';
</script>

<MediaAlbumsTabImpl {variant} />
