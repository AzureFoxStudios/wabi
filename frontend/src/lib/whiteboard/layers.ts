import type { WhiteboardLayer, WhiteboardLayerKind } from './boardTypes';

export const DEFAULT_WHITEBOARD_LAYER_ID = 'layer-default';
export const MAX_WHITEBOARD_LAYERS = 32;

export const WHITEBOARD_BLEND_MODES = [
	'source-over',
	'multiply',
	'screen',
	'overlay',
	'darken',
	'lighten',
	'soft-light',
	'hard-light',
	'difference',
	'exclusion'
] as const;

export const BLEND_MODE_LABELS: Record<string, string> = {
	'source-over': 'Normal',
	multiply: 'Multiply',
	screen: 'Screen',
	overlay: 'Overlay',
	darken: 'Darken',
	lighten: 'Lighten',
	'soft-light': 'Soft Light',
	'hard-light': 'Hard Light',
	difference: 'Difference',
	exclusion: 'Exclusion'
};

function humanizeBlendMode(mode: string): string {
	return mode
		.replace(/[-_]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.split(' ')
		.map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
		.join(' ');
}

export function blendModeLabel(mode: string): string {
	return BLEND_MODE_LABELS[mode] || humanizeBlendMode(mode);
}

export function clampLayerOpacity(opacity: number): number {
	return Math.max(0, Math.min(1, opacity));
}

export function createLayerId(base: string): string {
	const normalized = base
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const suffix = Math.random().toString(36).slice(2, 7);
	return `layer-${normalized || 'group'}-${suffix}`;
}

export function createDefaultWhiteboardLayer(now = Date.now()): WhiteboardLayer {
	return {
		id: DEFAULT_WHITEBOARD_LAYER_ID,
		name: 'Main',
		kind: 'content',
		visible: true,
		locked: false,
		opacity: 1,
		order: 0,
		createdAt: now,
		updatedAt: now,
		blendMode: 'source-over',
		mode: 'vector'
	} as WhiteboardLayer;
}

export function createRasterWhiteboardLayer(name = 'Paint', order = 0, now = Date.now()): WhiteboardLayer {
	return {
		id: createLayerId(name), name, kind: 'content', visible: true, locked: false,
		opacity: 1, order, createdAt: now, updatedAt: now,
		blendMode: 'source-over', mode: 'raster', revision: 0
	};
}

export function createReferenceWhiteboardLayer(name = 'Reference', now = Date.now()): WhiteboardLayer {
	return {
		id: createLayerId(name),
		name,
		kind: 'reference',
		visible: true,
		locked: true,
		opacity: 0.82,
		order: 0,
		createdAt: now,
		updatedAt: now,
		blendMode: 'source-over',
		mode: 'vector'
	};
}

export function createBackgroundWhiteboardLayer(name = 'Background', now = Date.now()): WhiteboardLayer {
	return {
		id: createLayerId(name),
		name,
		kind: 'background',
		visible: true,
		locked: true,
		opacity: 1,
		order: 0,
		createdAt: now,
		updatedAt: now,
		blendMode: 'source-over',
		mode: 'vector'
	};
}

export function cloneWhiteboardLayer(layer: WhiteboardLayer): WhiteboardLayer {
	return { ...layer };
}

export function cloneWhiteboardLayers(layers: WhiteboardLayer[]): WhiteboardLayer[] {
	return layers.map(cloneWhiteboardLayer);
}

export function sortWhiteboardLayers(layers: WhiteboardLayer[]): WhiteboardLayer[] {
	return [...layers].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.name.localeCompare(b.name));
}

