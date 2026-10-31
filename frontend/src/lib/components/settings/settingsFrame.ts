/**
 * The Settings frame model (design contract §8.9): which pages exist, how the nav groups them,
 * what each page's scope note says, where an outside request lands, and what "Search settings"
 * can find. Settings.svelte renders this; the tests pin it.
 */

export type SettingsTab =
	| 'profile'
	| 'privacy'
	| 'notifications'
	| 'appearance'
	| 'accessibility'
	| 'audio'
	| 'games'
	| 'addons'
	| 'emojis'
	| 'storage'
	| 'admin'
	| 'about';

/** Values other surfaces may ask Settings to open (MainLayout, wabi:open-settings). */
export type SettingsRequest = 'profile' | 'server' | 'notifications' | 'audio' | 'addons' | 'admin';

export type SettingsIcon =
	| 'user'
	| 'shield'
	| 'bell'
	| 'palette'
	| 'accessibility'
	| 'headphones'
	| 'gamepad'
	| 'puzzle'
	| 'smile'
	| 'database'
	| 'key'
	| 'info';

export interface SettingsPage {
	id: SettingsTab;
	/** Locale key of the nav label and page title. */
	labelKey: string;
	/** English label, used by search and as the fallback when the key is missing. */
	label: string;
	icon: SettingsIcon;
	adminOnly?: boolean;
}

export interface SettingsNavGroup {
	id: 'account' | 'device' | 'community';
	/** Kicker text; the community group is named after the community. */
	label: string;
	pages: SettingsPage[];
}

const PAGES: Record<SettingsTab, SettingsPage> = {
	profile: { id: 'profile', labelKey: 'settings.tabs.profile', label: 'Profile', icon: 'user' },
	privacy: { id: 'privacy', labelKey: 'settings.tabs.privacy', label: 'Privacy & security', icon: 'shield' },
	notifications: { id: 'notifications', labelKey: 'settings.tabs.notifications', label: 'Notifications', icon: 'bell' },
	appearance: { id: 'appearance', labelKey: 'settings.tabs.appearance', label: 'Appearance', icon: 'palette' },
	accessibility: { id: 'accessibility', labelKey: 'settings.tabs.accessibility', label: 'Accessibility', icon: 'accessibility' },
	audio: { id: 'audio', labelKey: 'settings.tabs.audio', label: 'Audio & video', icon: 'headphones' },
	games: { id: 'games', labelKey: 'settings.tabs.games', label: 'Games', icon: 'gamepad' },
	addons: { id: 'addons', labelKey: 'settings.tabs.addons', label: 'Add-ons', icon: 'puzzle' },
	emojis: { id: 'emojis', labelKey: 'settings.tabs.emojis', label: 'Emojis', icon: 'smile' },
	storage: { id: 'storage', labelKey: 'settings.tabs.storage', label: 'Storage', icon: 'database' },
	admin: { id: 'admin', labelKey: 'settings.tabs.admin', label: 'Admin', icon: 'key', adminOnly: true },
	about: { id: 'about', labelKey: 'settings.tabs.about', label: 'About', icon: 'info' }
};

export const SETTINGS_PAGES: Readonly<Record<SettingsTab, SettingsPage>> = PAGES;

/** About lives in the nav foot with Sign out, below the groups. */
export const FOOT_PAGE = PAGES.about;

export function settingsNavGroups(communityName: string, canManageAdmin: boolean): SettingsNavGroup[] {
	const allowed = (page: SettingsPage) => !page.adminOnly || canManageAdmin;
	return [
		{ id: 'account', label: 'Account', pages: [PAGES.profile, PAGES.privacy, PAGES.notifications] },
		{ id: 'device', label: 'This device', pages: [PAGES.appearance, PAGES.accessibility, PAGES.audio, PAGES.games, PAGES.addons] },
		{
			id: 'community',
			label: communityName.trim() || 'This community',
			pages: [PAGES.emojis, PAGES.storage, PAGES.admin].filter(allowed)
		}
	];
}

/** Every page a person can open, in nav order (foot last). */
export function settingsTabOrder(canManageAdmin: boolean): SettingsTab[] {
	return [...settingsNavGroups('', canManageAdmin).flatMap((group) => group.pages.map((page) => page.id)), FOOT_PAGE.id];
}

/**
 * Where an outside request opens. The old "Server" page held this device's location and
 * bandwidth-sharing choices, which now live under Privacy & security.
 */
