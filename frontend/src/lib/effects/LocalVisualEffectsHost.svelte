<script lang="ts">
	import MouseFeeler from './MouseFeeler.svelte';
	import CRTPostProcess from './CRTPostProcess.svelte';
</script>

<!--
	Root mount for user-owned, local visual effects.
	Screen/post-process effects live here too so they can affect the fully
	composed Wabi viewport rather than being tied to one chat background.
-->
<MouseFeeler />
<CRTPostProcess />
