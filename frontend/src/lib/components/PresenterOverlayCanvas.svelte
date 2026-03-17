<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { renderDrawPreview, renderElements } from '$lib/whiteboard/boardRenderer';
	import { generateElementId, type Point, type StrokeElement } from '$lib/whiteboard/elementTypes';
	import { normalizeRect } from '$lib/whiteboard/coords';
	import type {
		PresenterOverlayElement,
		PresenterOverlayTool
	} from '$lib/calling/presenterOverlay';

	export let elements: PresenterOverlayElement[] = [];
	export let enabled = false;
	export let active = false;
	export let tool: PresenterOverlayTool = 'pen';
	export let strokeColor = '#f8fafc';
	export let strokeWidth = 4;
	export let tileLabel = '';
	export let onChange: (elements: PresenterOverlayElement[]) => void = () => {};
	export let onActivate: () => void = () => {};

	type PreviewElement = PresenterOverlayElement | null;

	let containerEl: HTMLDivElement;
	let canvasEl: HTMLCanvasElement;
	let canvasWidth = 0;
	let canvasHeight = 0;
	let dpr = 1;
	let resizeObserver: ResizeObserver | null = null;
	let renderScheduled = false;
	let frameId = 0;
	let preview: PreviewElement = null;
	let currentPointerId: number | null = null;
	let interactionLabel = '';
	let overlayCursor = 'default';

	const viewport = { x: 0, y: 0, zoom: 1 };

	function requestRender(): void {
		if (renderScheduled) return;
		renderScheduled = true;
		frameId = requestAnimationFrame(renderCanvas);
	}

	function renderCanvas(): void {
		renderScheduled = false;
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		ctx.save();
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, canvasWidth, canvasHeight);
		renderElements(ctx, elements, viewport);
		if (preview) {
			renderDrawPreview(ctx, preview, viewport);
		}
		ctx.restore();
	}

	function updateSize(): void {
		if (!containerEl || !canvasEl) return;
		const rect = containerEl.getBoundingClientRect();
		canvasWidth = rect.width;
		canvasHeight = rect.height;
		dpr = window.devicePixelRatio || 1;
		canvasEl.width = Math.max(1, Math.floor(canvasWidth * dpr));
		canvasEl.height = Math.max(1, Math.floor(canvasHeight * dpr));
		canvasEl.style.width = `${canvasWidth}px`;
		canvasEl.style.height = `${canvasHeight}px`;
		requestRender();
	}

	function computeStrokeBBox(points: Point[]): { x: number; y: number; width: number; height: number } {
		if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const point of points) {
			if (point.x < minX) minX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.x > maxX) maxX = point.x;
			if (point.y > maxY) maxY = point.y;
		}
		return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
	}

	function simplifyPoints(points: Point[], minDist = 2): Point[] {
		if (points.length <= 2) return points;
		const output: Point[] = [points[0]];
		for (let index = 1; index < points.length; index += 1) {
			const last = output[output.length - 1];
			const point = points[index];
			const dx = point.x - last.x;
			const dy = point.y - last.y;
			if (dx * dx + dy * dy >= minDist * minDist) {
				output.push(point);
			}
		}
		const finalPoint = points[points.length - 1];
		if (output[output.length - 1] !== finalPoint) {
			output.push(finalPoint);
		}
		return output;
	}

	function buildShapeElement(
		nextTool: PresenterOverlayTool,
		startX: number,
		startY: number,
		endX: number,
		endY: number,
		zIndex: number
	): PresenterOverlayElement {
		const base = {
			id: generateElementId(),
			type: nextTool === 'arrow' ? 'arrow' : nextTool,
			x: startX,
			y: startY,
			width: 0,
			height: 0,
			rotation: 0,
			zIndex,
			opacity: 1,
			strokeColor,
			strokeWidth,
			fillColor: 'transparent',
			createdBy: 'presenter-local',
			updatedAt: Date.now(),
			locked: false
		};

		if (nextTool === 'arrow') {
			return {
				...base,
				type: 'arrow',
				width: endX - startX,
				height: endY - startY,
				arrowHead: 'end'
			};
		}

		const rect = normalizeRect(startX, startY, endX - startX, endY - startY);
		if (nextTool === 'rect') {
			return {
				...base,
				type: 'rect',
				...rect,
				borderRadius: 0
			};
		}

		return {
			...base,
			type: 'ellipse',
			...rect
		};
	}

	function commitElement(element: PresenterOverlayElement): void {
		onChange([...elements, element]);
	}

	function getNextZIndex(): number {
		return elements.reduce((max, element) => Math.max(max, element.zIndex), 0) + 1;
	}

	function makePointerPoint(event: PointerEvent): { x: number; y: number } {
		const rect = canvasEl.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top
		};
	}

	function handlePointerDown(event: PointerEvent): void {
		if (!enabled) return;
		onActivate();
		if (!active) {
			interactionLabel = `Overlay focused on ${tileLabel || 'screen'}.`;
			return;
		}
		if (event.button !== 0) return;
		event.preventDefault();
		currentPointerId = event.pointerId;
		canvasEl.setPointerCapture(event.pointerId);

		const start = makePointerPoint(event);
		const zIndex = getNextZIndex();

		if (tool === 'pen') {
			const points: Point[] = [{ x: start.x, y: start.y, pressure: event.pressure || 0.5 }];
			preview = {
				id: generateElementId(),
				type: 'stroke',
				x: start.x,
				y: start.y,
				width: 0,
				height: 0,
				rotation: 0,
				zIndex,
				opacity: 1,
				strokeColor,
				strokeWidth,
				fillColor: 'transparent',
				createdBy: 'presenter-local',
				updatedAt: Date.now(),
				locked: false,
				points
			} satisfies StrokeElement;

			const onMove = (moveEvent: PointerEvent) => {
				if (moveEvent.pointerId !== currentPointerId || !preview || preview.type !== 'stroke') return;
				const nextPoint = makePointerPoint(moveEvent);
				preview = {
					...preview,
					points: [...preview.points, { x: nextPoint.x, y: nextPoint.y, pressure: moveEvent.pressure || 0.5 }]
				};
				requestRender();
			};

			const onUp = (upEvent: PointerEvent) => {
				if (upEvent.pointerId !== currentPointerId || !preview || preview.type !== 'stroke') return;
				const simplified = simplifyPoints(preview.points);
				if (simplified.length > 0) {
					commitElement({
						...preview,
						...computeStrokeBBox(simplified),
						points: simplified
					});
				}
				cleanupInteraction();
			};

			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp, { once: false });
			window.addEventListener('pointercancel', onUp, { once: false });

			cleanupCurrentInteraction = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
				window.removeEventListener('pointercancel', onUp);
			};
			requestRender();
			return;
		}

		preview = buildShapeElement(tool, start.x, start.y, start.x, start.y, zIndex);
		const onMove = (moveEvent: PointerEvent) => {
			if (moveEvent.pointerId !== currentPointerId || !preview) return;
			const nextPoint = makePointerPoint(moveEvent);
			preview = buildShapeElement(tool, start.x, start.y, nextPoint.x, nextPoint.y, zIndex);
			requestRender();
		};
		const onUp = (upEvent: PointerEvent) => {
			if (upEvent.pointerId !== currentPointerId || !preview) return;
			if (Math.abs(preview.width) >= 3 || Math.abs(preview.height) >= 3) {
				commitElement(preview);
			}
			cleanupInteraction();
		};

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp, { once: false });
		window.addEventListener('pointercancel', onUp, { once: false });

		cleanupCurrentInteraction = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
		};
		requestRender();
	}

	let cleanupCurrentInteraction: (() => void) | null = null;

	function cleanupInteraction(): void {
		if (currentPointerId !== null && canvasEl?.hasPointerCapture(currentPointerId)) {
			canvasEl.releasePointerCapture(currentPointerId);
		}
		cleanupCurrentInteraction?.();
		cleanupCurrentInteraction = null;
		currentPointerId = null;
		preview = null;
		requestRender();
	}

	onMount(() => {
		resizeObserver = new ResizeObserver(updateSize);
		resizeObserver.observe(containerEl);
		updateSize();
	});

	onDestroy(() => {
		cleanupInteraction();
		resizeObserver?.disconnect();
		cancelAnimationFrame(frameId);
	});

	$: requestRender();
	$: overlayCursor = !enabled ? 'default' : active ? 'crosshair' : 'pointer';
