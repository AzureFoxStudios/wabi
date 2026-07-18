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
	kind: 'special' | 'user' | 'place' | 'channel' | 'forum_post' | 'wiki_page' | 'gallery_work';
	detail?: string;
	place?: PlaceRecord;
	poi?: PlaceRecord['pois'][number];
};

export type WorkspaceViewKey = 'messages' | 'whiteboard' | 'reader' | 'model' | 'map' | 'media';

export type ChannelPaneAnimation = {
	enabled: boolean;
	preset: AnimationPassPreset;
	duration: number;
	distance: number;
};