export function resolveSettingsRequest(request: SettingsRequest | string | null | undefined): SettingsTab | null {
	if (!request) return null;
	if (request === 'server') return 'privacy';
	return request in PAGES ? (request as SettingsTab) : null;
}

export const DEVICE_SCOPE_NOTE = 'Saved on this device · not shared';

/**
 * Appearance for a signed-in account names what the header can say truthfully for the whole
 * page: the theme (and its tuning) and an uploaded chat background image are saved to the account
 * (saveThemePreferences, persistBackgroundImageSetting). It makes no claim about "the rest": some
 * Layout rows follow the account too, and the Layout section says which
 * (appearanceLayoutScopeHint). Short enough to sit beside the page title at the 1040 dialog.
 */
export const APPEARANCE_ACCOUNT_SCOPE_NOTE = 'Theme and background image follow your account';

/**
 * The Layout section's one-line locality hint, signed in: the rows of a THIS DEVICE page that
 * follow the account instead. Navigation side and the desktop app's layout presets live in the
 * workspace layout that queuePersist also PUTs to /api/user/layout (the newer copy wins when
 * another device loads), and the server rail's density and side sit in the same account container
 * (railLayout.ts). Open to, Visible navigation, Panels pinned side by side and Peek a side panel
 * stay in this browser, as the page's nav group says. Signed out nothing leaves the device, which
 * the page header already says, so there is no line.
 */
export function appearanceLayoutScopeHint(signedIn: boolean, layoutPresets: boolean): string {
	if (!signedIn) return '';
	return layoutPresets
		? 'Navigation side, the server rail and layout presets follow your account.'
		: 'Navigation side and the server rail follow your account.';
}

/**
 * The header's scope note (§9.3), said once for the whole page: device pages say they stay here,
 * community pages say who sees them. Pages that mix both, or describe rather than store, have
 * none and say it in their sections instead (Notifications keeps sounds here, but its push
 * choices are account switches that reach every device on the account).
 */
export function settingsScopeNote(tab: SettingsTab, communityName: string, signedIn = false): string {
	switch (tab) {
		case 'appearance':
			return signedIn ? APPEARANCE_ACCOUNT_SCOPE_NOTE : DEVICE_SCOPE_NOTE;
		case 'accessibility':
		case 'audio':
		case 'addons':
			return DEVICE_SCOPE_NOTE;
		case 'profile':
			// The page also holds the password and payment references, which members never see,
			// so the note names what they do see.
			return `Your profile is visible to members of ${communityName.trim() || 'this community'}`;
		case 'emojis':
		case 'admin':
			return `Visible to members of ${communityName.trim() || 'this community'}`;
		default:
			return '';
	}
}

// ---------------------------------------------------------------------------- landing on a row

/**
 * What a search jump focuses inside the row it lands on, best first: the checked option of a
 * segmented control or radio group (never an unchecked key, where one Space press would change
 * the setting), then the row's tab stop, then its first enabled control.
 */
export const ROW_FOCUS_SELECTORS = [
	'[role="radio"][aria-checked="true"]',
	'[tabindex="0"]',
	'button:not([tabindex="-1"]):not(:disabled), input:not([type="hidden"]):not([tabindex="-1"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]'
] as const;

export function rowFocusTarget<T>(row: { querySelector(selector: string): T | null }): T | null {
	for (const selector of ROW_FOCUS_SELECTORS) {
		const found = row.querySelector(selector);
		if (found) return found;
	}
	return null;
}

/**
 * The page scroller's scrollTop that centres a row in it (rects in viewport pixels). Only the
 * page column scrolls: scrollIntoView would also scroll the clipped dialog frame around it.
 */
export function centeredScrollTop(
	scroller: { scrollTop: number; top: number; height: number; scrollHeight: number },
	row: { top: number; height: number }
): number {
	const offset = row.top - scroller.top - Math.max(0, (scroller.height - row.height) / 2);
	const max = Math.max(0, scroller.scrollHeight - scroller.height);
	return Math.min(max, Math.max(0, Math.round(scroller.scrollTop + offset)));
}

// ---------------------------------------------------------------------------- layout

/** "Panels pinned side by side": every limit the layout store accepts (1…max). */
export function dockLimitOptions(max: number): Array<{ value: string; label: string }> {
	return Array.from({ length: Math.max(1, Math.floor(max)) }, (_, index) => {
		const count = index + 1;
		return { value: String(count), label: count === 1 ? '1 panel' : `${count} panels` };
	});
}

