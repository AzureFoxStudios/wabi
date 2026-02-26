import { browser } from '$app/environment';
import { writable } from 'svelte/store';

const STORAGE_KEY = 'wabi:animation-pass:v1';

export type AnimationPassPreset = 'slip' | 'fade' | 'scale' | 'flip';
export type AnimationPassLevel = 'balanced' | 'full';

export interface AnimationPassSettings {
	enabled: boolean;
	preset: AnimationPassPreset;
	level: AnimationPassLevel;
	durationMultiplier: number;
}

const DEFAULT_SETTINGS: AnimationPassSettings = {
	enabled: true,
	preset: 'slip',
	level: 'balanced',
	durationMultiplier: 1
};

function clampDurationMultiplier(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_SETTINGS.durationMultiplier;
	return Math.min(1.6, Math.max(0.7, value));
}

function normalizePreset(value: string | undefined): AnimationPassPreset {
	if (value === 'fade' || value === 'scale' || value === 'flip' || value === 'slip') return value;
	return DEFAULT_SETTINGS.preset;
}

function normalizeLevel(value: string | undefined): AnimationPassLevel {
	if (value === 'full') return 'full';
	return 'balanced';
}

function normalizeSettings(raw: Partial<AnimationPassSettings> | null | undefined): AnimationPassSettings {
	return {
		enabled: raw?.enabled !== false,
		preset: normalizePreset(raw?.preset),
		level: normalizeLevel(raw?.level),
		durationMultiplier: clampDurationMultiplier(raw?.durationMultiplier ?? DEFAULT_SETTINGS.durationMultiplier)
	};
}

function saveSettings(settings: AnimationPassSettings): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function applySettingsToRoot(settings: AnimationPassSettings): void {
	if (!browser) return;
	const root = document.documentElement;
	root.setAttribute('data-animation-pass', settings.enabled ? settings.level : 'off');
	root.setAttribute('data-animation-preset', settings.preset);
	root.style.setProperty('--wabi-animation-multiplier', String(settings.durationMultiplier));
	const baseDistance = settings.level === 'full' ? 28 : 18;
	root.style.setProperty('--wabi-animation-distance', `${Math.round(baseDistance * settings.durationMultiplier)}px`);
}

export function getStoredAnimationPassSettings(): AnimationPassSettings {
	if (!browser) return { ...DEFAULT_SETTINGS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		return normalizeSettings(JSON.parse(raw) as Partial<AnimationPassSettings>);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

const initialSettings = browser ? getStoredAnimationPassSettings() : { ...DEFAULT_SETTINGS };

export const animationPassStore = writable<AnimationPassSettings>(initialSettings);

export function initializeAnimationPassSettings(): void {
	const settings = getStoredAnimationPassSettings();
	animationPassStore.set(settings);
	applySettingsToRoot(settings);
}

export function updateAnimationPassSettings(partial: Partial<AnimationPassSettings>): AnimationPassSettings {
	const current = getStoredAnimationPassSettings();
	const next = normalizeSettings({ ...current, ...partial });
	saveSettings(next);
	animationPassStore.set(next);
	applySettingsToRoot(next);
	return next;
}
