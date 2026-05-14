import { derived, writable } from 'svelte/store';
import { currentChannel } from '$lib/socket';

export type ChatSurface = 'messages' | 'whiteboard';
export type WhiteboardImportLayerMode = 'content' | 'reference' | 'background';

export interface PendingWhiteboardImport {
	id: string;
	channelId: string;
	file: File;
	source: 'clipboard' | 'drop' | 'capture';
	createdAt: number;
	layerMode?: WhiteboardImportLayerMode;
	layerId?: string;
}

function createId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const surfaceByChannel = writable<Record<string, ChatSurface>>({});
const pendingImports = writable<Record<string, PendingWhiteboardImport[]>>({});

export const whiteboardSurfaces = surfaceByChannel;
export const whiteboardPendingImports = pendingImports;

export const currentChatSurface = derived(
	[surfaceByChannel, currentChannel],
	([$surfaceByChannel, $currentChannel]) => {
		return $surfaceByChannel[$currentChannel] || 'messages';
	}
);

export function setWhiteboardSurface(channelId: string, surface: ChatSurface): void {
	if (!channelId) return;
	surfaceByChannel.update((state) => {
		if (state[channelId] === surface) return state;
		return { ...state, [channelId]: surface };
	});
}

export function openWhiteboardSurface(channelId: string): void {
	setWhiteboardSurface(channelId, 'whiteboard');
}

export function queueWhiteboardImport(
	channelId: string,
	file: File,
	source: PendingWhiteboardImport['source'],
	options: { layerMode?: WhiteboardImportLayerMode; layerId?: string } = {}
): string {
	const id = createId();
	const item: PendingWhiteboardImport = {
		id,
		channelId,
		file,
		source,
		createdAt: Date.now(),
		layerMode: options.layerMode,
		layerId: options.layerId
	};
	pendingImports.update((state) => {
		const next = state[channelId] ? [...state[channelId], item] : [item];
		return { ...state, [channelId]: next };
	});
	return id;
}

export function dequeueWhiteboardImport(channelId: string, importId: string): void {
	pendingImports.update((state) => {
		const items = state[channelId] || [];
		const next = items.filter((item) => item.id !== importId);
		if (next.length === items.length) return state;
		if (next.length === 0) {
			const { [channelId]: _removed, ...rest } = state;
			return rest;
		}
		return { ...state, [channelId]: next };
	});
}
