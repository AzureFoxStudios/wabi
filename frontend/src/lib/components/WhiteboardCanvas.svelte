<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import {
		boardStore,
		elements,
		layers,
		viewport,
		activeTool,
		selection
	} from '$lib/whiteboard/boardStore';
	import type { ToolType } from '$lib/whiteboard/boardStore';
	import {
		renderElements,
		renderGrid,
		renderSelectionBox,
		renderHandles,
		renderDrawPreview,
		renderSelectionRect,
		renderRemoteCursors,
		preloadImage
	} from '$lib/whiteboard/boardRenderer';
	import {
		screenToBoard,
		getSelectionBBox,
		getSelectionHandles
	} from '$lib/whiteboard/coords';
	import type { BoardElement, TextElement } from '$lib/whiteboard/elementTypes';
	import {
		getToolHandler,
		onTextPlacement,
		type ToolPointerEvent,
		type ToolInteraction,
		type TextPlacement
	} from '$lib/whiteboard/tools';
	import { broadcastCursor } from '$lib/whiteboard/boardSync';
	import {
		dequeueWhiteboardImport,
		queueWhiteboardImport,
		whiteboardPendingImports,
		type PendingWhiteboardImport
	} from '$lib/whiteboard/whiteboardSurface';
	import { createWhiteboardImageElement, uploadWhiteboardImage } from '$lib/whiteboard/imageImports';
	import {
		resolveWhiteboardLayerId,
		resolveWritableWhiteboardLayerId
	} from '$lib/whiteboard/layers';

	export let remoteCursors: Array<{ userId: string; username: string; color: string; x: number; y: number }> = [];
	export let boardId = '';
	export let channelId = '';
	export let username = '';
	export let userColor = '#6366f1';
	export let syncReady = false;
	export let showGrid = true;

	let containerEl: HTMLDivElement;
	let baseCanvas: HTMLCanvasElement;
	let interactionCanvas: HTMLCanvasElement;
	let textOverlay: HTMLTextAreaElement | null = null;

	let canvasWidth = 0;
	let canvasHeight = 0;
	let dpr = 1;
	let animFrameId = 0;

	// Interaction state
	let currentInteraction: ToolInteraction | null = null;
	let isSpacePanning = false;
	let importBusy = false;
	let importError = '';
	let importErrorTimer: ReturnType<typeof setTimeout> | null = null;
	let isDragHover = false;
	let pendingImportsForChannel: PendingWhiteboardImport[] = [];
	let importPreviewUrls = new Map<string, string>();
	let importPreviewCards: Array<{
		id: string;
		fileName: string;
		previewUrl: string;
		source: PendingWhiteboardImport['source'];
		status: 'uploading' | 'queued';
	}> = [];

	// Text editing state
	let textEditing = false;
	let textEditX = 0;
	let textEditY = 0;
	let textEditValue = '';
	let textEditPlacement: TextPlacement | null = null;

	// -----------------------------------------------------------------------
	// ResizeObserver + DPR-aware sizing
	// -----------------------------------------------------------------------

	let resizeObserver: ResizeObserver;

	function updateSize() {
		if (!containerEl) return;
		const rect = containerEl.getBoundingClientRect();
		canvasWidth = rect.width;
		canvasHeight = rect.height;
		dpr = window.devicePixelRatio || 1;

		for (const c of [baseCanvas, interactionCanvas]) {
			if (!c) continue;
			c.width = canvasWidth * dpr;
			c.height = canvasHeight * dpr;
			c.style.width = `${canvasWidth}px`;
			c.style.height = `${canvasHeight}px`;
		}
		requestRender();
	}

	// -----------------------------------------------------------------------
	// Render loop
	// -----------------------------------------------------------------------

	let renderScheduled = false;

	function requestRender() {
		if (renderScheduled) return;
		renderScheduled = true;
		animFrameId = requestAnimationFrame(render);
	}

	function render() {
		renderScheduled = false;
		if (!baseCanvas || !interactionCanvas) return;

		const vp = get(viewport);
		const els = get(elements);
		const sel = get(selection);

		// Base canvas: committed elements
		const baseCtx = baseCanvas.getContext('2d')!;
		baseCtx.save();
		baseCtx.scale(dpr, dpr);
		baseCtx.clearRect(0, 0, canvasWidth, canvasHeight);
		if (showGrid) {
			renderGrid(baseCtx, vp, canvasWidth, canvasHeight, 24);
		}
		renderElements(baseCtx, els, vp, get(layers));
		baseCtx.restore();

		// Interaction canvas: preview, selection, cursors
		const intCtx = interactionCanvas.getContext('2d')!;
		intCtx.save();
		intCtx.scale(dpr, dpr);
		intCtx.clearRect(0, 0, canvasWidth, canvasHeight);

		// Draw preview (in-progress shape)
		if (currentInteraction) {
			const preview = currentInteraction.getPreview();
			if (preview) renderDrawPreview(intCtx, preview, vp);
			const selRect = currentInteraction.getSelectionRect();
			if (selRect) renderSelectionRect(intCtx, selRect, vp);
		}

		// Selection box & handles
		if (sel.size > 0) {
			const currentLayers = get(layers);
			const selectedEls = els.filter((e) => sel.has(e.id) && currentLayers.find((layer) => layer.id === e.layerId)?.visible !== false);
			const bbox = getSelectionBBox(selectedEls);
			if (bbox) {
				renderSelectionBox(intCtx, bbox, vp);
				const handles = getSelectionHandles(bbox, vp, 8);
				renderHandles(intCtx, handles);
			}
		}

		// Remote cursors
		if (remoteCursors.length > 0) {
			renderRemoteCursors(intCtx, remoteCursors, vp);
		}

		intCtx.restore();
	}

	// Subscribe to store changes to trigger re-render
	const unsubEls = elements.subscribe(() => requestRender());
	const unsubVp = viewport.subscribe(() => requestRender());
	const unsubSel = selection.subscribe(() => requestRender());
	const unsubPendingImports = whiteboardPendingImports.subscribe((pendingByChannel) => {
		pendingImportsForChannel = channelId ? (pendingByChannel[channelId] || []) : [];
		void maybeProcessPendingImports();
	});
	$: remoteCursors, requestRender();
	$: channelId, void maybeProcessPendingImports();
	$: boardId, void maybeProcessPendingImports();
	$: syncReady, void maybeProcessPendingImports();
	$: showGrid, requestRender();
	$: syncImportPreviews(pendingImportsForChannel);
	$: importPreviewCards = pendingImportsForChannel.slice(0, 3).map((item, index) => ({
		id: item.id,
		fileName: item.file.name,
		previewUrl: importPreviewUrls.get(item.id) || '',
		source: item.source,
		status: importBusy && index === 0 ? 'uploading' : 'queued'
	}));

	// -----------------------------------------------------------------------
	// Pointer events → tool handler
	// -----------------------------------------------------------------------

	function makeToolEvent(e: PointerEvent): ToolPointerEvent {
		const rect = interactionCanvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const vp = get(viewport);
		const board = screenToBoard(sx, sy, vp);
		return {
			boardX: board.x,
			boardY: board.y,
			screenX: sx,
			screenY: sy,
			pressure: e.pressure || 0.5,
			shiftKey: e.shiftKey,
			ctrlKey: e.ctrlKey || e.metaKey,
			altKey: e.altKey,
			button: e.button
		};
	}

	function handlePointerDown(e: PointerEvent) {
		if (textEditing) return;
		containerEl?.focus();

		// Middle mouse always pans
		if (e.button === 1) {
			e.preventDefault();
			const panHandler = getToolHandler('pan');
			currentInteraction = panHandler.onPointerDown(makeToolEvent(e));
			interactionCanvas.setPointerCapture(e.pointerId);
			return;
		}

		if (e.button !== 0) return;

		const toolType = isSpacePanning ? 'pan' : get(activeTool);
		const handler = getToolHandler(toolType);
		currentInteraction = handler.onPointerDown(makeToolEvent(e));
		if (currentInteraction) {
			interactionCanvas.setPointerCapture(e.pointerId);
		}
		requestRender();
	}

	function handlePointerMove(e: PointerEvent) {
		if (currentInteraction) {
			currentInteraction.onPointerMove(makeToolEvent(e));
			requestRender();
		}

		// Broadcast cursor position
		if (boardId) {
			const te = makeToolEvent(e);
			broadcastCursor(boardId, { x: te.boardX, y: te.boardY, username, color: userColor });
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (currentInteraction) {
			currentInteraction.onPointerUp(makeToolEvent(e));
			currentInteraction = null;
			if (interactionCanvas.hasPointerCapture(e.pointerId)) {
				interactionCanvas.releasePointerCapture(e.pointerId);
			}
			requestRender();
		}
	}

	function handlePointerCancel(e: PointerEvent) {
		if (!currentInteraction) return;
		currentInteraction = null;
		if (interactionCanvas.hasPointerCapture(e.pointerId)) {
			interactionCanvas.releasePointerCapture(e.pointerId);
		}
		requestRender();
	}

	function dataTransferHasImages(dataTransfer: DataTransfer | null): boolean {
		if (!dataTransfer) return false;
		if (dataTransfer.files?.length) {
			return Array.from(dataTransfer.files).some((file) => file.type.startsWith('image/'));
		}
		return Array.from(dataTransfer.items || []).some((item) => item.type.startsWith('image/'));
	}

	function queueFiles(files: File[], source: 'clipboard' | 'drop'): void {
		if (!channelId) return;
		const imageFiles = files.filter((file) => file.type.startsWith('image/'));
		if (imageFiles.length === 0) return;
		for (const file of imageFiles) {
			queueWhiteboardImport(channelId, file, source);
		}
	}

	function syncImportPreviews(queue: PendingWhiteboardImport[]): void {
		const nextIds = new Set(queue.map((item) => item.id));
		for (const item of queue) {
			if (!importPreviewUrls.has(item.id)) {
				importPreviewUrls.set(item.id, URL.createObjectURL(item.file));
			}
		}
		for (const [importId, previewUrl] of importPreviewUrls.entries()) {
			if (nextIds.has(importId)) continue;
			URL.revokeObjectURL(previewUrl);
			importPreviewUrls.delete(importId);
		}
	}

	function clearImportError(): void {
		importError = '';
		if (importErrorTimer) {
			clearTimeout(importErrorTimer);
			importErrorTimer = null;
		}
	}

	function setImportError(message: string): void {
		importError = message;
		if (importErrorTimer) {
			clearTimeout(importErrorTimer);
		}
		importErrorTimer = setTimeout(() => {
			importError = '';
			importErrorTimer = null;
		}, 6000);
	}

	function describeImportSource(source: 'clipboard' | 'drop' | 'capture'): string {
		switch (source) {
			case 'clipboard':
				return 'Clipboard';
			case 'drop':
				return 'Drop';
			case 'capture':
				return 'Capture';
			default:
				return 'Import';
		}
	}

	function resolveImportLayer(item: PendingWhiteboardImport): { layerId: string } {
		const state = get(boardStore);
		if (item.layerId) {
			return {
				layerId: resolveWhiteboardLayerId(state.layers, item.layerId)
			};
		}

		if (item.layerMode === 'reference') {
			const layer = boardStore.ensureLayer({
				id: 'layer-reference',
				name: 'Reference',
				kind: 'reference',
				visible: true,
				locked: true,
				opacity: 0.82
			});
			return { layerId: layer.id };
		}

		if (item.layerMode === 'background') {
			const layer = boardStore.ensureLayer({
				id: 'layer-background',
				name: 'Background',
				kind: 'background',
				visible: true,
				locked: true,
				opacity: 1
			});
			return { layerId: layer.id };
		}

		return {
			layerId: resolveWritableWhiteboardLayerId(state.layers, state.activeLayerId)
		};
	}

	async function maybeProcessPendingImports(): Promise<void> {
		if (!syncReady || importBusy || !channelId || !boardId || pendingImportsForChannel.length === 0) return;
		const nextImport = pendingImportsForChannel[0];
		importBusy = true;
		clearImportError();
		try {
			const uploaded = await uploadWhiteboardImage(boardId, nextImport.file);
			const state = get(boardStore);
			const targetLayer = resolveImportLayer(nextImport);
			const imageEl = createWhiteboardImageElement(
				uploaded,
				state.viewport,
				canvasWidth || containerEl?.clientWidth || 960,
				canvasHeight || containerEl?.clientHeight || 640,
				state.elements
					.filter((element) => element.layerId === targetLayer.layerId)
					.reduce((max, element) => Math.max(max, element.zIndex), 0),
				targetLayer.layerId
			);
			boardStore.addElement(imageEl);
			preloadImage(uploaded.fileUrl);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to import image';
			setImportError(`Failed to import ${nextImport.file.name}: ${message}`);
		} finally {
			dequeueWhiteboardImport(channelId, nextImport.id);
			importBusy = false;
			void maybeProcessPendingImports();
		}
	}

	// -----------------------------------------------------------------------
	// Wheel: Ctrl+scroll = zoom, plain scroll = pan
	// -----------------------------------------------------------------------

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const vp = get(viewport);

		if (e.ctrlKey || e.metaKey) {
			// Zoom centered on cursor
			const rect = interactionCanvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const board = screenToBoard(sx, sy, vp);
			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			boardStore.zoomTo(vp.zoom * factor, board.x, board.y);
		} else {
			// Pan
			boardStore.panBy(e.deltaX / vp.zoom, e.deltaY / vp.zoom);
		}
	}

	// -----------------------------------------------------------------------
	// Keyboard shortcuts
	// -----------------------------------------------------------------------

	function handleKeyDown(e: KeyboardEvent) {
		// Don't capture when text editing
		if (textEditing) {
			if (e.key === 'Escape') commitTextEdit();
			return;
		}

		// Don't capture when typing in an input
		const tag = (e.target as HTMLElement)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

		const ctrl = e.ctrlKey || e.metaKey;

		// Tool shortcuts
		if (!ctrl && !e.altKey) {
			const toolMap: Record<string, ToolType> = {
				v: 'select', s: 'select',
				p: 'pen', d: 'pen',
				l: 'line',
				r: 'rect',
				e: 'ellipse', o: 'ellipse',
				a: 'arrow',
				t: 'text'
			};
			if (toolMap[e.key.toLowerCase()]) {
				e.preventDefault();
				boardStore.setTool(toolMap[e.key.toLowerCase()]);
				return;
			}
		}

		// Space = temporary pan
		if (e.key === ' ' && !e.repeat) {
			e.preventDefault();
			isSpacePanning = true;
			return;
		}

		// Delete selection
		if (e.key === 'Delete' || e.key === 'Backspace') {
			const sel = get(selection);
			if (sel.size > 0) {
				e.preventDefault();
				boardStore.deleteElements([...sel]);
			}
			return;
		}

		// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
		if (ctrl && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			if (e.shiftKey) boardStore.redo();
			else boardStore.undo();
			return;
		}
		if (ctrl && e.key.toLowerCase() === 'y') {
			e.preventDefault();
			boardStore.redo();
			return;
		}

		// Ctrl+A - select all
		if (ctrl && e.key.toLowerCase() === 'a') {
			e.preventDefault();
			boardStore.selectAll();
			return;
		}

		// Ctrl+D - duplicate
		if (ctrl && e.key.toLowerCase() === 'd') {
			const sel = get(selection);
			if (sel.size > 0) {
				e.preventDefault();
				boardStore.duplicateElements([...sel]);
			}
			return;
		}

		// Escape - clear selection
		if (e.key === 'Escape') {
			boardStore.clearSelection();
			boardStore.setTool('select');
			return;
		}
	}

	function handleKeyUp(e: KeyboardEvent) {
		if (e.key === ' ') {
			isSpacePanning = false;
		}
	}

	// -----------------------------------------------------------------------
	// Text editing overlay
	// -----------------------------------------------------------------------

	const unsubTextPlacement = onTextPlacement((placement) => {
		const vp = get(viewport);
		const screen = {
			x: (placement.x - vp.x) * vp.zoom,
			y: (placement.y - vp.y) * vp.zoom
		};
		textEditing = true;
		textEditX = screen.x;
		textEditY = screen.y;
		textEditValue = '';
		textEditPlacement = placement;

		// Focus the textarea on next tick
		requestAnimationFrame(() => {
			if (textOverlay) textOverlay.focus();
		});
	});

	function commitTextEdit() {
		if (!textEditPlacement) {
			textEditing = false;
			return;
		}
		const text = textEditValue.trim();
		if (text) {
			const style = textEditPlacement.style;
			const el: TextElement = {
				id: textEditPlacement.elementId,
				type: 'text',
				x: textEditPlacement.x,
				y: textEditPlacement.y,
				width: 200,
				height: 30,
				rotation: 0,
				zIndex: textEditPlacement.maxZ,
				layerId: textEditPlacement.layerId,
				opacity: 1,
				strokeColor: style.strokeColor,
				strokeWidth: style.strokeWidth,
				fillColor: style.fillColor,
				createdBy: '',
				updatedAt: Date.now(),
				locked: false,
				text,
				fontSize: 16,
				fontFamily: 'sans-serif',
				textAlign: 'left'
			};
			boardStore.addElement(el);
		}
		textEditing = false;
		textEditPlacement = null;
	}

	// -----------------------------------------------------------------------
	// Image paste handler
	// -----------------------------------------------------------------------

	async function handlePaste(e: ClipboardEvent) {
		if (textEditing) return;

		const items = e.clipboardData?.items;
		if (!items) return;

		for (const item of items) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) continue;
				queueFiles([file], 'clipboard');
				break;
			}
		}
	}

	function handleDragEnter(event: DragEvent) {
		if (!dataTransferHasImages(event.dataTransfer)) return;
		event.preventDefault();
		isDragHover = true;
	}

	function handleDragOver(event: DragEvent) {
		if (!dataTransferHasImages(event.dataTransfer)) return;
		event.preventDefault();
		isDragHover = true;
	}

	function handleDragLeave(event: DragEvent) {
		if ((event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node | null)) {
			return;
		}
		isDragHover = false;
	}

	function handleDrop(event: DragEvent) {
		if (!dataTransferHasImages(event.dataTransfer)) return;
		event.preventDefault();
		isDragHover = false;
		queueFiles(Array.from(event.dataTransfer?.files || []), 'drop');
	}

	// -----------------------------------------------------------------------
	// Cursor style
	// -----------------------------------------------------------------------

	$: cursorStyle = (() => {
		if (isSpacePanning) return 'grab';
		const tool = $activeTool;
		const handler = getToolHandler(tool);
		return handler.cursor;
	})();

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	onMount(() => {
		resizeObserver = new ResizeObserver(updateSize);
		resizeObserver.observe(containerEl);
		updateSize();
	});

	onDestroy(() => {
		resizeObserver?.disconnect();
		cancelAnimationFrame(animFrameId);
		unsubEls();
		unsubVp();
		unsubSel();
		unsubPendingImports();
		unsubTextPlacement();
		clearImportError();
		for (const previewUrl of importPreviewUrls.values()) {
			URL.revokeObjectURL(previewUrl);
		}
		importPreviewUrls.clear();
	});
