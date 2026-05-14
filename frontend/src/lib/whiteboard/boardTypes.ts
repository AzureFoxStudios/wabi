export type WhiteboardScopeType = 'channel';

export type WhiteboardLayerKind = 'content' | 'reference' | 'background';

export interface WhiteboardViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface WhiteboardLayer {
	id: string;
	name: string;
	kind: WhiteboardLayerKind;
	visible: boolean;
	locked: boolean;
	opacity: number;
	order: number;
	createdAt: number;
	updatedAt: number;
}

export interface WhiteboardElement extends Record<string, unknown> {
	id?: string;
	type?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	layerId?: string;
}

export interface WhiteboardDocument {
	boardId: string;
	version: number;
	updatedAt: number;
	elements: WhiteboardElement[];
	layers?: WhiteboardLayer[];
	activeLayerId?: string;
	viewport?: WhiteboardViewport;
	[key: string]: unknown;
}

export interface WhiteboardSnapshotPayload {
	boardId: string;
	channelId: string;
	version: number;
	persistedAt: number;
	updatedBy?: string;
	document: WhiteboardDocument;
}

export interface WhiteboardPresenceUser {
	userId: string;
	username: string;
	color: string | null;
}

export interface WhiteboardPresencePayload {
	boardId: string;
	users: WhiteboardPresenceUser[];
}

export interface WhiteboardPatchPayload {
	boardId: string;
	channelId: string;
	userId: string;
	timestamp: number;
	patch: unknown;
}

export interface WhiteboardCursorPayload {
	boardId: string;
	channelId: string;
	userId: string;
	timestamp: number;
	cursor: unknown;
}

export interface WhiteboardErrorPayload {
	message: string;
	code?: string;
	boardId?: string;
	channelId?: string;
}

export function getChannelBoardId(channelId: string): string {
	return `channel:${channelId}`;
}
