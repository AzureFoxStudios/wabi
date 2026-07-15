import { browser } from '$app/environment';

const ACCESSIBILITY_SETTINGS_KEY = 'accessibilitySettings';
const INTERFACE_SCALE_STORAGE_KEY = 'accessibilityInterfaceScale';
const MIN_INTERFACE_SCALE = 0.85;
const MAX_INTERFACE_SCALE = 1.5;
const DEFAULT_INTERFACE_SCALE = 1;
const MIN_SATURATION = 0.6;
const MAX_SATURATION = 1.8;
const MIN_CONTRAST = 0.8;
const MAX_CONTRAST = 1.4;
const MIN_APP_CHROME_OPACITY = 0.2;
const MAX_APP_CHROME_OPACITY = 1;
const DEFAULT_APP_CHROME_OPACITY = 1;

export type RoleColorMode = 'full' | 'dot' | 'off';
export type ChatAvatarMode = 'off' | 'user' | 'all';
export type MessageDensity = 'cozy' | 'compact';
export type DeletionCountdownMode = 'off' | 'static' | 'live';

export interface AccessibilitySettings {
	interfaceScale: number;
	colorAssistEnabled: boolean;
	saturation: number;
	contrast: number;
	reducedMotion: boolean;
	roleColorMode: RoleColorMode;
	ownMessagesOnRight: boolean;
	chatAvatarMode: ChatAvatarMode;
	appChromeOpacity: number;
	messageDensity: MessageDensity;
	deletionCountdownMode: DeletionCountdownMode;
	clickableSendEnabled: boolean;
}

const DEFAULT_SETTINGS: AccessibilitySettings = {
	interfaceScale: DEFAULT_INTERFACE_SCALE,
	colorAssistEnabled: false,
	saturation: 1,
	contrast: 1,
	reducedMotion: false,
	roleColorMode: 'full',
	ownMessagesOnRight: false,
	chatAvatarMode: 'all',
	appChromeOpacity: DEFAULT_APP_CHROME_OPACITY,
	messageDensity: 'cozy',
	deletionCountdownMode: 'static',
	clickableSendEnabled: true
};

function normalizeChatAvatarMode(value: string | undefined): ChatAvatarMode {
	if (value === 'off' || value === 'user' || value === 'all') return value;
	return 'all';
}

let currentSettings: AccessibilitySettings = { ...DEFAULT_SETTINGS };

function clampInterfaceScale(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_INTERFACE_SCALE;
	return Math.min(MAX_INTERFACE_SCALE, Math.max(MIN_INTERFACE_SCALE, value));
}

function clampSaturation(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(MAX_SATURATION, Math.max(MIN_SATURATION, value));
}

function clampContrast(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(MAX_CONTRAST, Math.max(MIN_CONTRAST, value));
}

function clampAppChromeOpacity(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_APP_CHROME_OPACITY;
	return Math.min(MAX_APP_CHROME_OPACITY, Math.max(MIN_APP_CHROME_OPACITY, value));
}

function normalizeRoleColorMode(value: string | undefined): RoleColorMode {
	if (value === 'dot' || value === 'off' || value === 'full') return value;
	return 'full';
}

function normalizeMessageDensity(value: string | undefined): MessageDensity {
	if (value === 'compact') return 'compact';
	return 'cozy';
}

function normalizeDeletionCountdownMode(value: string | undefined): DeletionCountdownMode {
	if (value === 'off' || value === 'live' || value === 'static') return value;
	return 'static';
}

function normalizeSettings(raw: Partial<AccessibilitySettings> | null | undefined): AccessibilitySettings {
	return {
		interfaceScale: clampInterfaceScale(raw?.interfaceScale ?? DEFAULT_SETTINGS.interfaceScale),
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
		),
		appChromeOpacity: clampAppChromeOpacity(
			typeof (raw as any)?.appChromeOpacity === 'number'
				? (raw as any).appChromeOpacity
				: DEFAULT_APP_CHROME_OPACITY
		),
		messageDensity: normalizeMessageDensity((raw as any)?.messageDensity),
		deletionCountdownMode: normalizeDeletionCountdownMode((raw as any)?.deletionCountdownMode),
		clickableSendEnabled: (raw as any)?.clickableSendEnabled !== false
	};
}

function readRgbVariable(root: HTMLElement, variableName: string, fallback: string): string {
	const value = getComputedStyle(root).getPropertyValue(variableName).trim();
	return value || fallback;
}

