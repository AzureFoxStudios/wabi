import { createWorkspaceNavigation, type WorkspaceAddonView } from './workspaceNavigation';
import { currentChannel } from './channelStore';
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
import { NOTIFICATIONS_ADDON_ID } from './notificationsWorkspace';
import { OFFICE_TOOL_VIEW, ensureWorkspaceTab, workspaceTabId, type OfficeView } from './workspaces/bridge';

const isOfficeView = (view: string): view is OfficeView => view === 'documents' || view === 'sheets' || view === 'present';

const navigation = createWorkspaceNavigation({
	addonIds: {
		notifications: NOTIFICATIONS_ADDON_ID,
		reader: READER_ADDON_ID, model: MODEL_VIEWPORT_ADDON_ID, map: MAP_ADDON_ID,
		media: MEDIA_ALBUMS_ADDON_ID, planner: PLANNER_ADDON_ID, notes: NOTES_ADDON_ID,
		lore: LORE_ADDON_ID, files: FILES_ADDON_ID,
		// Office tools (integration candidate): their editors are the bridge's addon tabs.
		documents: workspaceTabId('documents'), sheets: workspaceTabId('sheets'), present: workspaceTabId('present')
	} satisfies Record<WorkspaceAddonView, string>,
	// A joined presentation owns center stage as part of Present.
	addonAliases: { [workspaceTabId('audience')]: OFFICE_TOOL_VIEW.audience },
	// Office tabs register on first use; the folio already navigated, so only register.
	ensureAddonTab: (view) => { if (isOfficeView(view)) ensureWorkspaceTab(view); },
	queue: mobileTabQueue,
	channel: currentChannel,
	voice: voiceViewOpen,
	surface: currentChatSurface,
	setSurface: setWhiteboardSurface
});

export const activeWorkspaceView = navigation.activeView;
export const selectWorkspaceView = navigation.select;
