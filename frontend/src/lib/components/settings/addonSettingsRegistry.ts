export type AddonSectionId =
	| 'dms'
	| 'chat'
	| 'search'
	| 'navigation'
	| 'identity'
	| 'notifications'
	| 'media'
	| 'appearance'
	| 'utilities'
	| 'spoilers';

export interface LocalAddonControlMeta {
	label: string;
	section: AddonSectionId;
	terms: string[];
}

export const ADDON_SECTION_IDS: AddonSectionId[] = [
	'dms',
	'chat',
	'search',
	'navigation',
	'identity',
	'notifications',
	'media',
	'appearance',
	'utilities',
	'spoilers'
];

export const ADDON_SECTION_LABELS: Record<AddonSectionId, string> = {
	dms: 'DMs',
	chat: 'Chat',
	search: 'Search',
	navigation: 'Navigation',
	identity: 'Identity',
	notifications: 'Notifications',
	media: 'Media',
	appearance: 'Appearance',
	utilities: 'Utilities',
	spoilers: 'Spoilers'
};

export const LOCAL_ADDON_CONTROL_META: Record<string, LocalAddonControlMeta> = {
	translator_addon: {
		label: 'Translator Assist',
		section: 'utilities',
		terms: ['translate', 'translation', 'language', 'libretranslate']
	},
	line_dm: {
		label: 'LINE DM',
		section: 'dms',
		terms: ['line', 'direct message', 'wallpaper', 'background', 'preset']
	},
	chat_aliases: {
		label: 'ChatAliases',
		section: 'utilities',
		terms: ['alias', 'slash', 'command', 'replacement']
	},
	chat_filter: {
		label: 'ChatFilter',
		section: 'utilities',
		terms: ['filter', 'blocked terms', 'censor', 'hide']
	},
	custom_quoter: {
		label: 'CustomQuoter',
		section: 'utilities',
		terms: ['quote', 'template', 'copy quote', 'format']
	},
	image_utilities: {
		label: 'ImageUtilities',
		section: 'media',
		terms: ['image', 'reverse image search', 'lens', 'bing', 'tineye', 'yandex']
	},
	spellcheck: {
		label: 'SpellCheck',
		section: 'chat',
		terms: ['spellcheck', 'spelling', 'composer']
	},
	char_counter: {
		label: 'CharCounter',
		section: 'chat',
		terms: ['character count', 'counter', 'composer']
	},
	split_large_messages: {
		label: 'SplitLargeMessages',
		section: 'chat',
		terms: ['split', 'long messages', 'chunk size', 'composer']
	},
	write_upper_case: {
		label: 'WriteUpperCase',
		section: 'chat',
		terms: ['capitalize', 'sentence case', 'auto-capitalization']
	},
	clickable_mentions: {
		label: 'ClickableMentions',
		section: 'chat',
		terms: ['mentions', 'usernames', 'popout']
	},
	complete_timestamps: {
		label: 'CompleteTimestamps',
		section: 'chat',
		terms: ['timestamp', 'date', 'time']
	},
	reveal_all_spoilers: {
		label: 'RevealAllSpoilers',
		section: 'spoilers',
		terms: ['spoilers', 'reveal', 'moderation']
	},
	server_spoiler_all: {
		label: 'ServerSpoilerAll',
		section: 'spoilers',
		terms: ['spoiler', 'server', 'hide', 'veil', 'calm']
	},
	server_unspoil_all: {
		label: 'ServerUnspoilAll',
		section: 'spoilers',
		terms: ['unspoil', 'reveal', 'server', 'force reveal']
	},
	better_search_page: {
		label: 'BetterSearchPage',
		section: 'search',
		terms: ['search results', 'sticky controls', 'matches']
	},
	google_search_replace: {
		label: 'GoogleSearchReplace',
		section: 'search',
		terms: ['search on web', 'browser search', 'search engine', 'brave', 'duckduckgo', 'bing', 'google']
	},
	hide_muted_categories: {
		label: 'HideMutedCategories',
		section: 'navigation',
		terms: ['muted channels', 'sidebar', 'channel list']
	},
	read_all_notifications_button: {
		label: 'ReadAllNotificationsButton',
		section: 'navigation',
		terms: ['clear unread', 'notifications', 'sidebar']
	},
	server_counter: {
		label: 'ServerCounter',
		section: 'navigation',
		terms: ['workspace count', 'channel counter', 'sidebar']
	},
	better_nsfw_tag: {
		label: 'BetterNsfwTag',
		section: 'navigation',
		terms: ['nsfw', 'warning tag', 'channel list']
	},
	custom_status_presets: {
		label: 'CustomStatusPresets',
		section: 'identity',
		terms: ['presence', 'status', 'preset', 'sidebar']
	},
	message_utilities: {
		label: 'MessageUtilities',
		section: 'chat',
		terms: ['message actions', 'hover actions', 'quick tools']
	},
	quick_mention: {
		label: 'QuickMention',
		section: 'chat',
		terms: ['mention', 'message actions', 'quick action']
	},
	personal_pins: {
		label: 'PersonalPins',
		section: 'chat',
		terms: ['pins', 'messages', 'local pins']
	},
	last_message_date: {
		label: 'LastMessageDate',
		section: 'identity',
		terms: ['last message', 'timestamp', 'popout']
	},
	show_connections: {
		label: 'ShowConnections',
		section: 'identity',
		terms: ['profile', 'connections', 'links', 'handles']
	},
	user_notes: {
		label: 'UserNotes',
		section: 'identity',
		terms: ['notes', 'private notes', 'profile']
	},
	friend_notifications: {
		label: 'FriendNotifications',
		section: 'notifications',
		terms: ['presence alerts', 'desktop notifications', 'friends']
	},
	better_friend_list: {
		label: 'BetterFriendList',
		section: 'navigation',
		terms: ['friend list', 'sort', 'filter', 'right panel']
	},
	emoji_statistics: {
		label: 'EmojiStatistics',
		section: 'media',
		terms: ['emoji', 'inventory', 'statistics', 'categories']
	},
	remove_nicknames: {
		label: 'RemoveNicknames',
		section: 'identity',
		terms: ['nicknames', 'account names', 'display names']
	},
	local_nicknames: {
		label: 'LocalNicknames',
		section: 'identity',
		terms: ['nicknames', 'private nicknames', 'display names']
	},
	spotify_controls: {
		label: 'SpotifyControls',
		section: 'media',
		terms: ['spotify', 'music', 'track', 'playlist']
	},
	staff_tag: {
		label: 'StaffTag',
		section: 'identity',
		terms: ['staff', 'moderator', 'admin', 'role']
	},
	top_role_everywhere: {
		label: 'TopRoleEverywhere',
		section: 'identity',
		terms: ['top role', 'badge', 'role']
	},
	timed_theme_mode: {
		label: 'TimedLightDarkMode',
		section: 'appearance',
		terms: ['theme', 'light mode', 'dark mode', 'schedule']
	},
	unicode_emojis: {
		label: 'UnicodeEmojis',
		section: 'chat',
		terms: ['emoji', 'unicode', 'shortcode', 'openmoji']
	},
	gif_captioner: {
		label: 'GifCaptioner',
		section: 'media',
		terms: ['gif', 'caption', 'media']
	},
	zip_preview: {
		label: 'ZipPreview',
		section: 'media',
		terms: ['zip', 'archive', 'preview', 'attachments']
	},
	more_quick_reacts: {
		label: 'MoreQuickReacts',
		section: 'media',
		terms: ['quick reacts', 'reactions', 'emoji shortcuts']
	},
	pin_dms: {
		label: 'PinDMs',
		section: 'dms',
		terms: ['pin dms', 'pinned conversations', 'direct messages']
	}
};

