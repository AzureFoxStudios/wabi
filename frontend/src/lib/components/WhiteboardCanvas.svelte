<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { boardStore, elements, layers, viewport, activeTool, selection, canUndo, canRedo, policy } from '$lib/whiteboard/boardStore';
	import { hitTestHandle } from '$lib/whiteboard/coords';
	import type { ToolType } from '$lib/whiteboard/boardStore';
	import { renderElements, renderLayersWithBlend, renderGrid, renderSelectionBox, renderHandles, renderDrawPreview, renderSelectionRect, renderRemoteCursors, preloadImage } from '$lib/whiteboard/boardRenderer';
	import { screenToBoard, getSelectionBBox, getSelectionHandles } from '$lib/whiteboard/coords';
	import type { BoardElement, TextElement } from '$lib/whiteboard/elementTypes';
	import { getToolHandler, onTextPlacement, type ToolPointerEvent, type ToolInteraction, type TextPlacement } from '$lib/whiteboard/tools';
	import { broadcastCursor } from '$lib/whiteboard/boardSync';
	import { dequeueWhiteboardImport, queueWhiteboardImport, whiteboardPendingImports, type PendingWhiteboardImport } from '$lib/whiteboard/whiteboardSurface';
	import { createWhiteboardImageElement, uploadWhiteboardImage } from '$lib/whiteboard/imageImports';
	import { resolveWhiteboardLayerId, resolveWritableWhiteboardLayerId } from '$lib/whiteboard/layers';
