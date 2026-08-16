import { get } from 'svelte/store';
import { boardStore, viewport, activeTool, selection, elements, layers } from '$lib/whiteboard/boardStore';
import type { ToolType } from '$lib/whiteboard/boardStore';
import {
	renderElements,
	renderLayersWithBlend,
	renderGrid,
	renderSelectionBox,
	renderHandles,
	renderDrawPreview,
	renderSelectionRect,
	renderRemoteCursors,
	preloadImage
} from '$lib/whiteboard/boardRenderer';
import { screenToBoard, getSelectionBBox, getSelectionHandles } from '$lib/whiteboard/coords';
import type { BoardElement, TextElement } from '$lib/whiteboard/elementTypes';
import { getToolHandler, type ToolPointerEvent, type ToolInteraction } from '$lib/whiteboard/tools';
import { broadcastCursor } from '$lib/whiteboard/boardSync';
import {
	dequeueWhiteboardImport,
	queueWhiteboardImport,
	type PendingWhiteboardImport
} from '$lib/whiteboard/whiteboardSurface';
import { createWhiteboardImageElement, uploadWhiteboardImage } from '$lib/whiteboard/imageImports';
import {
	resolveWhiteboardLayerId,
	resolveWritableWhiteboardLayerId
} from '$lib/whiteboard/layers';

export function createRenderLoop(
	baseCanvas: HTMLCanvasElement,
	interactionCanvas: HTMLCanvasElement,
	canvasWidth: number,
	canvasHeight: number,
	dpr: number,
	showGrid: boolean,
	currentInteraction: ToolInteraction | null,
	remoteCursors: Array<{ userId: string; username: string; color: string; x: number; y: number }>
) {
	return function render() {
		const vp = get(viewport);
		const els = get(elements);
		const sel = get(selection);

		const baseCtx = baseCanvas.getContext('2d')!;
		baseCtx.save();
		baseCtx.scale(dpr, dpr);
		baseCtx.clearRect(0, 0, canvasWidth, canvasHeight);
		if (showGrid) {
			renderGrid(baseCtx, vp, canvasWidth, canvasHeight, 24);
		}
		// Composite layers bottom-to-top with per-layer blendMode + opacity.
		// Falls back to plain renderElements when there are no layers (or a
		// single default layer with no blend) — renderLayersWithBlend handles
		// both cases, but keep renderElements for any layer-less boards.
		const currentLayers = get(layers);
		if (currentLayers.length > 0) {
			renderLayersWithBlend(baseCtx, els, vp, currentLayers, canvasWidth, canvasHeight, dpr);
		} else {
			renderElements(baseCtx, els, vp, currentLayers);
		}
		baseCtx.restore();

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
				const handles = getSelectionHandles(bbox, vp, 8);
				renderHandles(intCtx, handles);
			}
		}

		if (remoteCursors.length > 0) {
			renderRemoteCursors(intCtx, remoteCursors, vp);
		}

		intCtx.restore();
	};
}

export function createToolEventFactory(
	interactionCanvas: HTMLCanvasElement
): (e: PointerEvent) => ToolPointerEvent {
	return function makeToolEvent(e: PointerEvent): ToolPointerEvent {
		const rect = interactionCanvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const vp = get(viewport);
		const board = screenToBoard(sx, sy, vp);
		// Mouse always reports pressure 0.5, so treat it as full width (pressure 1).
		// Pen/touch report real pressure; fall back to full width when none is given.
		const hasPressure = e.pointerType !== 'mouse' && e.pressure > 0 && Number.isFinite(e.pressure);
		return {
			boardX: board.x,
			boardY: board.y,
			screenX: sx,
			screenY: sy,
			pressure: hasPressure ? Math.max(0, Math.min(1, e.pressure)) : 1,
			shiftKey: e.shiftKey,
			ctrlKey: e.ctrlKey || e.metaKey,
			altKey: e.altKey,
			button: e.button
		};
	};
}