</script>

<svelte:window on:keydown={handleKeyDown} on:keyup={handleKeyUp} />

<div
	class="whiteboard-canvas-container"
	bind:this={containerEl}
	role="region"
	aria-label="Whiteboard canvas"
	on:paste={handlePaste}
	on:dragenter={handleDragEnter}
	on:dragover={handleDragOver}
	on:dragleave={handleDragLeave}
	on:drop={handleDrop}
	tabindex="-1"
>
	<canvas
		bind:this={baseCanvas}
		class="whiteboard-layer base-layer"
	></canvas>
	<canvas
		bind:this={interactionCanvas}
		class="whiteboard-layer interaction-layer"
		style="cursor: {cursorStyle}"
		on:pointerdown={handlePointerDown}
		on:pointermove={handlePointerMove}
		on:pointerup={handlePointerUp}
		on:pointercancel={handlePointerCancel}
		on:wheel|preventDefault={handleWheel}
		on:contextmenu|preventDefault
	></canvas>

	{#if textEditing}
		<textarea
			bind:this={textOverlay}
			class="text-edit-overlay"
			style="left: {textEditX}px; top: {textEditY}px;"
			bind:value={textEditValue}
			on:blur={commitTextEdit}
			on:keydown={(e) => { if (e.key === 'Escape') commitTextEdit(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitTextEdit(); } }}
		></textarea>
	{/if}

	{#if importPreviewCards.length > 0 || importError || isDragHover}
		<div class="whiteboard-import-hud">
			{#if isDragHover}
				<div class="whiteboard-import-overlay" role="status" aria-live="polite">
					<div>Drop images to add them to the board</div>
				</div>
			{/if}

			{#if importError}
				<div class="whiteboard-import-overlay is-error" role="alert">
					<div>{importError}</div>
				</div>
			{/if}

			{#if importPreviewCards.length > 0}
				<div class="whiteboard-import-queue" role="status" aria-live="polite">
					{#each importPreviewCards as importCard}
						<div class="whiteboard-import-card" class:is-active={importCard.status === 'uploading'}>
							{#if importCard.previewUrl}
								<img
									class="whiteboard-import-thumb"
									src={importCard.previewUrl}
									alt=""
								/>
							{:else}
								<div class="whiteboard-import-thumb whiteboard-import-thumb--empty"></div>
							{/if}
							<div class="whiteboard-import-copy">
								<div class="whiteboard-import-name">{importCard.fileName}</div>
								<div class="whiteboard-import-meta">
									{describeImportSource(importCard.source)}
									<span aria-hidden="true">•</span>
									{importCard.status === 'uploading' ? 'Uploading' : 'Queued'}
								</div>
							</div>
						</div>
					{/each}
					{#if pendingImportsForChannel.length > importPreviewCards.length}
						<div class="whiteboard-import-more">
							+{pendingImportsForChannel.length - importPreviewCards.length} more queued
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.whiteboard-canvas-container {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		outline: none;
		background:
			linear-gradient(180deg, rgba(255, 253, 247, 0.98), rgba(247, 240, 226, 0.82)),
			linear-gradient(90deg, rgba(var(--text-muted-rgb, 148, 163, 184), 0.13) 1px, transparent 1px),
			linear-gradient(rgba(var(--text-muted-rgb, 148, 163, 184), 0.13) 1px, transparent 1px),
			linear-gradient(180deg, var(--surface-base, #fffef9) 0%, var(--surface-sunken, #f5ecdd) 100%);
		background-size: auto, 26px 26px, 26px 26px, auto;
	}

	.whiteboard-layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.base-layer {
		z-index: 0;
	}

	.interaction-layer {
		z-index: 1;
		touch-action: none;
	}

	.text-edit-overlay {
		position: absolute;
		z-index: 10;
		min-width: 100px;
		min-height: 28px;
		padding: 4px 6px;
		font-size: 16px;
		font-family: sans-serif;
		color: var(--surface-app, #1f2937);
		background: rgba(255, 251, 235, 0.98);
		border: 1.5px solid rgba(59, 130, 246, 0.42);
		border-radius: 4px;
		outline: none;
		resize: both;
		box-shadow: 0 10px 24px rgba(var(--surface-app-rgb, 15, 23, 42), 0.14);
	}

	.whiteboard-import-hud {
		position: absolute;
		inset: 0;
		z-index: 12;
		pointer-events: none;
	}

	.whiteboard-import-overlay {
		position: absolute;
		inset: auto 16px 16px auto;
		max-width: min(320px, calc(100% - 32px));
		padding: 10px 14px;
		border-radius: 10px;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.9);
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.18);
		color: var(--text-inverse, #e2e8f0);
		box-shadow: 0 16px 32px rgba(var(--surface-app-rgb, 2, 6, 23), 0.35);
		backdrop-filter: blur(10px);
		pointer-events: none;
	}

	.whiteboard-import-overlay.is-error {
		inset: 16px 16px auto auto;
		background: rgba(var(--color-danger-rgb, 127, 29, 29), 0.9);
		border-color: rgba(var(--color-danger-rgb, 248, 113, 113), 0.35);
		color: var(--accent-danger-soft, var(--accent-danger-soft, #fecaca));
	}

	.whiteboard-import-queue {
		position: absolute;
		right: 16px;
		bottom: 16px;
		display: grid;
		gap: 0.65rem;
		width: min(360px, calc(100% - 32px));
	}

	.whiteboard-import-card {
		display: grid;
		grid-template-columns: 56px minmax(0, 1fr);
		gap: 0.8rem;
		padding: 0.7rem;
		border-radius: 14px;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.88);
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.16);
		box-shadow: 0 18px 32px rgba(var(--surface-app-rgb, 2, 6, 23), 0.3);
		backdrop-filter: blur(14px);
	}

	.whiteboard-import-card.is-active {
		border-color: rgba(var(--accent-primary-rgb, 99, 102, 241), 0.45);
		box-shadow: 0 22px 36px rgba(var(--surface-base-rgb, 30, 41, 59), 0.38);
	}

	.whiteboard-import-thumb {
		width: 56px;
		height: 56px;
		object-fit: cover;
		border-radius: 10px;
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.18);
		background: rgba(var(--surface-base-rgb, 30, 41, 59), 0.72);
	}

	.whiteboard-import-thumb--empty {
		background:
			linear-gradient(135deg, rgba(var(--accent-primary-rgb, 99, 102, 241), 0.24), rgba(14, 165, 233, 0.12)),
			rgba(var(--surface-base-rgb, 30, 41, 59), 0.72);
	}

	.whiteboard-import-copy {
		min-width: 0;
		display: grid;
		gap: 0.3rem;
		align-content: center;
	}

	.whiteboard-import-name {
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--text-inverse, var(--text-inverse, #f8fafc));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.whiteboard-import-meta {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.76rem;
		color: var(--text-secondary, #cbd5e1);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.whiteboard-import-more {
		justify-self: end;
		padding: 0.15rem 0.35rem;
		font-size: 0.78rem;
		color: var(--text-secondary, #cbd5e1);
	}
</style>
