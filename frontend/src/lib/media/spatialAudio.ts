import { browser } from '$app/environment';
import { STORAGE_KEYS } from './mediaStorage';

export type SpatialAudioMode = 'auto' | 'pan_distance' | 'full_3d' | 'off';

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export interface SpatialAudioSettings {
	enabled: boolean;
	mode: SpatialAudioMode;
	masterStrength: number;
	distanceScale: number;
	warningMuted: boolean;
	quickToggleVisible: boolean;
}

export function getStoredSpatialAudioSettings(): SpatialAudioSettings {
	if (!browser) {
		return {
			enabled: false,
			mode: 'auto',
			masterStrength: 0.85,
			distanceScale: 1,
			warningMuted: false,
			quickToggleVisible: true
		};
	}

	const enabled = localStorage.getItem(STORAGE_KEYS.spatialEnabled) === 'true';
	const modeStored = localStorage.getItem(STORAGE_KEYS.spatialMode);
	const mode: SpatialAudioMode = modeStored === 'auto' || modeStored === 'pan_distance' || modeStored === 'full_3d' || modeStored === 'off'
		? modeStored
		: 'auto';
	const masterStrength = clamp(parseFloat(localStorage.getItem(STORAGE_KEYS.spatialStrength) || '0.85') || 0.85, 0, 1);
	const distanceScale = clamp(parseFloat(localStorage.getItem(STORAGE_KEYS.spatialDistanceScale) || '1') || 1, 0.4, 4);
	const warningMuted = localStorage.getItem(STORAGE_KEYS.spatialWarningMuted) === 'true';
	const quickToggleVisible = localStorage.getItem(STORAGE_KEYS.spatialQuickToggleVisible) !== 'false';

	return {
		enabled,
		mode,
		masterStrength,
		distanceScale,
		warningMuted,
		quickToggleVisible
	};
}

export function setSpatialAudioEnabled(enabled: boolean): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialEnabled, String(enabled));
}

export function setSpatialAudioMode(mode: SpatialAudioMode): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialMode, mode);
}

export function setSpatialAudioMasterStrength(value: number): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialStrength, String(clamp(value, 0, 1)));
}

export function setSpatialAudioDistanceScale(value: number): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialDistanceScale, String(clamp(value, 0.4, 4)));
}

export function setSpatialAudioWarningMuted(muted: boolean): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialWarningMuted, String(muted));
}

export function setSpatialAudioQuickToggleVisible(visible: boolean): void {
	if (!browser) return;
	localStorage.setItem(STORAGE_KEYS.spatialQuickToggleVisible, String(visible));
}
