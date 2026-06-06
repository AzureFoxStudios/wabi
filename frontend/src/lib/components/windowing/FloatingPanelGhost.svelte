<script lang="ts">
	import type { Rect } from '$lib/windowing/types';

	export let rect: Rect | null = null;
	export let visible = false;
</script>

{#if visible && rect}
	<div
		class="floating-panel-ghost"
		style="left: {rect.x}px; top: {rect.y}px; width: {rect.width}px; height: {rect.height}px;"
		aria-hidden="true"
	></div>
{/if}