export function createPointerHandlers(
	makeToolEvent: (e: PointerEvent) => ToolPointerEvent,
	interactionCanvas: HTMLCanvasElement,
	textEditing: boolean,
	isSpacePanning: boolean,
	boardId: string,
	username: string,
	userColor: string,
	requestRender: () => void
) {
	return {
		handlePointerDown(e: PointerEvent): ToolInteraction | null {
			if (textEditing) return null;
			if (e.button === 1) {
				e.preventDefault();
				const panHandler = getToolHandler('pan');
				const interaction = panHandler.onPointerDown(makeToolEvent(e));
				interactionCanvas.setPointerCapture(e.pointerId);
				return interaction;
			}
			if (e.button !== 0) return null;
			const toolType = isSpacePanning ? 'pan' : get(activeTool);
			const handler = getToolHandler(toolType);
			const interaction = handler.onPointerDown(makeToolEvent(e));
			if (interaction) {
				interactionCanvas.setPointerCapture(e.pointerId);
			}
			requestRender();
			return interaction;
		},
		handlePointerMove(e: PointerEvent, currentInteraction: ToolInteraction | null) {
			if (currentInteraction) {
				currentInteraction.onPointerMove(makeToolEvent(e));
				requestRender();
			}
			if (boardId) {
				const te = makeToolEvent(e);
				broadcastCursor(boardId, { x: te.boardX, y: te.boardY, username, color: userColor });
			}
		},
		handlePointerUp(e: PointerEvent, currentInteraction: ToolInteraction | null): void {
			if (currentInteraction) {
				currentInteraction.onPointerUp(makeToolEvent(e));
				if (interactionCanvas.hasPointerCapture(e.pointerId)) {
					interactionCanvas.releasePointerCapture(e.pointerId);
				}
				requestRender();
			}
		},
		handlePointerCancel(e: PointerEvent, currentInteraction: ToolInteraction | null): void {
			if (!currentInteraction) return;
			if (interactionCanvas.hasPointerCapture(e.pointerId)) {
				interactionCanvas.releasePointerCapture(e.pointerId);
			}
			requestRender();
		}
	};
}

export function createKeyboardHandlers(
	textEditing: boolean,
	commitTextEdit: () => void
) {
	const toolMap: Record<string, ToolType> = {
		v: 'select', s: 'select',
		p: 'pen', d: 'pen',
		l: 'line',
		r: 'rect',
		e: 'ellipse', o: 'ellipse',
		a: 'arrow',
		t: 'text'
	};

	return {
		handleKeyDown(e: KeyboardEvent): { isSpacePanning: boolean } {
			let isSpacePanning = false;
			if (textEditing) {
				if (e.key === 'Escape') commitTextEdit();
				return { isSpacePanning };
			}
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return { isSpacePanning };
			const ctrl = e.ctrlKey || e.metaKey;
			if (!ctrl && !e.altKey) {
				if (toolMap[e.key.toLowerCase()]) {
					e.preventDefault();
					boardStore.setTool(toolMap[e.key.toLowerCase()]);
					return { isSpacePanning };
				}
			}
			if (e.key === ' ' && !e.repeat) {
				e.preventDefault();
				isSpacePanning = true;
				return { isSpacePanning };
			}
			if (e.key === 'Delete' || e.key === 'Backspace') {
				const sel = get(selection);
				if (sel.size > 0) {
					e.preventDefault();
					boardStore.deleteElements([...sel]);
				}
				return { isSpacePanning };
			}
			if (ctrl && e.key.toLowerCase() === 'z') {
				e.preventDefault();
				if (e.shiftKey) boardStore.redo();
				else boardStore.undo();
				return { isSpacePanning };
			}
			if (ctrl && e.key.toLowerCase() === 'y') {
				e.preventDefault();
				boardStore.redo();
				return { isSpacePanning };
			}
			if (ctrl && e.key.toLowerCase() === 'a') {
				e.preventDefault();
				boardStore.selectAll();
				return { isSpacePanning };
			}
			if (ctrl && e.key.toLowerCase() === 'd') {
				const sel = get(selection);
				if (sel.size > 0) {
					e.preventDefault();
					boardStore.duplicateElements([...sel]);
				}
				return { isSpacePanning };
			}
			if (e.key === 'Escape') {
				boardStore.clearSelection();
				boardStore.setTool('select');
			}
			return { isSpacePanning };
		},
		handleKeyUp(e: KeyboardEvent): { isSpacePanning: boolean } {
			return { isSpacePanning: e.key === ' ' ? false : false };
		}
	};
}

