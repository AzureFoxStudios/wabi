/**
 * One confirm service (design contract §7.13): `await confirmAction({...})` instead of
 * window.confirm / window.alert.
 *
 *   if (await confirmAction({
 *     title: 'Delete this message?',
 *     body: 'It will be removed for everyone in #general.',
 *     confirm: 'Delete message',
 *     danger: true
 *   })) deleteMessage(id);
 *
 * - The title asks the question, `body` is one sentence of consequence, `confirm` is the verb
 *   plus its object. `danger` draws the outlined destructive button; otherwise the action is
 *   the ink primary. `cancel: null` leaves a single acknowledgement button (an alert()).
 * - ConfirmDialog.svelte is loaded and mounted on first use, so no layout has to host it.
 * - Resolves true on the action, false on Cancel, Esc or the scrim. Only one confirm is open at a
 *   time: a new request supersedes the open one, which resolves false (so a double-clicked
 *   "Delete" can never run twice).
 * - If the dialog cannot be shown at all (no DOM, or its chunk failed to load) it resolves false:
 *   the destructive branch is never taken without an answer.
 */

export interface ConfirmOptions {
	/** The action as a question: "Delete this message?" */
	title: string;
	/** One sentence of consequence: "It will be removed for everyone in #general." */
	body?: string;
	/** Verb + object for the action button: "Delete message". Defaults to "Continue". */
	confirm?: string;
	/** Label of the safe button; `null` hides it (acknowledge-only). Defaults to "Cancel". */
	cancel?: string | null;
	/** Destructive action: outlined danger button, first focus on Cancel. */
	danger?: boolean;
}

/** Props handed to the dialog component (ConfirmDialog.svelte's own prop names). */
export interface ConfirmDialogProps {
	isOpen: boolean;
	title: string;
	message: string;
	confirmText: string;
	cancelText: string | null;
	variant: 'info' | 'warning' | 'danger';
	overlayZIndex: string;
	onConfirm: () => void;
	onCancel: () => void;
}

export interface MountedConfirm {
	destroy(): void;
}

/** Shows the dialog; returns a handle that removes it. May be async (lazy component load). */
export type ConfirmMount = (props: ConfirmDialogProps) => MountedConfirm | Promise<MountedConfirm>;

/** Above settings (--z-settings-nested) and the lightbox: a confirm is always the top layer. */
const CONFIRM_Z = 'calc(var(--z-lightbox, 12000) + 10)';

type Pending = {
	settled: boolean;
	resolve: (value: boolean) => void;
	handle: MountedConfirm | null;
};

let current: Pending | null = null;

const defaultMount: ConfirmMount = async (props) => {
	if (typeof document === 'undefined') throw new Error('confirmAction needs a document');
	const [{ mount, unmount }, { default: ConfirmDialog }] = await Promise.all([
		import('svelte'),
		import('./components/ConfirmDialog.svelte')
	]);
	// BaseModal portals the dialog to <body> (or the fullscreen element); the host only anchors
	// the component instance and never enters the document.
	const host = document.createElement('div');
	const instance = mount(ConfirmDialog, { target: host, props });
	return {
		destroy() {
			void unmount(instance);
		}
	};
};

let mountDialog: ConfirmMount = defaultMount;

/** Test seam: swap how the dialog is shown. Pass null to restore the real dialog. */
export function setConfirmMount(next: ConfirmMount | null): void {
	mountDialog = next ?? defaultMount;
}

/** True while a confirm is waiting for an answer. */
export function isConfirmOpen(): boolean {
	return current !== null;
}

function settle(entry: Pending, value: boolean) {
	if (entry.settled) return;
	entry.settled = true;
	if (current === entry) current = null;
	const handle = entry.handle;
	entry.handle = null;
	try {
		handle?.destroy();
	} finally {
		entry.resolve(value);
	}
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	if (current) settle(current, false);

	return new Promise<boolean>((resolve) => {
		const entry: Pending = { settled: false, resolve, handle: null };
		current = entry;

		const props: ConfirmDialogProps = {
			isOpen: true,
			title: options.title,
			message: options.body ?? '',
			confirmText: options.confirm ?? 'Continue',
			cancelText: options.cancel === undefined ? 'Cancel' : options.cancel,
			variant: options.danger ? 'danger' : 'info',
			overlayZIndex: CONFIRM_Z,
			onConfirm: () => settle(entry, true),
			onCancel: () => settle(entry, false)
		};

		let mounted: MountedConfirm | Promise<MountedConfirm>;
		try {
			mounted = mountDialog(props);
		} catch (error) {
			console.error('[confirm] could not show the dialog', error);
			settle(entry, false);
			return;
		}
		Promise.resolve(mounted).then(
			(handle) => {
				// Answered or superseded before the dialog finished loading: take it straight down.
				if (entry.settled) handle.destroy();
				else entry.handle = handle;
			},
			(error) => {
				console.error('[confirm] could not show the dialog', error);
				settle(entry, false);
			}
		);
	});
}