// ---------------------------------------------------------------------------- search

export interface SettingsSearchEntry {
	tab: SettingsTab;
	/** The row or section label as it appears on the page (used to find it there). */
	label: string;
	/** Other words people use for it. */
	keywords?: string[];
}

/**
 * What "Search settings" can find. Labels are the visible row or section labels on each page,
 * so choosing a result can scroll to it; keywords catch other words for the same thing.
 */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
	// Account
	{ tab: 'profile', label: 'Display name', keywords: ['name', 'nickname'] },
	{ tab: 'profile', label: 'Profile picture', keywords: ['avatar', 'photo', 'picture'] },
	{ tab: 'profile', label: 'Banner', keywords: ['header image', 'cover'] },
	{ tab: 'profile', label: 'Status message', keywords: ['status', 'custom status'] },
	{ tab: 'profile', label: 'About me', keywords: ['bio', 'description'] },
	{ tab: 'profile', label: 'Password', keywords: ['change password', 'account', 'sign in'] },
	{ tab: 'privacy', label: 'Privacy & security', keywords: ['encryption', 'server-readable', 'who can read', 'privacy'] },
	{ tab: 'privacy', label: 'Directions GPS', keywords: ['location', 'gps', 'directions'] },
	{ tab: 'privacy', label: 'Boost this server', keywords: ['bandwidth', 'volunteer', 'relay', 'network address'] },
	{ tab: 'notifications', label: 'Notifications', keywords: ['alerts', 'desktop notifications', 'push'] },
	{ tab: 'notifications', label: 'Notification sound', keywords: ['sound', 'chime', 'volume'] },
	{ tab: 'notifications', label: 'Message preview', keywords: ['preview', 'notification text'] },
	{ tab: 'notifications', label: 'Mentions', keywords: ['@everyone', '@here', 'role mentions'] },
	{ tab: 'notifications', label: 'Ringtone', keywords: ['call sound', 'ring'] },
	// This device
	{ tab: 'appearance', label: 'Theme', keywords: ['color', 'colour', 'dark mode', 'light mode', 'high contrast', 'daylight'] },
	{ tab: 'appearance', label: 'Text size', keywords: ['font size', 'zoom', 'scale', 'bigger text'] },
	{ tab: 'appearance', label: 'Message density', keywords: ['compact', 'cozy', 'spacing'] },
	{ tab: 'appearance', label: 'Your messages on the right', keywords: ['align', 'bubbles', 'own messages'] },
	{ tab: 'appearance', label: 'Reduce motion', keywords: ['animation', 'motion', 'movement'] },
	{ tab: 'appearance', label: 'Language', keywords: ['locale', 'translation', 'english', 'español', 'ไทย'] },
	{ tab: 'appearance', label: 'Chat background', keywords: ['backdrop', 'wallpaper', 'background image', 'scene'] },
	{ tab: 'appearance', label: 'Avatars in chat', keywords: ['profile pictures', 'avatars'] },
	{ tab: 'appearance', label: 'Send button', keywords: ['composer'] },
	{ tab: 'appearance', label: 'Deletion timer', keywords: ['expiry', 'countdown', 'retention'] },
	{ tab: 'appearance', label: 'Open to', keywords: ['start page', 'opening', 'home'] },
	{ tab: 'appearance', label: 'Panels pinned side by side', keywords: ['dock', 'right panel', 'pins'] },
	{ tab: 'appearance', label: 'Peek a side panel', keywords: ['peek', 'hover', 'rail', 'stub'] },
	{ tab: 'appearance', label: 'Server rail', keywords: ['servers', 'rail density', 'rail side'] },
	{ tab: 'appearance', label: 'Video compression', keywords: ['upload', 'video quality'] },
	{ tab: 'appearance', label: 'Profile decorations', keywords: ['cosmetics', 'nameplates', 'styled names', 'banners'] },
	{ tab: 'appearance', label: 'Customize theme', keywords: ['custom theme', 'fonts', 'effects', 'colors'] },
	{ tab: 'appearance', label: 'Pointer effects', keywords: ['cursor', 'mouse', 'trail', 'feelers'] },
	{ tab: 'appearance', label: 'Performance', keywords: ['animations', 'pop-out', 'windows', 'spring'] },
	{ tab: 'accessibility', label: 'Text size', keywords: ['interface scale', 'zoom', 'larger'] },
	{ tab: 'accessibility', label: 'Color assist', keywords: ['colour assist', 'saturation', 'contrast', 'filters'] },
	{ tab: 'accessibility', label: 'Reduce motion', keywords: ['animation', 'vestibular'] },
	{ tab: 'accessibility', label: 'Motion polish', keywords: ['transitions', 'animation preset', 'speed'] },
	{ tab: 'accessibility', label: 'Name colors', keywords: ['role colors', 'role colours', 'usernames'] },
	{ tab: 'audio', label: 'Microphone', keywords: ['input', 'mic', 'push to talk', 'voice activity'] },
	{ tab: 'audio', label: 'Camera', keywords: ['video', 'webcam'] },
	{ tab: 'audio', label: 'Noise suppression', keywords: ['echo', 'noise', 'gain'] },
	{ tab: 'audio', label: 'Test your microphone', keywords: ['mic test', 'hear myself', 'input level'] },
	{ tab: 'audio', label: 'Place voices around you', keywords: ['spatial audio', 'headphones', '3d sound'] },
	{ tab: 'audio', label: 'Screen share resolution', keywords: ['screen share', 'bitrate', 'media quality'] },
	{ tab: 'audio', label: 'Show connection details during calls', keywords: ['connection', 'ping', 'diagnostics', 'troubleshooting'] },
	{ tab: 'games', label: 'Games', keywords: ['steam', 'game board'] },
	{ tab: 'addons', label: 'Add-ons', keywords: ['plugins', 'sheets', 'present', 'extensions'] },
	// Community
	{ tab: 'emojis', label: 'Custom emojis', keywords: ['emoji', 'stickers', 'upload emoji'] },
	{ tab: 'storage', label: 'Chat history', keywords: ['storage', 'offline', 'archive', 'export'] },
	{ tab: 'admin', label: 'Admin', keywords: ['administration', 'dashboard', 'roles', 'moderation', 'branding'] },
	{ tab: 'about', label: 'About', keywords: ['version', 'build', 'licence', 'license'] }
];

