import { derived, get, type Readable, type Writable } from 'svelte/store';
import type { WorkspaceViewKey } from './components/chat/types';
import type { mobileTabQueue } from './mobileTabQueue';

export type WorkspaceAddonView = Exclude<WorkspaceViewKey, 'messages' | 'whiteboard' | 'voice'>;

function activateWorkspaceChannel(
	queue: Pick<typeof mobileTabQueue, 'setActiveChannel' | 'activeTabId'>,
	channel: string
): void {
	if (channel) queue.setActiveChannel(channel);
	else queue.activeTabId.set(null);
}

/** One resolver/transition boundary, backed by existing stores, not another view store. */
export function createWorkspaceNavigation(deps: {
	addonIds: Record<WorkspaceAddonView, string>;
	queue: Pick<typeof mobileTabQueue, 'activeTabId' | 'openAddonTab' | 'setActiveChannel' | 'toAddonTabId'>;
	channel: Readable<string>;
	voice: Writable<boolean>;
	surface: Readable<'messages' | 'whiteboard'>;
	setSurface: (channelId: string, surface: 'messages' | 'whiteboard') => void;
}) {
	const addonViews = Object.entries(deps.addonIds) as [WorkspaceAddonView, string][];
	const activeView = derived(
		[deps.queue.activeTabId, deps.voice, deps.surface],
		([tab, voice, surface]): WorkspaceViewKey => {
			// Match the shell's ownership: an explicit addon wins over remembered
			// channel surfaces. A board must never hide Files or Project.
			const addon = addonViews.find(([, id]) => tab === deps.queue.toAddonTabId(id));
			return addon?.[0] ?? (voice ? 'voice' : surface);
		}
	);

	function select(view: WorkspaceViewKey): void {
		const channel = get(deps.channel);
		if (view === 'whiteboard' && !channel) return;
		deps.voice.set(view === 'voice');
		if (view === 'messages' || view === 'whiteboard' || view === 'voice') {
			// Select the actual current channel, not the queue's last fallback.
			// Keep other open tabs/documents; switching views is not closing them.
			activateWorkspaceChannel(deps.queue, channel);
			deps.setSurface(channel, view === 'whiteboard' ? 'whiteboard' : 'messages');
		} else {
			deps.queue.openAddonTab(deps.addonIds[view]);
		}
	}

	return { activeView, select };
}
