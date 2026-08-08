export type WhiteboardScopeType = 'channel';

export type WhiteboardLayerKind = 'content' | 'reference' | 'background';

export interface WhiteboardPolicy {
	access: 'open' | 'desktop_only';
	writeAccess: 'anyone' | 'desktop';
}

export const DEFAULT_WHITEBOARD_POLICY: WhiteboardPolicy = {
	access: 'open',
	writeAccess: 'anyone'
};

export interface WhiteboardMeta {
	updatedAt: number;
	updatedBy: number;
}

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
	blendMode: string;
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
	policy?: WhiteboardPolicy;
	meta?: WhiteboardMeta;
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