import { rasterCanUndo, rasterUndo } from '$lib/whiteboard/rasterLayers';
	import './WhiteboardCanvas.css';

	export let remoteCursors: Array<{ userId: string; username: string; color: string; x: number; y: number }> = [];
	export let boardId = '';
	export let channelId = '';
	export let username = '';
	export let userColor = '#6366f1';
	export let syncReady = false;
	export let showGrid = true;
	export let readOnly = false;

	const drawingTools: ReadonlySet<string> = new Set(['pen', 'line', 'rect', 'ellipse', 'arrow', 'text']);
	const cursorDisplay = new Map<string, { userId: string; username: string; color: string; x: number; y: number; tx: number; ty: number }>();
	let cursorAnimId = 0;

	let containerEl: HTMLDivElement;
	let baseCanvas: HTMLCanvasElement;
	let interactionCanvas: HTMLCanvasElement;
	let textOverlay: HTMLTextAreaElement | null = null;
	let canvasWidth = 0;
	let canvasHeight = 0;
	let dpr = 1;
	let animFrameId = 0;
	let currentInteraction: ToolInteraction | null = null;
	let isSpacePanning = false;
	let importBusy = false;
	let importError = '';
	let importErrorTimer: ReturnType<typeof setTimeout> | null = null;
	let isDragHover = false;
	let pendingImportsForChannel: PendingWhiteboardImport[] = [];
	let importPreviewUrls = new Map<string, string>();
	let importPreviewCards: Array<{ id: string; fileName: string; previewUrl: string; source: PendingWhiteboardImport['source']; status: 'uploading' | 'queued' }> = [];
	let textEditing = false;
	let textEditX = 0;
	let textEditY = 0;
	let textEditValue = '';
	let textEditPlacement: TextPlacement | null = null;
	let resizeObserver: ResizeObserver;
	let renderScheduled = false;
	let baseDirty = false;
	let overlayDirty = false;
	let lastPointerX = 0;
	let lastPointerY = 0;
	let renderSamples = 0;
	let renderTotalMs = 0;
	let overlaySamples = 0;
	let overlayTotalMs = 0;

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
	function requestRender() {
		baseDirty = true;
		overlayDirty = true;
		scheduleRender();
	}
	function requestOverlayRender() {
		overlayDirty = true;
		scheduleRender();
	}
	function scheduleRender() {
		if (renderScheduled) return;
		renderScheduled = true;
		animFrameId = requestAnimationFrame(render);
	}
	function render() {
		renderScheduled = false;
		if (!baseCanvas || !interactionCanvas) return;
		if (baseDirty) {
			renderBase();
			baseDirty = false;
		}
		if (overlayDirty) {
			renderOverlay();
			overlayDirty = false;
		}
	}
	function renderBase() {
		const baseStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
		const vp = get(viewport);
		const els = get(elements);
		const baseCtx = baseCanvas.getContext('2d')!;
		baseCtx.save();
		baseCtx.scale(dpr, dpr);
		baseCtx.clearRect(0, 0, canvasWidth, canvasHeight);
		// Canvas background color
		if ($boardStore.canvasBgColor) {
			baseCtx.fillStyle = $boardStore.canvasBgColor;
			baseCtx.fillRect(0, 0, canvasWidth, canvasHeight);
		}
		if (showGrid) renderGrid(baseCtx, vp, canvasWidth, canvasHeight, 24);
		const currentLayers = get(layers);
		if (currentLayers.length > 0) {
			renderLayersWithBlend(baseCtx, els, vp, currentLayers, canvasWidth, canvasHeight, dpr);
		} else {
			renderElements(baseCtx, els, vp, currentLayers);
		}
		baseCtx.restore();
		if (baseStartedAt > 0 && typeof window !== 'undefined' && window.localStorage.getItem('wabi.whiteboard.perf') === '1') {
			renderSamples += 1;
			renderTotalMs += performance.now() - baseStartedAt;
			if (renderSamples % 60 === 0) {
				console.debug('[WhiteboardPerf] render', { samples: renderSamples, avgMs: renderTotalMs / renderSamples, elements: els.length, layers: currentLayers.length });
			}
		}
	}
	function renderOverlay() {
		const overlayStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
		const vp = get(viewport);
		const els = get(elements);
		const sel = get(selection);
		const intCtx = interactionCanvas.getContext('2d')!;
		intCtx.save();
		intCtx.scale(dpr, dpr);
		intCtx.clearRect(0, 0, canvasWidth, canvasHeight);
		if (currentInteraction) {
			const preview = currentInteraction.getPreview();
			if (preview) renderDrawPreview(intCtx, preview, vp);
			const selRect = currentInteraction.getSelectionRect();
			if (selRect) renderSelectionRect(intCtx, selRect, vp);
		}
		if (sel.size > 0) {
			const currentLayers = get(layers);
			const selectedEls = els.filter((e) => sel.has(e.id) && currentLayers.find((layer) => layer.id === e.layerId)?.visible !== false);
			const bbox = getSelectionBBox(selectedEls);
			if (bbox) {
				renderSelectionBox(intCtx, bbox, vp);
				const handles = getSelectionHandles(bbox, vp, 12);
				renderHandles(intCtx, handles);
			}
		}
		if (remoteCursors.length > 0) {
			const displayed = [...cursorDisplay.values()].map((cursor) => ({
				userId: cursor.userId,
				username: cursor.username,
				color: cursor.color,
				x: cursor.x,
				y: cursor.y
			}));
			renderRemoteCursors(intCtx, displayed, vp);
		}
		intCtx.restore();
		if (overlayStartedAt > 0 && typeof window !== 'undefined' && window.localStorage.getItem('wabi.whiteboard.perf') === '1') {
			overlaySamples += 1;
			overlayTotalMs += performance.now() - overlayStartedAt;
			if (overlaySamples % 60 === 0) {
				console.debug('[WhiteboardPerf] overlay', { samples: overlaySamples, avgMs: overlayTotalMs / overlaySamples, elements: els.length });
			}
		}
	}

	const unsubEls = elements.subscribe(() => requestRender());
	const unsubVp = viewport.subscribe(() => requestRender());
	const unsubSel = selection.subscribe(() => requestRender());
	const unsubPendingImports = whiteboardPendingImports.subscribe((pendingByChannel) => {
		pendingImportsForChannel = channelId ? (pendingByChannel[channelId] || []) : [];
		void maybeProcessPendingImports();
	});
	$: remoteCursors, syncCursorTargets();
	$: channelId, void maybeProcessPendingImports();
	$: boardId, void maybeProcessPendingImports();
	$: syncReady, void maybeProcessPendingImports();
	$: showGrid, requestRender();
	$: syncImportPreviews(pendingImportsForChannel);
	$: importPreviewCards = pendingImportsForChannel.slice(0, 3).map((item, index) => ({ id: item.id, fileName: item.file.name, previewUrl: importPreviewUrls.get(item.id) || '', source: item.source, status: importBusy && index === 0 ? 'uploading' : 'queued' }));

	function syncCursorTargets(): void {
		const seen = new Set<string>();
		for (const cursor of remoteCursors) {
			seen.add(cursor.userId);
			const existing = cursorDisplay.get(cursor.userId);
			if (existing) {
				existing.username = cursor.username;
				existing.color = cursor.color;
				existing.tx = cursor.x;
				existing.ty = cursor.y;
			} else {
				cursorDisplay.set(cursor.userId, {
					userId: cursor.userId,
					username: cursor.username,
					color: cursor.color,
					x: cursor.x,
					y: cursor.y,
					tx: cursor.x,
					ty: cursor.y
				});
			}
		}
		for (const id of [...cursorDisplay.keys()]) {
			if (!seen.has(id)) cursorDisplay.delete(id);
		}
		if (cursorDisplay.size > 0 && !cursorAnimId) {
			cursorAnimId = requestAnimationFrame(stepCursors);
		}
	}

	function stepCursors(): void {
		cursorAnimId = 0;
		let moving = false;
		for (const cursor of cursorDisplay.values()) {
			const dx = cursor.tx - cursor.x;
			const dy = cursor.ty - cursor.y;
			if (Math.abs(dx) < 0.35 && Math.abs(dy) < 0.35) {
				cursor.x = cursor.tx;
				cursor.y = cursor.ty;
				continue;
			}
			cursor.x += dx * 0.28;
			cursor.y += dy * 0.28;
			moving = true;
		}
		requestOverlayRender();
		if (moving) {
			cursorAnimId = requestAnimationFrame(stepCursors);
		}
	}

	function makeToolEvent(e: PointerEvent): ToolPointerEvent {
		const rect = interactionCanvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const vp = get(viewport);
		const board = screenToBoard(sx, sy, vp);
		// Browsers report pointer pressure 0.5 for mouse by spec — coerce to 1
		// so mouse strokes render at full width instead of 70%.
		const isMouse = e.pointerType === 'mouse';
		const pressure = isMouse ? 1 : (e.pressure || 0.5);
		return { boardX: board.x, boardY: board.y, screenX: sx, screenY: sy, pressure, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey, button: e.button };
	}
	function handlePointerDown(e: PointerEvent) {
		if (textEditing) return;
		containerEl?.focus();
		if (e.button === 1) {
			e.preventDefault();
			const panHandler = getToolHandler('pan');
			currentInteraction = panHandler.onPointerDown(makeToolEvent(e));
			interactionCanvas.setPointerCapture(e.pointerId);
			return;
		}
		if (e.button !== 0) return;
		const toolType = isSpacePanning ? 'pan' : get(activeTool);
		if (readOnly && drawingTools.has(toolType)) return;
		const handler = getToolHandler(toolType);
		currentInteraction = handler.onPointerDown(makeToolEvent(e));
		if (currentInteraction) interactionCanvas.setPointerCapture(e.pointerId);
		requestRender();
	}
	function handlePointerMove(e: PointerEvent) {
		lastPointerX = e.clientX;
		lastPointerY = e.clientY;
		if (currentInteraction) { currentInteraction.onPointerMove(makeToolEvent(e)); requestRender(); }
		if (boardId) { const te = makeToolEvent(e); broadcastCursor(boardId, { x: te.boardX, y: te.boardY, username, color: userColor }); }
	}
	function handlePointerUp(e: PointerEvent) {
		if (currentInteraction) {
			currentInteraction.onPointerUp(makeToolEvent(e));
			currentInteraction = null;
			if (interactionCanvas.hasPointerCapture(e.pointerId)) interactionCanvas.releasePointerCapture(e.pointerId);
			requestRender();
		}
	}
	function handlePointerCancel(e: PointerEvent) {
		if (!currentInteraction) return;
		currentInteraction = null;
		if (interactionCanvas.hasPointerCapture(e.pointerId)) interactionCanvas.releasePointerCapture(e.pointerId);
		requestRender();
	}
	function dataTransferHasImages(dataTransfer: DataTransfer | null): boolean {
		if (!dataTransfer) return false;
		if (dataTransfer.files?.length) return Array.from(dataTransfer.files).some((file) => file.type.startsWith('image/'));
		return Array.from(dataTransfer.items || []).some((item) => item.type.startsWith('image/'));
	}
	function queueFiles(files: File[], source: 'clipboard' | 'drop'): void {
		if (!channelId || readOnly) return;
		const imageFiles = files.filter((file) => file.type.startsWith('image/'));
		if (imageFiles.length === 0) return;
		for (const file of imageFiles) queueWhiteboardImport(channelId, file, source);
	}
	function syncImportPreviews(queue: PendingWhiteboardImport[]): void {
		const nextIds = new Set(queue.map((item) => item.id));
		for (const item of queue) { if (!importPreviewUrls.has(item.id)) importPreviewUrls.set(item.id, URL.createObjectURL(item.file)); }
		for (const [importId, previewUrl] of importPreviewUrls.entries()) { if (nextIds.has(importId)) continue; URL.revokeObjectURL(previewUrl); importPreviewUrls.delete(importId); }
	}
	function clearImportError(): void { importError = ''; if (importErrorTimer) { clearTimeout(importErrorTimer); importErrorTimer = null; } }
	function setImportError(message: string): void {
		importError = message;
		if (importErrorTimer) clearTimeout(importErrorTimer);
		importErrorTimer = setTimeout(() => { importError = ''; importErrorTimer = null; }, 6000);
	}
	function describeImportSource(source: 'clipboard' | 'drop' | 'capture'): string {
		switch (source) { case 'clipboard': return 'Clipboard'; case 'drop': return 'Drop'; case 'capture': return 'Capture'; default: return 'Import'; }
	}
	function resolveImportLayer(item: PendingWhiteboardImport): { layerId: string } {
		const state = get(boardStore);
		if (item.layerId) return { layerId: resolveWhiteboardLayerId(state.layers, item.layerId) };
		if (item.layerMode === 'reference') { const layer = boardStore.ensureLayer({ id: 'layer-reference', name: 'Reference', kind: 'reference', visible: true, locked: true, opacity: 0.82 }); return { layerId: layer.id }; }
		if (item.layerMode === 'background') { const layer = boardStore.ensureLayer({ id: 'layer-background', name: 'Background', kind: 'background', visible: true, locked: true, opacity: 1 }); return { layerId: layer.id }; }
		return { layerId: resolveWritableWhiteboardLayerId(state.layers, state.activeLayerId) };
	}
	async function maybeProcessPendingImports(): Promise<void> {
		if (!syncReady || readOnly || importBusy || !channelId || !boardId || pendingImportsForChannel.length === 0) return;
		const nextImport = pendingImportsForChannel[0];
		importBusy = true;
		clearImportError();
		try {
			const uploaded = await uploadWhiteboardImage(boardId, nextImport.file);
			const state = get(boardStore);
			const targetLayer = resolveImportLayer(nextImport);
			const imageEl = createWhiteboardImageElement(uploaded, state.viewport, canvasWidth || containerEl?.clientWidth || 960, canvasHeight || containerEl?.clientHeight || 640, state.elements.filter((element) => element.layerId === targetLayer.layerId).reduce((max, element) => Math.max(max, element.zIndex), 0), targetLayer.layerId);
			boardStore.addElement(imageEl);
			preloadImage(uploaded.fileUrl);
		} catch (error) { const message = error instanceof Error ? error.message : 'Failed to import image'; setImportError(`Failed to import ${nextImport.file.name}: ${message}`); }
		finally { dequeueWhiteboardImport(channelId, nextImport.id); importBusy = false; void maybeProcessPendingImports(); }
	}
	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const vp = get(viewport);
		if (e.ctrlKey || e.metaKey) {
			const rect = interactionCanvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const board = screenToBoard(sx, sy, vp);
			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			boardStore.zoomTo(vp.zoom * factor, board.x, board.y);
		} else { boardStore.panBy(e.deltaX / vp.zoom, e.deltaY / vp.zoom); }
	}
	function handleKeyDown(e: KeyboardEvent) {
		if (textEditing) { if (e.key === 'Escape') commitTextEdit(); return; }
		const tag = (e.target as HTMLElement)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		const ctrl = e.ctrlKey || e.metaKey;
		if (!ctrl && !e.altKey) {
			const toolMap: Record<string, ToolType> = { v: 'select', s: 'select', p: 'pen', d: 'pen', e: 'eraser', l: 'line', r: 'rect', o: 'ellipse', a: 'arrow', t: 'text' };
			const key = e.key.toLowerCase();
			if (toolMap[key]) {
				if (readOnly && toolMap[key] !== 'select') return;
				e.preventDefault();
				boardStore.setTool(toolMap[key]);
				return;
			}
		}
		if (e.key === ' ' && !e.repeat) { e.preventDefault(); isSpacePanning = true; return; }
		if (e.key === 'Delete' || e.key === 'Backspace') { if (readOnly) return; const sel = get(selection); if (sel.size > 0) { e.preventDefault(); boardStore.deleteElements([...sel]); } return; }
		if (ctrl && e.key.toLowerCase() === 'z') {
			if (readOnly) return;
			e.preventDefault();
			// Raster layers have their own pixel-level undo stack; route to it when
			// the active layer is a Paint layer and it has entries to pop.
			const bs = get(boardStore);
			const activeLayer = bs.layers.find((layer) => layer.id === bs.activeLayerId);
			if (activeLayer?.mode === 'raster' && rasterCanUndo()) {
				rasterUndo();
				requestRender();
				return;
			}
			if (e.shiftKey) boardStore.redo(); else boardStore.undo();
			return;
		}
		if (ctrl && e.key.toLowerCase() === 'y') { if (readOnly) return; e.preventDefault(); boardStore.redo(); return; }
		if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); boardStore.selectAll(); return; }
		if (ctrl && e.key.toLowerCase() === 'd') { if (readOnly) return; const sel = get(selection); if (sel.size > 0) { e.preventDefault(); boardStore.duplicateElements([...sel]); } return; }
		if (e.key === 'Escape') { boardStore.clearSelection(); boardStore.setTool('select'); return; }
	}
	function handleKeyUp(e: KeyboardEvent) { if (e.key === ' ') isSpacePanning = false; }

	const unsubTextPlacement = onTextPlacement((placement) => {
		const vp = get(viewport);
		const screen = { x: (placement.x - vp.x) * vp.zoom, y: (placement.y - vp.y) * vp.zoom };
		textEditing = true; textEditX = screen.x; textEditY = screen.y; textEditValue = ''; textEditPlacement = placement;
		requestAnimationFrame(() => { if (textOverlay) textOverlay.focus(); });
	});
	function commitTextEdit() {
		if (!textEditPlacement) { textEditing = false; return; }
		const text = textEditValue.trim();
		if (text) {
			const style = textEditPlacement.style;
			const el: TextElement = { id: textEditPlacement.elementId, type: 'text', x: textEditPlacement.x, y: textEditPlacement.y, width: 200, height: 30, rotation: 0, zIndex: textEditPlacement.maxZ, layerId: textEditPlacement.layerId, opacity: 1, strokeColor: style.strokeColor, strokeWidth: style.strokeWidth, fillColor: style.fillColor, createdBy: '', updatedAt: Date.now(), locked: false, text, fontSize: style.fontSize || 16, fontFamily: 'sans-serif', textAlign: 'left' };
			boardStore.addElement(el);
		}
		textEditing = false; textEditPlacement = null;
	}
	async function handlePaste(e: ClipboardEvent) {
		if (textEditing || readOnly) return;
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) { if (item.type.startsWith('image/')) { e.preventDefault(); const file = item.getAsFile(); if (!file) continue; queueFiles([file], 'clipboard'); break; } }
	}
	function handleDragEnter(event: DragEvent) { if (readOnly || !dataTransferHasImages(event.dataTransfer)) return; event.preventDefault(); isDragHover = true; }
	function handleDragOver(event: DragEvent) { if (readOnly || !dataTransferHasImages(event.dataTransfer)) return; event.preventDefault(); isDragHover = true; }
	function handleDragLeave(event: DragEvent) { if ((event.currentTarget as HTMLElement | null)?.contains(event.relatedTarget as Node | null)) return; isDragHover = false; }
	function handleDrop(event: DragEvent) { if (readOnly || !dataTransferHasImages(event.dataTransfer)) return; event.preventDefault(); isDragHover = false; queueFiles(Array.from(event.dataTransfer?.files || []), 'drop'); }

	$: cursorStyle = (() => {
		if (isSpacePanning) return 'grab';
		if ($activeTool === 'select' && $selection.size > 0) {
			// Check if pointer is over a resize/rotate handle
			const selEls = $elements.filter((e) => $selection.has(e.id));
			const bbox = getSelectionBBox(selEls);
			if (bbox) {
				const handles = getSelectionHandles(bbox, $viewport, 12);
				const hit = hitTestHandle(handles, lastPointerX, lastPointerY, 22);
				if (hit) {
					if (hit.position === 'rotate') return 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\'%3E%3Ccircle cx=\'8\' cy=\'8\' r=\'6\' fill=\'none\' stroke=\'%236366f1\' stroke-width=\'1.5\'/%3E%3Cpath d=\'M8 2 L8 4 M8 12 L8 14 M2 8 L4 8 M12 8 L14 8\' stroke=\'%236366f1\' stroke-width=\'1.5\' fill=\'none\'/%3E%3C/svg%3E") 8 8, auto';
					if (hit.position.includes('e') || hit.position.includes('w')) return 'ew-resize';
					if (hit.position.includes('n') || hit.position.includes('s')) return 'ns-resize';
					return 'nwse-resize';
				}
			}
		}
		const tool = $activeTool;
		const handler = getToolHandler(tool);
		return handler.cursor;
	})();

	onMount(() => { resizeObserver = new ResizeObserver(updateSize); resizeObserver.observe(containerEl); updateSize(); });
	onDestroy(() => {
		resizeObserver?.disconnect();
		cancelAnimationFrame(animFrameId);
		if (cursorAnimId) cancelAnimationFrame(cursorAnimId);
		unsubEls(); unsubVp(); unsubSel(); unsubPendingImports(); unsubTextPlacement();
		clearImportError();
		for (const previewUrl of importPreviewUrls.values()) URL.revokeObjectURL(previewUrl);
		importPreviewUrls.clear();
	});

	function handleTextKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') commitTextEdit();
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitTextEdit(); }
	}
