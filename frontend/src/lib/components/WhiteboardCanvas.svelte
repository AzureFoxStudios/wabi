<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { boardStore, elements, layers, viewport, activeTool, selection, canUndo, canRedo, policy } from '$lib/whiteboard/boardStore';
	import { hitTestHandle } from '$lib/whiteboard/coords';
	import type { ToolType } from '$lib/whiteboard/boardStore';
	import { renderElements, renderLayersWithBlend, renderGrid, renderSelectionBox, renderHandles, renderDrawPreview, renderSelectionRect, renderRemoteCursors, preloadImage } from '$lib/whiteboard/boardRenderer';
	import { screenToBoard, getSelectionBBox, getSelectionHandles } from '$lib/whiteboard/coords';
	import type { BoardElement, CodeElement } from '$lib/whiteboard/elementTypes';
	import { generateElementId } from '$lib/whiteboard/elementTypes';
	import { getToolHandler, onTextPlacement, type ToolPointerEvent, type ToolInteraction, type TextPlacement } from '$lib/whiteboard/tools';
	import { broadcastCursor } from '$lib/whiteboard/boardSync';
	import { getRasterStrokeDirtyBounds } from '$lib/whiteboard/rasterLayers';
	import { dequeueWhiteboardImport, queueWhiteboardImport, whiteboardPendingImports, type PendingWhiteboardImport } from '$lib/whiteboard/whiteboardSurface';
	import { createWhiteboardImageElement, uploadWhiteboardImage } from '$lib/whiteboard/imageImports';
	import { resolveWhiteboardLayerId, resolveWritableWhiteboardLayerId, MAX_WHITEBOARD_LAYERS } from '$lib/whiteboard/layers';
	import { planPaste, stripDangerousClipboardText, suggestPasteLayerName } from '$lib/whiteboard/codePaste';
	import { buildCodeElement, buildTextElement } from '$lib/whiteboard/textMetrics';
	import { loadFontsForBoard, onFontsLoaded, setActiveFontScope } from '$lib/whiteboard/fontAssets';
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
	// Non-null while re-editing an existing element (double-click): commit
	// updates that element instead of creating a new one.
	let textEditExistingId: string | null = null;
	let textEditIsCode = false;
	let textEditFontSize = 16;
	let textEditFontFamily = 'sans-serif';
	let pasteCount = 0;
	let resizeObserver: ResizeObserver;
	let renderScheduled = false;
	let baseDirty = false;
	let overlayDirty = false;
	// While a RASTER stroke is active its dabs land in the layer bitmap, so the
	// base canvas must keep updating — but only inside the stroke's dirty rect
	// (clipped). Vector-tool previews never touch the base until pointer-up.
	let rasterStrokeActive = false;
	// Hi-dpi cap: backing-store pixels scale quadratically with devicePixelRatio,
	// which made drawing lag on high-res monitors (4x fill at dpr 2 vs a 1x
	// laptop). 1.5 keeps lines crisp while quartering worst-case fill cost.
	const MAX_CANVAS_DPR = 1.5;
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
		dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);
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
		// Active raster stroke: clip the whole recomposite (clear + layers) to
		// the stroke's dirty rect so untouched board regions keep last frame's
		// pixels. This is the Krita-style tile/dirty-rect compositing win.
		let strokeClip: { x: number; y: number; w: number; h: number } | null = null;
		if (rasterStrokeActive && currentInteraction) {
			const bs = get(boardStore);
			const bounds = getRasterStrokeDirtyBounds(bs.activeLayerId);
			if (bounds) {
				const STROKE_PAD = 64;
				const sx0 = (bounds.minX - STROKE_PAD - vp.x) * vp.zoom;
				const sy0 = (bounds.minY - STROKE_PAD - vp.y) * vp.zoom;
				const sx1 = (bounds.maxX + STROKE_PAD - vp.x) * vp.zoom;
				const sy1 = (bounds.maxY + STROKE_PAD - vp.y) * vp.zoom;
				strokeClip = {
					x: Math.max(0, Math.floor(sx0)),
					y: Math.max(0, Math.floor(sy0)),
					w: Math.min(canvasWidth, Math.ceil(sx1)) - Math.max(0, Math.floor(sx0)),
					h: Math.min(canvasHeight, Math.ceil(sy1)) - Math.max(0, Math.floor(sy0))
				};
				if (strokeClip.w <= 0 || strokeClip.h <= 0) strokeClip = null;
			}
		}
		if (strokeClip) {
			baseCtx.beginPath();
			baseCtx.rect(strokeClip.x, strokeClip.y, strokeClip.w, strokeClip.h);
			baseCtx.clip();
		}
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
		// Pen/eraser only mutate the base canvas mid-stroke on RASTER layers
		// (same condition createPenTool/createEraserTool use to pick their
		// raster variants). Vector-mode strokes preview on the overlay and
		// commit once on pointer-up.
		const bs = get(boardStore);
		const activeLayer = bs.layers.find((layer) => layer.id === bs.activeLayerId);
		rasterStrokeActive =
			activeLayer?.mode === 'raster' && (toolType === 'pen' || toolType === 'eraser');
		if (currentInteraction) interactionCanvas.setPointerCapture(e.pointerId);
		requestRender();
	}
	function handlePointerMove(e: PointerEvent) {
		lastPointerX = e.clientX;
		lastPointerY = e.clientY;
		if (currentInteraction) {
			// Coalesced events: browsers sample pointers faster than frames
			// (~125-1000Hz vs 60fps). Feed every raw sample to the tool so
			// strokes stay smooth, then repaint ONCE this frame.
			const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
			if (events.length > 0) {
				for (const ce of events) currentInteraction.onPointerMove(makeToolEvent(ce));
			} else {
				currentInteraction.onPointerMove(makeToolEvent(e));
			}
			if (rasterStrokeActive) {
				requestRender();
			} else {
				// Vector previews draw on the interaction canvas only — the
				// base board hasn't changed until pointer-up. Skip the
				// expensive full-board recomposite per mouse tick.
				requestOverlayRender();
			}
		}
		if (boardId) { const te = makeToolEvent(e); broadcastCursor(boardId, { x: te.boardX, y: te.boardY, username, color: userColor }); }
	}
	function handlePointerUp(e: PointerEvent) {
		if (currentInteraction) {
			currentInteraction.onPointerUp(makeToolEvent(e));
			currentInteraction = null;
			rasterStrokeActive = false;
			if (interactionCanvas.hasPointerCapture(e.pointerId)) interactionCanvas.releasePointerCapture(e.pointerId);
			requestRender();
		}
	}
	function handlePointerCancel(e: PointerEvent) {
		if (!currentInteraction) return;
		currentInteraction = null;
		rasterStrokeActive = false;
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
		// Default: every pasted/dropped image gets its OWN layer at the bottom,
		// locked, so each import is independently toggleable and drawable-over.
		const name = item.file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Image';
		return { layerId: createPasteLayer(`Image — ${name}`) };
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
		textEditing = true; textEditX = screen.x; textEditY = screen.y; textEditValue = '';
		textEditPlacement = placement; textEditExistingId = null; textEditIsCode = false;
		textEditFontSize = placement.style.fontSize || 16;
		textEditFontFamily = placement.style.fontFamily || 'sans-serif';
		requestAnimationFrame(() => { if (textOverlay) textOverlay.focus(); });
	});

	// Double-click on a text/code element reopens the editor prefilled.
	function handleDoubleClick(e: MouseEvent) {
		if (textEditing || readOnly) return;
		const rect = interactionCanvas.getBoundingClientRect();
		const vp = get(viewport);
		const board = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
		const state = get(boardStore);
		const tolerance = 6 / vp.zoom;
		// Top-most first; layer lock does not block an explicit edit intent,
		// element lock does.
		const sorted = [...state.elements].sort((a, b) => b.zIndex - a.zIndex);
		for (const el of sorted) {
			if (el.type !== 'text' && el.type !== 'code') continue;
			const layer = state.layers.find((candidate) => candidate.id === el.layerId);
			if (layer && layer.visible === false) continue;
			if (el.locked) continue;
			if (board.x < el.x - tolerance || board.x > el.x + el.width + tolerance) continue;
			if (board.y < el.y - tolerance || board.y > el.y + el.height + tolerance) continue;
			const screenPos = { x: (el.x - vp.x) * vp.zoom, y: (el.y - vp.y) * vp.zoom };
			textEditing = true; textEditX = screenPos.x; textEditY = screenPos.y;
			textEditExistingId = el.id;
			textEditIsCode = el.type === 'code';
			textEditPlacement = null;
			if (el.type === 'text') {
				textEditValue = el.text;
				textEditFontSize = el.fontSize || 16;
				textEditFontFamily = el.fontFamily || 'sans-serif';
			} else {
				textEditValue = el.code;
				textEditFontSize = el.fontSize || 13;
				textEditFontFamily = 'monospace';
			}
			boardStore.select([el.id]);
			requestAnimationFrame(() => { if (textOverlay) textOverlay.focus(); });
			return;
		}
	}

	function commitTextEdit() {
		const value = textEditValue;
		if (textEditExistingId) {
			const id = textEditExistingId;
			if (value.trim()) {
				if (textEditIsCode) {
					const measures = buildCodeElement({ id, x: 0, y: 0, zIndex: 0, layerId: '', code: value, language: '', fontSize: textEditFontSize });
					const existing = get(boardStore).elements.find((el) => el.id === id) as CodeElement | undefined;
					boardStore.updateElement(id, {
						code: value,
						fontSize: textEditFontSize,
						width: measures.width,
						height: measures.height,
						language: existing?.language || ''
					});
				} else {
					const measures = buildTextElement({ id, x: 0, y: 0, zIndex: 0, layerId: '', text: value, fontSize: textEditFontSize, fontFamily: textEditFontFamily, strokeColor: '#111111', strokeWidth: 1, fillColor: 'transparent' });
					boardStore.updateElement(id, { text: value, width: measures.width, height: measures.height });
				}
			} else {
				boardStore.deleteElements([id]);
			}
			textEditing = false; textEditExistingId = null; textEditPlacement = null;
			return;
		}
		if (!textEditPlacement) { textEditing = false; return; }
		const text = textEditValue.trim();
		if (text) {
			const style = textEditPlacement.style;
			const el = buildTextElement({
				id: textEditPlacement.elementId,
				x: textEditPlacement.x,
				y: textEditPlacement.y,
				zIndex: textEditPlacement.maxZ,
				layerId: textEditPlacement.layerId,
				text,
				fontSize: style.fontSize || 16,
				fontFamily: style.fontFamily || 'sans-serif',
				fontId: style.fontId,
				strokeColor: style.strokeColor,
				strokeWidth: style.strokeWidth,
				fillColor: style.fillColor
			});
			boardStore.addElement(el);
		}
		textEditing = false; textEditPlacement = null;
	}

	/**
	 * Create a dedicated layer for a pasted item, inserted at the BOTTOM of the
	 * stack (kind reference, locked) so the paste sits under the active content
	 * layer — paste something, then draw on it. Falls back to the active layer
	 * at the layer cap.
	 */
	function createPasteLayer(name: string): string {
		const state = get(boardStore);
		if (state.layers.length >= MAX_WHITEBOARD_LAYERS) {
			return resolveWritableWhiteboardLayerId(state.layers, state.activeLayerId);
		}
		const minOrder = state.layers.reduce((min, layer) => Math.min(min, layer.order), 0);
		const created = boardStore.addLayer({ name, kind: 'reference', visible: true, locked: true, opacity: 1, order: minOrder - 1 });
		return created.id;
	}

	function pasteTextAsElement(rawText: string): void {
		const text = stripDangerousClipboardText(rawText);
		const { plan, error } = planPaste(text);
		if (error) { setImportError(error); return; }
		if (!plan) return;
		const state = get(boardStore);
		const vp = state.viewport;
		pasteCount += 1;
		// One undo step for the whole paste (layer + element).
		boardStore.pushHistoryCheckpoint();
		const layerId = createPasteLayer(suggestPasteLayerName(plan, pasteCount));
		const maxZ = state.elements
			.filter((element) => element.layerId === layerId)
			.reduce((max, element) => Math.max(max, element.zIndex), 0);
		const centerX = vp.x + (canvasWidth || containerEl?.clientWidth || 960) / vp.zoom / 2;
		const centerY = vp.y + (canvasHeight || containerEl?.clientHeight || 640) / vp.zoom / 2;
		if (plan.kind === 'code') {
			const el = buildCodeElement({
				id: generateElementId(),
				x: 0, y: 0, zIndex: maxZ + 1, layerId,
				code: text, language: plan.language, fontSize: 13
			});
			el.x = centerX - el.width / 2;
			el.y = centerY - el.height / 2;
			boardStore.addElement(el);
		} else {
			const style = state.style;
			const el = buildTextElement({
				id: generateElementId(),
				x: 0, y: 0, zIndex: maxZ + 1, layerId,
				text: text.trim(), fontSize: style.fontSize || 16, fontFamily: style.fontFamily || 'sans-serif', fontId: style.fontId,
				strokeColor: style.strokeColor, strokeWidth: style.strokeWidth, fillColor: style.fillColor
			});
			el.x = centerX - el.width / 2;
			el.y = centerY - el.height / 2;
			boardStore.addElement(el);
		}
	}

	async function handlePaste(e: ClipboardEvent) {
		if (textEditing || readOnly) return;
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const item of items) {
			if (item.type.startsWith('image/')) {
				e.preventDefault();
				const file = item.getAsFile();
				if (!file) continue;
				queueFiles([file], 'clipboard');
				return;
			}
		}
		const textItem = Array.from(items).find((item) => item.type === 'text/plain');
		if (textItem) {
			e.preventDefault();
			const text = e.clipboardData?.getData('text/plain') || '';
			if (text.trim()) pasteTextAsElement(text);
		}
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

	onMount(() => {
		resizeObserver = new ResizeObserver(updateSize); resizeObserver.observe(containerEl); updateSize();
		if (boardId) { setActiveFontScope(boardId); void loadFontsForBoard(boardId); }
	});
	const unsubFontsLoaded = onFontsLoaded(() => requestRender());
	$: if (boardId) { setActiveFontScope(boardId); void loadFontsForBoard(boardId); }
	onDestroy(() => {
		resizeObserver?.disconnect();
		cancelAnimationFrame(animFrameId);
		if (cursorAnimId) cancelAnimationFrame(cursorAnimId);
		unsubEls(); unsubVp(); unsubSel(); unsubPendingImports(); unsubTextPlacement(); unsubFontsLoaded();
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
	<canvas bind:this={interactionCanvas} class="whiteboard-layer interaction-layer" style="cursor: {cursorStyle}" on:pointerdown={handlePointerDown} on:pointermove={handlePointerMove} on:pointerup={handlePointerUp} on:pointercancel={handlePointerCancel} on:wheel|preventDefault={handleWheel} on:dblclick={handleDoubleClick} on:contextmenu|preventDefault></canvas>

	{#if textEditing}
		<textarea bind:this={textOverlay} class="text-edit-overlay" class:is-code={textEditIsCode} style="left: {textEditX}px; top: {textEditY}px; font-size: {Math.max(11, textEditFontSize * get(viewport).zoom)}px;" bind:value={textEditValue} on:blur={commitTextEdit} on:keydown={handleTextKeydown}></textarea>
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