function applyAppChromeOpacity(root: HTMLElement, opacity: number): void {
	const clamped = clampAppChromeOpacity(opacity);
	const bgPrimaryRgb = readRgbVariable(root, '--surface-app-rgb', '15, 12, 41');
	const bgSecondaryRgb = readRgbVariable(root, '--surface-base-rgb', '26, 26, 46');
	const bgTertiaryRgb = readRgbVariable(root, '--surface-raised-rgb', '36, 36, 62');
	const borderRgb = readRgbVariable(root, '--border-rgb', '48, 43, 99');

	root.style.setProperty('--app-chrome-opacity', String(clamped));

	// Legacy tokens (for any remaining old consumers)
	root.style.setProperty('--bg-primary', `rgba(${bgPrimaryRgb}, ${clamped})`);
	root.style.setProperty('--bg-secondary', `rgba(${bgSecondaryRgb}, ${clamped})`);
	root.style.setProperty('--bg-tertiary', `rgba(${bgTertiaryRgb}, ${clamped})`);
	root.style.setProperty('--bg-hover', `rgba(${bgTertiaryRgb}, ${Math.min(1, clamped + 0.08)})`);
	root.style.setProperty('--ui-bg-light', `rgba(${bgTertiaryRgb}, ${clamped})`);
	root.style.setProperty('--ui-bg-lighter', `rgba(${bgSecondaryRgb}, ${clamped})`);
	root.style.setProperty('--modal-bg', `rgba(${bgPrimaryRgb}, ${Math.min(1, clamped + 0.1)})`);
	root.style.setProperty('--modal-header-bg', `rgba(${bgSecondaryRgb}, ${Math.min(1, clamped + 0.08)})`);
	root.style.setProperty('--border', `rgba(${borderRgb}, ${Math.max(0.25, clamped)})`);

	// Semantic tokens (for migrated components)
	root.style.setProperty('--surface-app', `rgba(${bgPrimaryRgb}, ${clamped})`);
	root.style.setProperty('--surface-base', `rgba(${bgSecondaryRgb}, ${clamped})`);
	root.style.setProperty('--surface-raised', `rgba(${bgTertiaryRgb}, ${clamped})`);
	root.style.setProperty('--surface-hover', `rgba(${bgTertiaryRgb}, ${Math.min(1, clamped + 0.08)})`);
	root.style.setProperty('--surface-modal', `rgba(${bgPrimaryRgb}, ${Math.min(1, clamped + 0.1)})`);
	root.style.setProperty('--border-subtle', `rgba(${borderRgb}, ${Math.max(0.25, clamped)})`);
}

function saveSettings(settings: AccessibilitySettings): void {
	if (!browser) return;
	localStorage.setItem(ACCESSIBILITY_SETTINGS_KEY, JSON.stringify(settings));
	// Keep legacy key for compatibility with older text-scale-only logic.
	localStorage.setItem(INTERFACE_SCALE_STORAGE_KEY, String(settings.interfaceScale));
}

export function getStoredAccessibilitySettings(): AccessibilitySettings {
	if (!browser) return { ...DEFAULT_SETTINGS };
	try {
		const raw = localStorage.getItem(ACCESSIBILITY_SETTINGS_KEY);
		if (raw) {
			const s = normalizeSettings(JSON.parse(raw) as Partial<AccessibilitySettings>); s.messageDensity = "cozy"; return s;
		}
	} catch {
		// Fall through to legacy/default loading
	}
	return {
		...DEFAULT_SETTINGS,
		interfaceScale: getStoredInterfaceScale()
	};
}

export function getStoredInterfaceScale(): number {
	if (!browser) return DEFAULT_INTERFACE_SCALE;
	const raw = localStorage.getItem(INTERFACE_SCALE_STORAGE_KEY);
	if (!raw) return DEFAULT_INTERFACE_SCALE;
	return clampInterfaceScale(parseFloat(raw));
}

export function applyInterfaceScale(scale: number): void {
	if (!browser) return;
	const clamped = clampInterfaceScale(scale);
	document.documentElement.style.setProperty('--app-font-scale', String(clamped));
}

export function setStoredInterfaceScale(scale: number): number {
	if (!browser) return DEFAULT_INTERFACE_SCALE;
	const clamped = clampInterfaceScale(scale);
	const next = { ...currentSettings, interfaceScale: clamped };
	saveSettings(next);
	applyAccessibilitySettings(next);
	return clamped;
}

export function applyAccessibilitySettings(settings: AccessibilitySettings): void {
	if (!browser) return;
	currentSettings = normalizeSettings(settings);
	const root = document.documentElement;
	applyInterfaceScale(currentSettings.interfaceScale);
	root.style.setProperty('--app-saturation', String(currentSettings.saturation));
	root.style.setProperty('--app-contrast', String(currentSettings.contrast));
	root.setAttribute('data-reduce-motion', currentSettings.reducedMotion ? 'true' : 'false');
	root.setAttribute('data-role-color-mode', currentSettings.roleColorMode);
	root.setAttribute('data-color-assist', currentSettings.colorAssistEnabled ? 'true' : 'false');
	root.setAttribute('data-own-messages-right', currentSettings.ownMessagesOnRight ? 'true' : 'false');
	root.setAttribute('data-chat-avatar-mode', currentSettings.chatAvatarMode);
	currentSettings.messageDensity = "cozy";
	root.setAttribute('data-message-density', currentSettings.messageDensity);
	root.setAttribute('data-deletion-countdown-mode', currentSettings.deletionCountdownMode);
	root.setAttribute('data-clickable-send', currentSettings.clickableSendEnabled ? 'true' : 'false');
	applyAppChromeOpacity(root, currentSettings.appChromeOpacity);
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
