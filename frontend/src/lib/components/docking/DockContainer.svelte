<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let navDock: 'left' | 'right' = 'left';
	export let navWidth = 280;
	export let rightWidth = 320;
	export let showNav = true;
	export let showRight = false;
	export let isResizing = false;

	const dispatch = createEventDispatcher<{
		resizenavstart: void;
		resizerightstart: void;
	}>();
</script>

<div class="dock-container" class:nav-right={navDock === 'right'} class:resizing={isResizing}>
	{#if showNav}
		<aside class="dock-zone nav-zone" style:width={`${navWidth}px`}>
			<slot name="nav" />
			<div class="split-handle nav-handle" on:mousedown={() => dispatch('resizenavstart')}></div>
		</aside>
	{/if}

	<section class="dock-zone center-zone">
		<slot name="center" />
	</section>

	{#if showRight}
		<aside class="dock-zone right-zone" style:width={`${rightWidth}px`}>
			<div class="split-handle right-handle" on:mousedown={() => dispatch('resizerightstart')}></div>
			<slot name="right" />
		</aside>
	{/if}
</div>

<style>
	.dock-container {
		display: flex;
		min-height: 0;
		width: 100%;
		height: 100%;
	}

	.dock-container.resizing {
		cursor: col-resize;
		user-select: none;
	}

	.dock-container.nav-right .nav-zone {
		order: 3;
	}

	.dock-container.nav-right .center-zone {
		order: 1;
	}

	.dock-container.nav-right .right-zone {
		order: 2;
	}

	.dock-zone {
		position: relative;
		min-height: 0;
	}

	.center-zone {
		flex: 1;
		min-width: 0;
	}

	.nav-zone,
	.right-zone {
		flex-shrink: 0;
	}

	.split-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 20;
	}

	.nav-handle {
		right: -3px;
	}

	.dock-container.nav-right .nav-handle {
		left: -3px;
		right: auto;
	}

	.right-handle {
		left: -3px;
	}
</style>