export interface SettingsSearchResult extends SettingsSearchEntry {
	/** Title of the page the result opens. */
	pageLabel: string;
}

function normalize(text: string): string {
	return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Results for a query, best first: a label that starts with it, then a label word that starts
 * with it, then a keyword or page name that contains it. Admin-only pages are left out for others.
 */
export function searchSettings(query: string, canManageAdmin: boolean, limit = 8): SettingsSearchResult[] {
	const needle = normalize(query);
	if (!needle) return [];
	const allowed = new Set(settingsTabOrder(canManageAdmin));
	const scored: Array<{ result: SettingsSearchResult; score: number; order: number }> = [];
	SETTINGS_SEARCH_INDEX.forEach((entry, order) => {
		if (!allowed.has(entry.tab)) return;
		const page = PAGES[entry.tab];
		const label = normalize(entry.label);
		let score = 0;
		if (label.startsWith(needle)) score = 4;
		else if (label.split(' ').some((word) => word.startsWith(needle))) score = 3;
		else if (label.includes(needle)) score = 2;
		else if ((entry.keywords ?? []).some((keyword) => normalize(keyword).includes(needle)) || normalize(page.label).includes(needle)) score = 1;
		if (score) scored.push({ result: { ...entry, pageLabel: page.label }, score, order });
	});
	scored.sort((a, b) => b.score - a.score || a.order - b.order);
	return scored.slice(0, limit).map((item) => item.result);
}

// ---------------------------------------------------------------------------- text size

/** Text size keys on Appearance (§8.9) and the wider set on Accessibility. */
export const APPEARANCE_TEXT_SIZES = [0.9, 1, 1.12, 1.25] as const;
export const ACCESSIBILITY_TEXT_SIZES = [0.9, 1, 1.12, 1.25, 1.5] as const;

export interface TextSizeOption {
	value: number;
	label: string;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * Seg options for the interface scale. A saved value that is not one of the keys (the older
 * slider allowed any step) is added in order, so the control always shows the real setting.
 */
export function textSizeOptions(current: number, keys: readonly number[]): TextSizeOption[] {
	const values = [...keys];
	if (Number.isFinite(current) && !values.some((value) => Math.abs(value - current) < 0.005)) values.push(current);
	return values.sort((a, b) => a - b).map((value) => ({ value, label: percent(value) }));
}

/** The key equal to `current` (within rounding), or `current` itself when it is extra. */
export function textSizeValue(current: number, options: TextSizeOption[]): number {
	return options.find((option) => Math.abs(option.value - current) < 0.005)?.value ?? current;
}
