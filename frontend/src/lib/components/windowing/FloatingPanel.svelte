<script lang="ts">
	import type { FloatingPanelState, Rect, SnapZone } from '$lib/windowing/types';
	import { getSnapRect, getSnapZone } from '$lib/windowing/snapMath';
	import { floatingPanelStore, getViewportRect } from '$lib/windowing/floatingPanelStore';

	export let panel: FloatingPanelState;

	const MIN_WIDTH = 320;
	const MIN_HEIGHT = 240;
	let frame: HTMLElement | null = null;
	let activeSnapZone: SnapZone | null = null;

	function styleFromRect(rect: Rect, zIndex: number): string {
		return `left: ${rect.x}px; top: ${rect.y}px; width: ${rect.width}px; height: ${rect.height}px; z-index: ${zIndex};`;
	}

	function startDrag(event: PointerEvent): void {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('button, input, textarea, select, a')) return;
		event.preventDefault();
		frame?.setPointerCapture?.(event.pointerId);
		floatingPanelStore.focusFloatingPanel(panel.id);
		const startX = event.clientX;
		const startY = event.clientY;
		const startRect = panel.rect;
		let moved = false;

		const onMove = (moveEvent: PointerEvent) => {
			moveEvent.preventDefault();
			moved = true;
			const viewport = getViewportRect();
			const zone = getSnapZone(moveEvent.clientX, moveEvent.clientY, viewport);
			activeSnapZone = zone;
			if (zone) {
				floatingPanelStore.showGhost(getSnapRect(zone, viewport));
			} else {
				floatingPanelStore.hideGhost();
			}
			floatingPanelStore.moveFloatingPanel(panel.id, {
				x: startRect.x + moveEvent.clientX - startX,
				y: startRect.y + moveEvent.clientY - startY,
				width: startRect.width,
				height: startRect.height
			});
		};

		const onUp = (upEvent: PointerEvent) => {
			frame?.releasePointerCapture?.(event.pointerId);
			window.removeEventListener('pointermove', onMove, true);
			window.removeEventListener('pointerup', onUp, true);
			window.removeEventListener('pointercancel', onUp, true);
			floatingPanelStore.hideGhost();
			if (moved && activeSnapZone) {
				floatingPanelStore.snapFloatingPanel(panel.id, activeSnapZone, getViewportRect());
			}
			activeSnapZone = null;
		};

		window.addEventListener('pointermove', onMove, true);
		window.addEventListener('pointerup', onUp, true);
		window.addEventListener('pointercancel', onUp, true);
	}

	function startResize(event: PointerEvent, edge: 'right' | 'bottom' | 'corner'): void {
		event.preventDefault();
		event.stopPropagation();
		frame?.setPointerCapture?.(event.pointerId);
		floatingPanelStore.focusFloatingPanel(panel.id);
		if (panel.mode !== 'floating') floatingPanelStore.restoreFloatingPanel(panel.id);
		const startX = event.clientX;
		const startY = event.clientY;
		const startRect = panel.rect;

		const onMove = (moveEvent: PointerEvent) => {
			moveEvent.preventDefault();
			const width = edge === 'bottom' ? startRect.width : Math.max(MIN_WIDTH, startRect.width + moveEvent.clientX - startX);
			const height = edge === 'right' ? startRect.height : Math.max(MIN_HEIGHT, startRect.height + moveEvent.clientY - startY);
			floatingPanelStore.resizeFloatingPanel(panel.id, { ...startRect, width, height });
		};

		const onUp = () => {
			frame?.releasePointerCapture?.(event.pointerId);
			window.removeEventListener('pointermove', onMove, true);
			window.removeEventListener('pointerup', onUp, true);
			window.removeEventListener('pointercancel', onUp, true);
		};

		window.addEventListener('pointermove', onMove, true);
		window.addEventListener('pointerup', onUp, true);
		window.addEventListener('pointercancel', onUp, true);
	}
</script>

<div
	bind:this={frame}
	class="floating-panel"
	class:floating-panel-docked={panel.mode === 'docked'}
	class:floating-panel-maximized={panel.mode === 'maximized'}
	style={styleFromRect(panel.rect, panel.zIndex)}
	on:pointerdown={() => floatingPanelStore.focusFloatingPanel(panel.id)}
>
	<header class="floating-panel-header" on:pointerdown={startDrag}>
		<div class="floating-panel-title">
			<span class="floating-panel-title-dot" aria-hidden="true"></span>
			<span>{panel.title}</span>
		</div>
		<div class="floating-panel-actions">
			{#if panel.mode !== 'floating'}
				<button type="button" class="floating-panel-action" on:click={() => floatingPanelStore.restoreFloatingPanel(panel.id)} title="Restore floating panel">□</button>
			{/if}
			<button type="button" class="floating-panel-action" on:click={() => floatingPanelStore.closeFloatingPanel(panel.id)} title="Close panel">×</button>
		</div>
	</header>
	<section class="floating-panel-body">
		<slot />
	</section>
	{#if panel.mode === 'floating'}
		<button type="button" aria-label="Resize panel horizontally" class="floating-panel-resize floating-panel-resize-right" on:pointerdown={(event) => startResize(event, 'right')}></button>
		<button type="button" aria-label="Resize panel vertically" class="floating-panel-resize floating-panel-resize-bottom" on:pointerdown={(event) => startResize(event, 'bottom')}></button>
		<button type="button" aria-label="Resize panel" class="floating-panel-resize floating-panel-resize-corner" on:pointerdown={(event) => startResize(event, 'corner')}></button>
	{/if}
</div>
