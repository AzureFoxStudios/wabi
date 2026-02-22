import { browser } from '$app/environment';

const ACCESSIBILITY_SETTINGS_KEY = 'accessibilitySettings';
const TEXT_SCALE_STORAGE_KEY = 'accessibilityTextScale';
const MIN_TEXT_SCALE = 0.85;
const MAX_TEXT_SCALE = 1.35;
const DEFAULT_TEXT_SCALE = 1;
const MIN_SATURATION = 0.6;
const MAX_SATURATION = 1.8;
const MIN_CONTRAST = 0.8;
const MAX_CONTRAST = 1.4;

export type RoleColorMode = 'full' | 'dot' | 'off';
export type ChatAvatarMode = 'off' | 'user' | 'all';

export interface AccessibilitySettings {
	textScale: number;
	colorAssistEnabled: boolean;
	saturation: number;
	contrast: number;
	reducedMotion: boolean;
	roleColorMode: RoleColorMode;
	ownMessagesOnRight: boolean;
	chatAvatarMode: ChatAvatarMode;
}

const DEFAULT_SETTINGS: AccessibilitySettings = {
	textScale: DEFAULT_TEXT_SCALE,
	colorAssistEnabled: false,
	saturation: 1,
	contrast: 1,
	reducedMotion: false,
	roleColorMode: 'full',
	ownMessagesOnRight: false,
	chatAvatarMode: 'all'
};

function normalizeChatAvatarMode(value: string | undefined): ChatAvatarMode {
	if (value === 'off' || value === 'user' || value === 'all') return value;
	return 'all';
}

let currentSettings: AccessibilitySettings = { ...DEFAULT_SETTINGS };

function clampTextScale(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE;
	return Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, value));
}

function clampSaturation(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(MAX_SATURATION, Math.max(MIN_SATURATION, value));
}

function clampContrast(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(MAX_CONTRAST, Math.max(MIN_CONTRAST, value));
}

function normalizeRoleColorMode(value: string | undefined): RoleColorMode {
	if (value === 'dot' || value === 'off' || value === 'full') return value;
	return 'full';
}

function normalizeSettings(raw: Partial<AccessibilitySettings> | null | undefined): AccessibilitySettings {
	return {
		textScale: clampTextScale(raw?.textScale ?? DEFAULT_SETTINGS.textScale),
		colorAssistEnabled: raw?.colorAssistEnabled === true,
		saturation: clampSaturation(raw?.saturation ?? DEFAULT_SETTINGS.saturation),
		contrast: clampContrast(raw?.contrast ?? DEFAULT_SETTINGS.contrast),
		reducedMotion: raw?.reducedMotion === true,
		roleColorMode: normalizeRoleColorMode(raw?.roleColorMode),
		ownMessagesOnRight: raw?.ownMessagesOnRight === true,
		chatAvatarMode: normalizeChatAvatarMode(
			(typeof (raw as any)?.chatAvatarMode === 'string'
				? (raw as any).chatAvatarMode
				: (raw as any)?.showChatProfilePictures === false
					? 'off'
					: 'all')
		)
	};
}

function saveSettings(settings: AccessibilitySettings): void {
	if (!browser) return;
	localStorage.setItem(ACCESSIBILITY_SETTINGS_KEY, JSON.stringify(settings));
	// Keep legacy key for compatibility with older text-scale-only logic.
	localStorage.setItem(TEXT_SCALE_STORAGE_KEY, String(settings.textScale));
}

export function getStoredAccessibilitySettings(): AccessibilitySettings {
	if (!browser) return { ...DEFAULT_SETTINGS };
	try {
		const raw = localStorage.getItem(ACCESSIBILITY_SETTINGS_KEY);
		if (raw) {
			return normalizeSettings(JSON.parse(raw) as Partial<AccessibilitySettings>);
		}
	} catch {
		// Fall through to legacy/default loading
	}
	return {
		...DEFAULT_SETTINGS,
		textScale: getStoredTextScale()
	};
}

export function getStoredTextScale(): number {
	if (!browser) return DEFAULT_TEXT_SCALE;
	const raw = localStorage.getItem(TEXT_SCALE_STORAGE_KEY);
	if (!raw) return DEFAULT_TEXT_SCALE;
	return clampTextScale(parseFloat(raw));
}

export function applyTextScale(scale: number): void {
	if (!browser) return;
	const clamped = clampTextScale(scale);
	document.documentElement.style.setProperty('--app-font-scale', String(clamped));
}

export function setStoredTextScale(scale: number): number {
	if (!browser) return DEFAULT_TEXT_SCALE;
	const clamped = clampTextScale(scale);
	const next = { ...currentSettings, textScale: clamped };
	saveSettings(next);
	applyAccessibilitySettings(next);
	return clamped;
}

export function applyAccessibilitySettings(settings: AccessibilitySettings): void {
	if (!browser) return;
	currentSettings = normalizeSettings(settings);
	const root = document.documentElement;
	applyTextScale(currentSettings.textScale);
	root.style.setProperty('--app-saturation', String(currentSettings.saturation));
	root.style.setProperty('--app-contrast', String(currentSettings.contrast));
	root.setAttribute('data-reduce-motion', currentSettings.reducedMotion ? 'true' : 'false');
	root.setAttribute('data-role-color-mode', currentSettings.roleColorMode);
	root.setAttribute('data-color-assist', currentSettings.colorAssistEnabled ? 'true' : 'false');
	root.setAttribute('data-own-messages-right', currentSettings.ownMessagesOnRight ? 'true' : 'false');
	root.setAttribute('data-chat-avatar-mode', currentSettings.chatAvatarMode);
}

export function updateAccessibilitySettings(partial: Partial<AccessibilitySettings>): AccessibilitySettings {
	if (!browser) return normalizeSettings({ ...currentSettings, ...partial });
	const next = normalizeSettings({ ...currentSettings, ...partial });
	saveSettings(next);
	applyAccessibilitySettings(next);
	return next;
}

export function resolveUserDisplayColor(roleColor: string | undefined, userColor: string | undefined): string {
	const fallbackColor = userColor || 'var(--status-offline)';
	if (currentSettings.roleColorMode === 'off' || currentSettings.roleColorMode === 'dot') {
		return fallbackColor;
	}
	return roleColor || fallbackColor;
}

export function initializeAccessibilitySettings(): void {
	applyAccessibilitySettings(getStoredAccessibilitySettings());
}
