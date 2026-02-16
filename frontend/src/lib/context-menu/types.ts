export type ContextMenuItem = {
	id: string;
	label?: string;
	type?: 'action' | 'separator';
	leading?: string;
	hint?: string;
	danger?: boolean;
	disabled?: boolean;
	hidden?: boolean;
	keepOpen?: boolean;
	onSelect?: () => void | Promise<void>;
};