</script>

<div class="presenter-overlay-shell" bind:this={containerEl}>
	<canvas
		bind:this={canvasEl}
		class="presenter-overlay-canvas"
		class:is-enabled={enabled}
		class:is-active={active}
		data-presenter-overlay-canvas="true"
		on:pointerdown={handlePointerDown}
		style="cursor: {overlayCursor};"
	></canvas>

	{#if enabled && !active}
		<div class="presenter-overlay-hint">Click to annotate this screen</div>
	{/if}

	{#if enabled && active}
		<div class="presenter-overlay-pill">Presenter Overlay</div>
	{/if}

	{#if interactionLabel}
		<div class="sr-only" aria-live="polite">{interactionLabel}</div>
	{/if}
</div>

<style>
	.presenter-overlay-shell {
		position: absolute;
		inset: 0;
		z-index: 2;
	}

	.presenter-overlay-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		touch-action: none;
	}

	.presenter-overlay-canvas.is-enabled {
		pointer-events: auto;
	}

	.presenter-overlay-hint,
	.presenter-overlay-pill {
		position: absolute;
		left: 0.65rem;
		top: 0.65rem;
		padding: 0.28rem 0.5rem;
		border-radius: 999px;
		background: rgba(15, 23, 42, 0.78);
		border: 1px solid rgba(255, 255, 255, 0.16);
		color: #f8fafc;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		backdrop-filter: blur(6px);
		pointer-events: none;
	}

	.presenter-overlay-hint {
		color: rgba(226, 232, 240, 0.92);
	}

	.presenter-overlay-pill {
		background: rgba(15, 23, 42, 0.86);
		color: #fef3c7;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
