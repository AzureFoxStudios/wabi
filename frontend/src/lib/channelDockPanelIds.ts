/**
 * channelDockPanelIds.ts
 * The pure half of docked channels: panel ids, manifests and which panels should exist.
 * It imports no stores, so it can be unit-tested and used without the socket graph.
 * The store wiring lives in channelDockPanels.ts.
 */
import { isValidWorkspacePanelId, type WorkspacePanelId } from './docking/layoutSchema';
import type { Channel } from './socket-types';
import type { WorkspacePanelManifest } from './workspacePanels';

const CHANNEL_PANEL_PREFIX = 'channel:';

export function channelPanelId(channelId: string): WorkspacePanelId | null {
	const id = `${CHANNEL_PANEL_PREFIX}${channelId}`;
	return channelId && isValidWorkspacePanelId(id) ? id : null;
}

export function channelIdOfPanel(panelId: string | null | undefined): string | null {
	if (!panelId || !panelId.startsWith(CHANNEL_PANEL_PREFIX)) return null;
	return panelId.slice(CHANNEL_PANEL_PREFIX.length) || null;
}

export function channelPanelManifest(channel: Pick<Channel, 'id' | 'name'>): WorkspacePanelManifest | null {
	const id = channelPanelId(channel.id);
	if (!id) return null;
	return {
		id,
		label: `#${channel.name || channel.id}`,
		icon: 'chat',
		// The stream and its composer are the whole panel; there is no toolbar row to describe.
		ownsToolbar: true,
		component: 'channel-chat',
		defaultDock: 'right',
		mobileMode: 'sheet',
		source: 'core',
		sortOrder: 900
	};
}

/** Which channel panels should exist, given the rail and the channels this account can see. */
export function reconcileChannelPanels(
	strip: readonly string[],
	list: ReadonlyArray<Pick<Channel, 'id' | 'name'>>
): WorkspacePanelManifest[] {
	const byId = new Map(list.map((channel) => [channel.id, channel] as const));
	const wanted: WorkspacePanelManifest[] = [];
	for (const panelId of strip) {
		const channelId = channelIdOfPanel(panelId);
		const channel = channelId ? byId.get(channelId) : undefined;
		const manifest = channel ? channelPanelManifest(channel) : null;
		if (manifest) wanted.push(manifest);
	}
	return wanted;
}
