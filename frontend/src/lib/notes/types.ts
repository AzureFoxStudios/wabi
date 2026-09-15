/** Device-local records. Never use a display name or connection ID as the owner. */
export interface NotebookNote {
	schemaVersion: 1;
	scopeId: string;
	id: string;
	title: string;
	normalizedTitle: string;
	text: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
	trashedAt: number | null;
	pinned: boolean;
	color?: string;
	contextChannelId?: string;
	importedFrom?: { id: string; revision: number; scopeId: string };
}

export interface NotebookLink {
	scopeId: string;
	sourceId: string;
	normalizedTitle: string;
	/** null means never resolved; a missing UUID means deleted, not reusable. */
	targetId: string | null;
}

export interface NotebookOwner {
	scopeId: string;
	/** A captured session capability; false after logout/server/account change. */
	isCurrent: () => boolean;
}

export type NotePatch = Partial<Pick<NotebookNote, 'title' | 'text' | 'pinned' | 'color'>>;

export interface RecoveredNoteDraft {
	id: string;
	scopeId: string;
	kind: 'draft';
	noteId: string;
	baseRevision: number;
	title: string;
	text: string;
	updatedAt: number;
}

export class NotebookError extends Error {
	constructor(public readonly code: 'conflict' | 'title-taken' | 'unavailable' | 'retired' | 'invalid' | 'missing', message: string) {
		super(message);
		this.name = 'NotebookError';
	}
}