export function createImportHandlers(
	channelId: string,
	boardId: string,
	syncReady: boolean,
	importBusy: boolean,
	canvasWidth: number,
	canvasHeight: number,
	containerEl: HTMLDivElement | undefined
) {
	let importError = '';
	let importErrorTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingImportsForChannel: PendingWhiteboardImport[] = [];
	let importPreviewUrls = new Map<string, string>();

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
			case 'clipboard': return 'Clipboard';
			case 'drop': return 'Drop';
			case 'capture': return 'Capture';
			default: return 'Import';
		}
	}

	function resolveImportLayer(item: PendingWhiteboardImport): { layerId: string } {
		const state = get(boardStore);
		if (item.layerId) {
			return { layerId: resolveWhiteboardLayerId(state.layers, item.layerId) };
		}
		if (item.layerMode === 'reference') {
			const layer = boardStore.ensureLayer({
				id: 'layer-reference', name: 'Reference', kind: 'reference',
				visible: true, locked: true, opacity: 0.82
			});
			return { layerId: layer.id };
		}
		if (item.layerMode === 'background') {
			const layer = boardStore.ensureLayer({
				id: 'layer-background', name: 'Background', kind: 'background',
				visible: true, locked: true, opacity: 1
			});
			return { layerId: layer.id };
		}
		return { layerId: resolveWritableWhiteboardLayerId(state.layers, state.activeLayerId) };
	}

	async function maybeProcessPendingImports(setImportBusy: (v: boolean) => void, setImportErrorState: (v: string) => void): Promise<void> {
		if (!syncReady || importBusy || !channelId || !boardId || pendingImportsForChannel.length === 0) return;
		const nextImport = pendingImportsForChannel[0];
		setImportBusy(true);
		clearImportError();
		try {
			const uploaded = await uploadWhiteboardImage(boardId, nextImport.file);
			const state = get(boardStore);
			const imageLayer = boardStore.addRasterLayer(nextImport.file.name.replace(/\.[^.]+$/, '') || 'Image');
			const targetLayer = { layerId: imageLayer.id };
			const imageEl = createWhiteboardImageElement(
				uploaded, state.viewport,
				canvasWidth || containerEl?.clientWidth || 960,
				canvasHeight || containerEl?.clientHeight || 640,
				state.elements.filter((element) => element.layerId === targetLayer.layerId).reduce((max, element) => Math.max(max, element.zIndex), 0),
				targetLayer.layerId
			);
			boardStore.addElement(imageEl);
			preloadImage(uploaded.fileUrl);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to import image';
			setImportError(`Failed to import ${nextImport.file.name}: ${message}`);
		} finally {
			dequeueWhiteboardImport(channelId, nextImport.id);
			setImportBusy(false);
			void maybeProcessPendingImports(setImportBusy, setImportErrorState);
		}
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

	function buildImportPreviewCards(queue: PendingWhiteboardImport[], busy: boolean): Array<{
		id: string; fileName: string; previewUrl: string;
		source: PendingWhiteboardImport['source']; status: 'uploading' | 'queued';
	}> {
		return queue.slice(0, 3).map((item, index) => ({
			id: item.id,
			fileName: item.file.name,
			previewUrl: importPreviewUrls.get(item.id) || '',
			source: item.source,
			status: busy && index === 0 ? 'uploading' : 'queued'
		}));
	}

	function cleanup(): void {
		clearImportError();
		for (const previewUrl of importPreviewUrls.values()) {
			URL.revokeObjectURL(previewUrl);
		}
		importPreviewUrls.clear();
	}

	return {
		get importError() { return importError; },
		get pendingImportsForChannel() { return pendingImportsForChannel; },
		set pendingImportsForChannel(v: PendingWhiteboardImport[]) { pendingImportsForChannel = v; },
		clearImportError,
		setImportError,
		describeImportSource,
		maybeProcessPendingImports,
		dataTransferHasImages,
		queueFiles,
		syncImportPreviews,
		buildImportPreviewCards,
		cleanup
	};
}

export function createWheelHandler(
	interactionCanvas: HTMLCanvasElement
) {
	return function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const vp = get(viewport);
		if (e.ctrlKey || e.metaKey) {
			const rect = interactionCanvas.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const board = screenToBoard(sx, sy, vp);
			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			boardStore.zoomTo(vp.zoom * factor, board.x, board.y);
		} else {
			boardStore.panBy(e.deltaX / vp.zoom, e.deltaY / vp.zoom);
		}
	};
}

export function createTextEditHandlers(
	textOverlay: HTMLTextAreaElement | null
) {
	return {
		handleTextPlacement(placement: { x: number; y: number; elementId: string; style: { strokeColor: string; strokeWidth: number; fillColor: string }; maxZ: number; layerId: string }, setEditing: (v: boolean) => void, setPos: (x: number, y: number) => void, setPlacement: (p: any) => void) {
			const vp = get(viewport);
			const screen = {
				x: (placement.x - vp.x) * vp.zoom,
				y: (placement.y - vp.y) * vp.zoom
			};
			setEditing(true);
			setPos(screen.x, screen.y);
			setPlacement(placement);
			requestAnimationFrame(() => {
				if (textOverlay) textOverlay.focus();
			});
		},
		commitTextEdit(value: string, placement: any, addElement: (el: TextElement) => void, setEditing: (v: boolean) => void, setPlacement: (p: any) => void) {
			if (!placement) {
				setEditing(false);
				return;
			}
			const text = value.trim();
			if (text) {
				const style = placement.style;
				const el: TextElement = {
					id: placement.elementId, type: 'text',
					x: placement.x, y: placement.y, width: 200, height: 30,
					rotation: 0, zIndex: placement.maxZ, layerId: placement.layerId,
					opacity: 1, strokeColor: style.strokeColor, strokeWidth: style.strokeWidth,
					fillColor: style.fillColor, createdBy: '', updatedAt: Date.now(),
					locked: false, text, fontSize: 16, fontFamily: 'sans-serif', textAlign: 'left'
				};
				addElement(el);
			}
			setEditing(false);
			setPlacement(null);
		}
	};
}

export function createCursorStyleGetter(): (isSpacePanning: boolean) => string {
	return function getCursorStyle(isSpacePanning: boolean): string {
		if (isSpacePanning) return 'grab';
		const tool = get(activeTool);
		const handler = getToolHandler(tool);
		return handler.cursor;
	};
}
