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
	/**
	 * The addon id of each addon view's tab. The app passes every view (checked with
	 * `satisfies` in workspaceNavigationState.ts); a view without an id cannot be selected.
	 */
	addonIds: Partial<Record<WorkspaceAddonView, string>>;
	/**
	 * Other addon tabs that belong to a view (addon id → view). A joined presentation
	 * (`workspace-audience`) is part of Present, so the navigation marks Present active.
	 */
	addonAliases?: Record<string, WorkspaceAddonView>;
	/**
	 * Prepare a fresh entry into an addon view just before its tab opens. Office tools register
	 * their tab lazily here and clear their one-shot handoff target. It must never navigate or
	 * activate anything (the navigation owns the center), and it is skipped when the view is
	 * already active, so an open editor keeps its document.
	 */
	prepareAddonTab?: (view: WorkspaceAddonView) => void;
	queue: Pick<typeof mobileTabQueue, 'activeTabId' | 'openAddonTab' | 'setActiveChannel' | 'toAddonTabId'>;
	channel: Readable<string>;
	voice: Writable<boolean>;
	surface: Readable<'messages' | 'whiteboard'>;
	setSurface: (channelId: string, surface: 'messages' | 'whiteboard') => void;
}) {
	// Tab token → view. Primary ids first so an alias can never shadow a view's own tab.
	const tabViews = new Map<string, WorkspaceAddonView>();
	for (const [view, id] of Object.entries(deps.addonIds) as [WorkspaceAddonView, string | undefined][]) {
		if (id) tabViews.set(deps.queue.toAddonTabId(id), view);
	}
	for (const [id, view] of Object.entries(deps.addonAliases ?? {})) {
		const tab = deps.queue.toAddonTabId(id);
		if (!tabViews.has(tab)) tabViews.set(tab, view);
	}
	const viewForTab = (tab: string | null): WorkspaceAddonView | undefined => (tab ? tabViews.get(tab) : undefined);

	const activeView = derived(
		[deps.queue.activeTabId, deps.voice, deps.surface],
		([tab, voice, surface]): WorkspaceViewKey => {
			// Match the shell's ownership: an explicit addon wins over remembered
			// channel surfaces. A board must never hide Files or Project.
			return viewForTab(tab) ?? (voice ? 'voice' : surface);
		}
	);

	function select(view: WorkspaceViewKey): void {
		const channel = get(deps.channel);
		if (view === 'whiteboard' && !channel) return;
		if (view === 'messages' || view === 'whiteboard' || view === 'voice') {
			deps.voice.set(view === 'voice');
			// Select the actual current channel, not the queue's last fallback.
			// Keep other open tabs/documents; switching views is not closing them.
			activateWorkspaceChannel(deps.queue, channel);
			deps.setSurface(channel, view === 'whiteboard' ? 'whiteboard' : 'messages');
			return;
		}
		const addonId = deps.addonIds[view];
		if (!addonId) return;
		deps.voice.set(false);
		// Already there: selecting the current view keeps its tab, so choosing Present
		// while in a joined presentation does not drop the room for the deck library.
		if (viewForTab(get(deps.queue.activeTabId)) === view) return;
		deps.prepareAddonTab?.(view);
		deps.queue.openAddonTab(addonId);
	}

	return { activeView, select };
}