export function tokenizeAddonSearchQuery(value: string): string[] {
	return value
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

export function addonControlMatches(
	controlId: string,
	searchTokens: string[],
	isAvailable: (controlId: string) => boolean
): boolean {
	const meta = LOCAL_ADDON_CONTROL_META[controlId];
	if (!meta || !isAvailable(controlId)) return false;
	if (searchTokens.length === 0) return true;
	const haystack = `${meta.label} ${ADDON_SECTION_LABELS[meta.section]} ${meta.terms.join(' ')}`.toLowerCase();
	return searchTokens.every((token) => haystack.includes(token));
}

export function addonSectionHasMatches(
	section: AddonSectionId,
	searchTokens: string[],
	isAvailable: (controlId: string) => boolean
): boolean {
	return Object.entries(LOCAL_ADDON_CONTROL_META).some(
		([controlId, meta]) => meta.section === section && addonControlMatches(controlId, searchTokens, isAvailable)
	);
}

export function addonSectionMatchCount(
	section: AddonSectionId,
	searchTokens: string[],
	isAvailable: (controlId: string) => boolean
): number {
	return Object.entries(LOCAL_ADDON_CONTROL_META).filter(
		([controlId, meta]) => meta.section === section && addonControlMatches(controlId, searchTokens, isAvailable)
	).length;
}

export function countAvailableAddonControls(isAvailable: (controlId: string) => boolean): number {
	return Object.keys(LOCAL_ADDON_CONTROL_META).filter((controlId) => isAvailable(controlId)).length;
}

export function countVisibleAddonControls(
	searchTokens: string[],
	isAvailable: (controlId: string) => boolean
): number {
	return Object.keys(LOCAL_ADDON_CONTROL_META).filter((controlId) =>
		addonControlMatches(controlId, searchTokens, isAvailable)
	).length;
}
