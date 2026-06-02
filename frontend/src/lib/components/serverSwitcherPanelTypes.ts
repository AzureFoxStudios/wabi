export type MobileMoveState =
	| {
			kind: 'server';
			serverUrl: string;
			label: string;
			sourceFolderId: string | null;
	  }
	| {
			kind: 'folder';
			itemId: string;
			label: string;
	  }
	| null;

export type MobileDragState = {
	x: number;
	y: number;
};

export type MobileDropPreview =
	| {
			kind: 'group-position';
			itemId: string;
			position: 'before' | 'after';
	  }
	| {
			kind: 'join-folder';
			itemId: string;
	  }
	| {
			kind: 'row-position';
			serverUrl: string;
			itemId: string;
			position: 'before' | 'after';
	  }
	| {
			kind: 'make-folder';
			serverUrl: string;
	  }
	| null;
