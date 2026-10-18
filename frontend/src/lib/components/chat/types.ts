import type { PlaceRecord } from '$lib/placeRegistry';
import type { AnimationPassPreset } from '$lib/animationPass';

export type FilePreview = {
	file: File;
	preview?: string;
};

export type MentionSuggestion = {
	key: string;
	label: string;
	value: string;
	kind: 'special' | 'user' | 'place' | 'channel' | 'forum_post' | 'wiki_page' | 'gallery_work' | 'game';
	gameKey?: string;
	detail?: string;
	place?: PlaceRecord;
	poi?: PlaceRecord['pois'][number];
};

/**
 * Every center-stage workspace the navigation can select. `documents`, `sheets` and `present`
 * are the office tools (an integration candidate, labelled PREVIEW); their editors are addon
 * tabs (`addon:workspace-<tool>`), and a joined presentation (`workspace-audience`) counts as
 * `present`. See workspaceNavigationState.ts.
 */
export type WorkspaceViewKey =
	| 'messages' | 'notifications' | 'whiteboard' | 'planner' | 'notes' | 'reader' | 'model' | 'map' | 'media' | 'lore' | 'files' | 'voice'
	| 'documents' | 'sheets' | 'present';

export type ChannelPaneAnimation = {
	enabled: boolean;
	preset: AnimationPassPreset;
	duration: number;
	distance: number;
};
