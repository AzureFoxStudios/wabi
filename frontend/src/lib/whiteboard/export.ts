import type { BoardDocument } from './boardStore';
import type { BoardElement } from './elementTypes';
import { getSelectionBBox } from './coords';
import { preloadImage, renderElements } from './boardRenderer';

function sanitizeExportBaseName(boardId: string): string {
	const normalized = (boardId || 'whiteboard')
		.replace(/[^a-z0-9]+/gi, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
	return normalized || 'whiteboard';
}

function downloadBlob(blob: Blob, fileName: string): void {
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = objectUrl;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function waitForImage(img: HTMLImageElement): Promise<void> {
	if (img.complete) return Promise.resolve();
	return new Promise((resolve) => {
		const cleanup = () => {
			img.removeEventListener('load', onLoad);
			img.removeEventListener('error', onError);
		};
		const onLoad = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			resolve();
		};
		img.addEventListener('load', onLoad, { once: true });
		img.addEventListener('error', onError, { once: true });
		setTimeout(() => {
			cleanup();
			resolve();
		}, 5000);
	});
}

async function ensureImagesReady(elements: BoardElement[]): Promise<void> {
	const imageElements = elements.filter((element): element is Extract<BoardElement, { type: 'image' }> => element.type === 'image');
	await Promise.allSettled(imageElements.map((element) => waitForImage(preloadImage(element.src))));
}

function resolveExportBounds(boardDocument: BoardDocument): { x: number; y: number; width: number; height: number } {
	const bbox = getSelectionBBox(boardDocument.elements);
	if (bbox && bbox.width > 0 && bbox.height > 0) {
		return bbox;
	}

	const visibleWidth = Math.max(640, Math.round(1280 / Math.max(boardDocument.viewport.zoom, 0.1)));
	const visibleHeight = Math.max(360, Math.round(720 / Math.max(boardDocument.viewport.zoom, 0.1)));
	return {
		x: boardDocument.viewport.x,
		y: boardDocument.viewport.y,
		width: visibleWidth,
		height: visibleHeight
	};
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error('Failed to serialize whiteboard export.'));
		}, type);
	});
}

export async function exportBoardAsPng(boardDocument: BoardDocument): Promise<void> {
	await ensureImagesReady(boardDocument.elements);

	const bounds = resolveExportBounds(boardDocument);
	const padding = 32;
	const width = Math.max(1, Math.ceil(Math.abs(bounds.width) + padding * 2));
	const height = Math.max(1, Math.ceil(Math.abs(bounds.height) + padding * 2));

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error('Whiteboard export canvas is unavailable.');
	}

	ctx.fillStyle = '#f8fafc';
	ctx.fillRect(0, 0, width, height);
	renderElements(ctx, boardDocument.elements, {
		x: bounds.x - padding,
		y: bounds.y - padding,
		zoom: 1
	}, boardDocument.layers || []);

	const blob = await canvasToBlob(canvas, 'image/png');
	downloadBlob(blob, `${sanitizeExportBaseName(boardDocument.boardId)}.png`);
}

export function exportBoardAsJson(boardDocument: BoardDocument): void {
	const blob = new Blob([JSON.stringify(boardDocument, null, 2)], {
		type: 'application/json'
	});
	downloadBlob(blob, `${sanitizeExportBaseName(boardDocument.boardId)}.json`);
}
