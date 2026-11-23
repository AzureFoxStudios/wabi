/**
 * channelDockPanels.ts
 * A channel docked beside center stage is an ordinary right-dock panel whose id names the
 * channel (`channel:<id>`). The dock, the rail and the saved layout only ever see panel ids, so
 * this module keeps the panel registry in step with the channels that are docked: a manifest
 * exists exactly while its stub is on the rail and its channel is one this account can see.
 * A stub whose channel is not in the list (another server, access removed) stays saved and
 * simply has no panel until the channel is back.
 */
import { get } from 'svelte/store';
import { channels } from './channelStore';
import { channelPanelManifest, reconcileChannelPanels } from './channelDockPanelIds';
import { openRightPanel } from './layoutStoreRightPanel';
import { stubStrip } from './layoutStoreStates';
import type { Channel } from './socket-types';
import { getWorkspacePanelManifest, registerWorkspacePanel, unregisterWorkspacePanel } from './workspacePanels';

export { channelIdOfPanel, channelPanelId, channelPanelManifest, reconcileChannelPanels } from './channelDockPanelIds';

/** Dock a channel beside center stage. The stage keeps whatever it is showing. */
export function openChannelInDock(channel: Pick<Channel, 'id' | 'name'>): boolean {
	const manifest = channelPanelManifest(channel);
	if (!manifest || !registerWorkspacePanel(manifest)) return false;
	openRightPanel(manifest.id);
	return true;
}

/** Keep channel panels registered for the session (restores docked channels after a reload). */
export function startChannelDockSync(): () => void {
	const registered = new Set<string>();
	const sync = () => {
		const wanted = reconcileChannelPanels(get(stubStrip), get(channels));
		const wantedIds = new Set(wanted.map((manifest) => manifest.id));
		for (const id of [...registered]) {
			if (wantedIds.has(id)) continue;
			unregisterWorkspacePanel(id);
			registered.delete(id);
		}
		for (const manifest of wanted) {
			// Re-register only on a change (a rename), so panel lists do not churn on every channel update.
			if (getWorkspacePanelManifest(manifest.id)?.label !== manifest.label) registerWorkspacePanel(manifest);
			registered.add(manifest.id);
		}
	};
	const stops = [channels.subscribe(sync), stubStrip.subscribe(sync)];
	return () => {
		for (const stop of stops) stop();
	};
}