</script>

<svelte:window on:keydown={handleKeyDown} on:keyup={handleKeyUp} />

<div class="whiteboard-canvas-container" bind:this={containerEl} role="region" aria-label="Whiteboard canvas" on:paste={handlePaste} on:dragenter={handleDragEnter} on:dragover={handleDragOver} on:dragleave={handleDragLeave} on:drop={handleDrop} tabindex="-1">
	<canvas bind:this={baseCanvas} class="whiteboard-layer base-layer"></canvas>
	<canvas bind:this={interactionCanvas} class="whiteboard-layer interaction-layer" style="cursor: {cursorStyle}" on:pointerdown={handlePointerDown} on:pointermove={handlePointerMove} on:pointerup={handlePointerUp} on:pointercancel={handlePointerCancel} on:wheel|preventDefault={handleWheel} on:contextmenu|preventDefault></canvas>

	{#if textEditing}
		<textarea bind:this={textOverlay} class="text-edit-overlay" style="left: {textEditX}px; top: {textEditY}px;" bind:value={textEditValue} on:blur={commitTextEdit} on:keydown={handleTextKeydown}></textarea>
	{/if}

	{#if importPreviewCards.length > 0 || importError || isDragHover}
		<div class="whiteboard-import-hud">
			{#if isDragHover}<div class="whiteboard-import-overlay" role="status" aria-live="polite"><div>Drop images to add them to the board</div></div>{/if}
			{#if importError}<div class="whiteboard-import-overlay is-error" role="alert"><div>{importError}</div></div>{/if}
			{#if importPreviewCards.length > 0}
				<div class="whiteboard-import-queue" role="status" aria-live="polite">
					{#each importPreviewCards as importCard}
						<div class="whiteboard-import-card" class:is-active={importCard.status === 'uploading'}>
							{#if importCard.previewUrl}<img class="whiteboard-import-thumb" src={importCard.previewUrl} alt="" />{:else}<div class="whiteboard-import-thumb whiteboard-import-thumb--empty"></div>{/if}
							<div class="whiteboard-import-copy">
								<div class="whiteboard-import-name">{importCard.fileName}</div>
								<div class="whiteboard-import-meta">{describeImportSource(importCard.source)}<span aria-hidden="true">•</span>{importCard.status === 'uploading' ? 'Uploading' : 'Queued'}</div>
							</div>
						</div>
					{/each}
					{#if pendingImportsForChannel.length > importPreviewCards.length}<div class="whiteboard-import-more">+{pendingImportsForChannel.length - importPreviewCards.length} more queued</div>{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
