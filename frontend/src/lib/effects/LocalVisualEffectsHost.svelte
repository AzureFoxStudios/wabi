<script lang="ts">
	import MouseFeeler from './MouseFeeler.svelte';
	import CRTPostProcess from './CRTPostProcess.svelte';
</script>

<!--
	Root mount for user-owned local visual effects.
	Pointer effects render as overlays; CRT is a true screen post-process that
	filters the fully composed document so backgrounds and interface geometry
	share one distorted display surface.
-->
<MouseFeeler />
<CRTPostProcess />
