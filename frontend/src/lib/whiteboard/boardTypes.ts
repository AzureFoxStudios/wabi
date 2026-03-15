export type WhiteboardScopeType = 'channel';

export interface WhiteboardViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface WhiteboardElement extends Record<string, unknown> {
	id?: string;
	type?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export interface WhiteboardDocument {
	boardId: string;
	version: number;
	updatedAt: number;
	elements: WhiteboardElement[];
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