export function normalizeWhiteboardLayer(
	candidate: Partial<WhiteboardLayer> | null | undefined,
	index: number,
	now = Date.now()
): WhiteboardLayer | null {
	if (!candidate || typeof candidate !== 'object') return null;
	const id = typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : createLayerId(`layer-${index + 1}`);
	const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : `Layer ${index + 1}`;
	const kind = candidate.kind === 'reference' || candidate.kind === 'background' ? candidate.kind : 'content';
	const visible = candidate.visible !== false;
	const locked = candidate.locked === true;
	const opacity = clampLayerOpacity(Number.isFinite(candidate.opacity as number) ? Number(candidate.opacity) : 1);
	const order = Number.isFinite(candidate.order as number) ? Number(candidate.order) : index;
	const createdAt = Number.isFinite(candidate.createdAt as number) ? Number(candidate.createdAt) : now;
	const updatedAt = Number.isFinite(candidate.updatedAt as number) ? Number(candidate.updatedAt) : now;
	const blendMode =
		candidate.blendMode === undefined ||
		typeof candidate.blendMode !== 'string' ||
		!WHITEBOARD_BLEND_MODES.includes(candidate.blendMode as (typeof WHITEBOARD_BLEND_MODES)[number])
			? 'source-over'
			: candidate.blendMode;
	const mode = candidate.mode === 'raster' ? 'raster' : 'vector';

	return {
		id,
		name,
		kind,
		visible,
		locked,
		opacity,
		order,
		createdAt,
		updatedAt,
		blendMode,
		mode,
		assetId: typeof candidate.assetId === 'string' ? candidate.assetId : undefined,
		assetUrl: typeof candidate.assetUrl === 'string' ? candidate.assetUrl : undefined,
		pixelWidth: Number.isFinite(candidate.pixelWidth as number) ? Number(candidate.pixelWidth) : undefined,
		pixelHeight: Number.isFinite(candidate.pixelHeight as number) ? Number(candidate.pixelHeight) : undefined,
		assetOffsetX: Number.isFinite(candidate.assetOffsetX as number) ? Number(candidate.assetOffsetX) : undefined,
		assetOffsetY: Number.isFinite(candidate.assetOffsetY as number) ? Number(candidate.assetOffsetY) : undefined,
		revision: Number.isFinite(candidate.revision as number) ? Number(candidate.revision) : 0
	};
}

export function normalizeWhiteboardLayers(
	candidates: unknown,
	fallback: WhiteboardLayer[] = [createDefaultWhiteboardLayer()]
): WhiteboardLayer[] {
	if (!Array.isArray(candidates) || candidates.length === 0) {
		return cloneWhiteboardLayers(fallback);
	}

	const layers = candidates
		.slice(0, MAX_WHITEBOARD_LAYERS)
		.map((candidate, index) => normalizeWhiteboardLayer(candidate as Partial<WhiteboardLayer>, index))
		.filter((layer): layer is WhiteboardLayer => Boolean(layer));

	if (layers.length === 0) {
		return cloneWhiteboardLayers(fallback);
	}

	return sortWhiteboardLayers(layers);
}

export function getLayerOpacity(layers: WhiteboardLayer[], layerId: string | undefined | null): number {
	const layer = layers.find((candidate) => candidate.id === layerId) || null;
	return layer ? clampLayerOpacity(layer.opacity) : 1;
}

export function resolveWhiteboardLayerId(
	layers: WhiteboardLayer[],
	layerId: string | undefined | null
): string {
	if (layerId && layers.some((layer) => layer.id === layerId)) {
		return layerId;
	}
	return layers[0]?.id || DEFAULT_WHITEBOARD_LAYER_ID;
}

export function resolveWritableWhiteboardLayerId(
	layers: WhiteboardLayer[],
	preferredLayerId: string | undefined | null
): string {
	const preferred = preferredLayerId ? layers.find((layer) => layer.id === preferredLayerId) || null : null;
	if (preferred && preferred.visible !== false && preferred.locked !== true) {
		return preferred.id;
	}
	const fallback = layers.find((layer) => layer.visible !== false && layer.locked !== true) || null;
	if (fallback) {
		return fallback.id;
	}
	return resolveWhiteboardLayerId(layers, preferredLayerId);
}
