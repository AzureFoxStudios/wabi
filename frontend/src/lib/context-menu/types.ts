export type ContextMenuIcon =
	| 'message-circle'
	| 'phone'
	| 'video'
	| 'monitor'
	| 'user'
	| 'pin'
	| 'settings'
	| 'trash-2'
	| 'smile'
	| 'download'
	| 'forward'
	| 'edit'
	| 'copy'
	| 'credit-card'
	| 'archive'
	| 'archive-restore'
	| 'banknote'
	| 'log-out'
	| 'languages';

export type ContextMenuItem = {
	id: string;
	label?: string;
	type?: 'action' | 'separator';
	leading?: string;
	icon?: ContextMenuIcon;
	hint?: string;
	danger?: boolean;
	disabled?: boolean;
	hidden?: boolean;
	keepOpen?: boolean;
	onSelect?: () => void | Promise<void>;
};
