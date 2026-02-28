import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import { themeStore } from '$lib/theme/themeStore';
import { THEMES } from '$lib/theme/themes';

export interface TimedThemeModeSettings {
	enabled: boolean;
	dayStartHour: number;
	nightStartHour: number;
	lightThemeId: string;
	darkThemeId: string;
}

const TIMED_THEME_MODE_SETTINGS_KEY = 'wabi.timedThemeMode.settings';

const DEFAULT_TIMED_THEME_MODE_SETTINGS: TimedThemeModeSettings = {
	enabled: false,
	dayStartHour: 7,
	nightStartHour: 19,
	lightThemeId: 'light',
	darkThemeId: 'dark'
};

function sanitizeHour(value: unknown, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed < 0) return 0;
	if (parsed > 23) return 23;
	return parsed;
}

function sanitizeThemeId(value: unknown, fallback: string): string {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (normalized && THEMES[normalized]) return normalized;
	return fallback;
}

function sanitizeTimedThemeModeSettings(
	input: Partial<TimedThemeModeSettings> | null | undefined
): TimedThemeModeSettings {
	return {
		enabled: input?.enabled === true,
		dayStartHour: sanitizeHour(
			input?.dayStartHour,
			DEFAULT_TIMED_THEME_MODE_SETTINGS.dayStartHour
		),
		nightStartHour: sanitizeHour(
			input?.nightStartHour,
			DEFAULT_TIMED_THEME_MODE_SETTINGS.nightStartHour
		),
		lightThemeId: sanitizeThemeId(
			input?.lightThemeId,
			DEFAULT_TIMED_THEME_MODE_SETTINGS.lightThemeId
		),
		darkThemeId: sanitizeThemeId(
			input?.darkThemeId,
			DEFAULT_TIMED_THEME_MODE_SETTINGS.darkThemeId
		)
	};
}

function safeReadTimedThemeModeSettings(): TimedThemeModeSettings {
	if (!browser) return { ...DEFAULT_TIMED_THEME_MODE_SETTINGS };
	try {
		const raw = localStorage.getItem(TIMED_THEME_MODE_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_TIMED_THEME_MODE_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<TimedThemeModeSettings>;
		return sanitizeTimedThemeModeSettings(parsed);
	} catch {
		return { ...DEFAULT_TIMED_THEME_MODE_SETTINGS };
	}
}

function safeWriteTimedThemeModeSettings(settings: TimedThemeModeSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(TIMED_THEME_MODE_SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// best-effort persistence
	}
}

export const timedThemeModeSettingsStore = writable<TimedThemeModeSettings>(
	safeReadTimedThemeModeSettings()
);

if (browser) {
	timedThemeModeSettingsStore.subscribe((settings) => {
		safeWriteTimedThemeModeSettings(sanitizeTimedThemeModeSettings(settings));
	});
}

export function setTimedThemeModeEnabled(enabled: boolean): void {
	timedThemeModeSettingsStore.update((current) =>
		sanitizeTimedThemeModeSettings({
			...current,
			enabled
		})
	);
}

export function setTimedThemeModeDayStartHour(dayStartHour: number): void {
	timedThemeModeSettingsStore.update((current) =>
		sanitizeTimedThemeModeSettings({
			...current,
			dayStartHour
		})
	);
}

export function setTimedThemeModeNightStartHour(nightStartHour: number): void {
	timedThemeModeSettingsStore.update((current) =>
		sanitizeTimedThemeModeSettings({
			...current,
			nightStartHour
		})
	);
}

export function setTimedThemeModeLightThemeId(lightThemeId: string): void {
	timedThemeModeSettingsStore.update((current) =>
		sanitizeTimedThemeModeSettings({
			...current,
			lightThemeId
		})
	);
}

export function setTimedThemeModeDarkThemeId(darkThemeId: string): void {
	timedThemeModeSettingsStore.update((current) =>
		sanitizeTimedThemeModeSettings({
			...current,
			darkThemeId
		})
	);
}

function isDaytimeHour(hour: number, settings: TimedThemeModeSettings): boolean {
	if (settings.dayStartHour === settings.nightStartHour) {
		return true;
	}
	if (settings.dayStartHour < settings.nightStartHour) {
		return hour >= settings.dayStartHour && hour < settings.nightStartHour;
	}
	return hour >= settings.dayStartHour || hour < settings.nightStartHour;
}

export function getTimedThemeModeTargetThemeId(
	now: Date = new Date(),
	settings: TimedThemeModeSettings = get(timedThemeModeSettingsStore)
): string | null {
	if (!settings.enabled) return null;
	const hour = now.getHours();
	return isDaytimeHour(hour, settings) ? settings.lightThemeId : settings.darkThemeId;
}

export function applyTimedThemeModeNow(now: Date = new Date()): boolean {
	if (!browser) return false;
	const targetThemeId = getTimedThemeModeTargetThemeId(now);
	if (!targetThemeId) return false;
	const currentThemeId = get(themeStore).themeId;
	if (currentThemeId === targetThemeId) return false;
	themeStore.setThemeId(targetThemeId);
	return true;
}

let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerUnsubscribe: (() => void) | null = null;
let visibilityListenerInstalled = false;

function clearSchedulerTimer(): void {
	if (!schedulerTimer) return;
	clearTimeout(schedulerTimer);
	schedulerTimer = null;
}

function scheduleNextMinuteTick(): void {
	if (!browser) return;
	clearSchedulerTimer();
	const now = Date.now();
	const msToNextMinute = 60_000 - (now % 60_000) + 25;
	schedulerTimer = setTimeout(() => {
		applyTimedThemeModeNow();
		scheduleNextMinuteTick();
	}, msToNextMinute);
}

function handleSchedulerVisibilityWake(): void {
	if (!browser) return;
	const settings = get(timedThemeModeSettingsStore);
	if (!settings.enabled) return;
	applyTimedThemeModeNow();
	scheduleNextMinuteTick();
}

export function startTimedThemeModeScheduler(): () => void {
	if (!browser) return () => {};
	if (schedulerStarted) {
		return () => stopTimedThemeModeScheduler();
	}
	schedulerStarted = true;

	schedulerUnsubscribe = timedThemeModeSettingsStore.subscribe((settings) => {
		if (!settings.enabled) {
			clearSchedulerTimer();
			return;
		}
		applyTimedThemeModeNow();
		scheduleNextMinuteTick();
	});

	if (!visibilityListenerInstalled) {
		window.addEventListener('focus', handleSchedulerVisibilityWake);
		document.addEventListener('visibilitychange', handleSchedulerVisibilityWake);
		visibilityListenerInstalled = true;
	}

	return () => {
		stopTimedThemeModeScheduler();
	};
}

export function stopTimedThemeModeScheduler(): void {
	if (!browser || !schedulerStarted) return;
	schedulerStarted = false;
	clearSchedulerTimer();
	schedulerUnsubscribe?.();
	schedulerUnsubscribe = null;
	if (visibilityListenerInstalled) {
		window.removeEventListener('focus', handleSchedulerVisibilityWake);
		document.removeEventListener('visibilitychange', handleSchedulerVisibilityWake);
		visibilityListenerInstalled = false;
	}
}
