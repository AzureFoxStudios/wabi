import { derived } from 'svelte/store';
import { createWorkspaceNavigation } from './workspaceNavigation';
import { channels, currentChannel } from './channelStore';
import { mobileTabQueue } from './mobileTabQueue';
import { voiceViewOpen } from './voiceView';
import { currentChatSurface, setWhiteboardSurface } from './whiteboard/whiteboardSurface';
import { READER_ADDON_ID } from './readerWorkspace';
import { MODEL_VIEWPORT_ADDON_ID } from './modelViewportTab';
import { MAP_ADDON_ID } from './mapWorkspace';
import { MEDIA_ALBUMS_ADDON_ID } from './mediaAlbumsWorkspace';
import { PLANNER_ADDON_ID } from './plannerWorkspace';
import { NOTES_ADDON_ID } from './notesWorkspace';
import { LORE_ADDON_ID } from './loreWorkspace';
import { FILES_ADDON_ID } from './filesWorkspace';

const navigation = createWorkspaceNavigation({
	addonIds: {
		reader: READER_ADDON_ID, model: MODEL_VIEWPORT_ADDON_ID, map: MAP_ADDON_ID,
		media: MEDIA_ALBUMS_ADDON_ID, planner: PLANNER_ADDON_ID, notes: NOTES_ADDON_ID,
		lore: LORE_ADDON_ID, files: FILES_ADDON_ID
	},
	queue: mobileTabQueue,
	channel: currentChannel,
	voice: voiceViewOpen,
	surface: currentChatSurface,
	setSurface: setWhiteboardSurface
});

// Channel type owns the canonical center-pane surface. A project channel is a
// project workspace, not a text channel that happens to offer a Project view.
// This deliberately rebounds temporary/remembered workspace choices back to
// Project while the selected channel is `lore`. Other channel types keep their
// existing routing (text -> messages, gallery/forum -> their own channel views,
// etc.) rather than inheriting project navigation state.
export const activeWorkspaceView = derived(
	[navigation.activeView, currentChannel, channels],
	([$activeView, $currentChannel, $channels]) => {
		const channel = $channels.find((candidate) => candidate.id === $currentChannel);
		return channel?.type === 'lore' ? 'lore' : $activeView;
	}
);

export const selectWorkspaceView = navigation.select;
