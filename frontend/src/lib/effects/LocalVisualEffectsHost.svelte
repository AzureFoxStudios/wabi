<script lang="ts">
	import MouseFeeler from './MouseFeeler.svelte';
</script>

<!--
	Root mount for user-owned, local visual effects.
	The pointer feeler is the first supported surface. Future background,
	foreground, panel, avatar, message, voice, or notification surfaces belong
	here rather than being mounted independently in +layout.svelte.
-->
<MouseFeeler />
