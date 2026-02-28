import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type CustomStatusPresetPresence = 'active' | 'away' | 'busy';

export interface CustomStatusPreset {
	id: string;
	label: string;
	status: CustomStatusPresetPresence;
	note: string;
}

export interface CustomStatusPresetSettings {
	presets: CustomStatusPreset[];
	activePresetId: string | null;
}

export const MAX_CUSTOM_STATUS_PRESETS = 12;
const MAX_CUSTOM_STATUS_PRESET_LABEL_LENGTH = 36;
const MAX_CUSTOM_STATUS_PRESET_NOTE_LENGTH = 120;
const CUSTOM_STATUS_PRESET_SETTINGS_KEY = 'wabi.customStatusPresets.settings';

const DEFAULT_CUSTOM_STATUS_PRESETS: CustomStatusPreset[] = [
	{
		id: 'preset-focus',
		label: 'Focus',
		status: 'busy',
		note: 'Heads down right now'
	},
	{
		id: 'preset-brb',
		label: 'BRB',
		status: 'away',
		note: 'Stepping away for a bit'
	},
	{
		id: 'preset-open',
		label: 'Open',
		status: 'active',
		note: 'Available for chat'
	}
];

const DEFAULT_CUSTOM_STATUS_PRESET_SETTINGS: CustomStatusPresetSettings = {
	presets: DEFAULT_CUSTOM_STATUS_PRESETS,
	activePresetId: null
};

function sanitizePresence(value: unknown): CustomStatusPresetPresence {
	if (value === 'away' || value === 'busy') return value;
	return 'active';
}

function sanitizeText(value: unknown, maxLength: number): string {
	if (typeof value !== 'string') return '';
	const normalized = value.replace(/\s+/g, ' ').trim();
	return normalized.slice(0, maxLength);
}

function sanitizePreset(input: unknown): CustomStatusPreset | null {
	if (!input || typeof input !== 'object') return null;
	const candidate = input as Partial<CustomStatusPreset>;
	const id = sanitizeText(candidate.id, 64);
	const label = sanitizeText(candidate.label, MAX_CUSTOM_STATUS_PRESET_LABEL_LENGTH);
	if (!id || !label) return null;
	return {
		id,
		label,
		status: sanitizePresence(candidate.status),
		note: sanitizeText(candidate.note, MAX_CUSTOM_STATUS_PRESET_NOTE_LENGTH)
	};
}

function sanitizePresets(value: unknown): CustomStatusPreset[] {
	if (value === null || value === undefined) return [...DEFAULT_CUSTOM_STATUS_PRESETS];
	if (!Array.isArray(value)) return [...DEFAULT_CUSTOM_STATUS_PRESETS];
	const uniqueById = new Set<string>();
	const sanitized: CustomStatusPreset[] = [];
	for (const item of value) {
		const preset = sanitizePreset(item);
		if (!preset) continue;
		if (uniqueById.has(preset.id)) continue;
		uniqueById.add(preset.id);
		sanitized.push(preset);
		if (sanitized.length >= MAX_CUSTOM_STATUS_PRESETS) break;
	}
	return sanitized;
}

function sanitizeCustomStatusPresetSettings(
	input: Partial<CustomStatusPresetSettings> | null | undefined
): CustomStatusPresetSettings {
	const base = input || {};
	const presets = sanitizePresets(base.presets);
	const activeId = sanitizeText(base.activePresetId, 64);
	const activePresetId = activeId && presets.some((preset) => preset.id === activeId) ? activeId : null;
	return {
		presets,
		activePresetId
	};
}

function safeReadSettings(): CustomStatusPresetSettings {
	if (!browser) return { ...DEFAULT_CUSTOM_STATUS_PRESET_SETTINGS };
	try {
		const raw = localStorage.getItem(CUSTOM_STATUS_PRESET_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_CUSTOM_STATUS_PRESET_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<CustomStatusPresetSettings>;
		return sanitizeCustomStatusPresetSettings(parsed);
	} catch {
		return { ...DEFAULT_CUSTOM_STATUS_PRESET_SETTINGS };
	}
}

function safeWriteSettings(settings: CustomStatusPresetSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(CUSTOM_STATUS_PRESET_SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// best-effort persistence
	}
}

function createPresetId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `preset-${ts}-${rand}`;
}

export const customStatusPresetsStore = writable<CustomStatusPresetSettings>(safeReadSettings());

if (browser) {
	customStatusPresetsStore.subscribe((settings) => {
		safeWriteSettings(sanitizeCustomStatusPresetSettings(settings));
	});
}

export function getCustomStatusPresetSettings(): CustomStatusPresetSettings {
	return get(customStatusPresetsStore);
}

export function getActiveCustomStatusPreset(
	settings: CustomStatusPresetSettings = get(customStatusPresetsStore)
): CustomStatusPreset | null {
	if (!settings.activePresetId) return null;
	return settings.presets.find((preset) => preset.id === settings.activePresetId) || null;
}

export function setCustomStatusPresets(presets: CustomStatusPreset[]): void {
	customStatusPresetsStore.update((current) =>
		sanitizeCustomStatusPresetSettings({
			...current,
			presets
		})
	);
}

export function addCustomStatusPreset(
	label: string,
	status: CustomStatusPresetPresence,
	note = ''
): boolean {
	const normalizedLabel = sanitizeText(label, MAX_CUSTOM_STATUS_PRESET_LABEL_LENGTH);
	if (!normalizedLabel) return false;
	const settings = getCustomStatusPresetSettings();
	if (settings.presets.length >= MAX_CUSTOM_STATUS_PRESETS) return false;
	const normalizedNote = sanitizeText(note, MAX_CUSTOM_STATUS_PRESET_NOTE_LENGTH);
	const next: CustomStatusPreset = {
		id: createPresetId(),
		label: normalizedLabel,
		status: sanitizePresence(status),
		note: normalizedNote
	};
	setCustomStatusPresets([...settings.presets, next]);
	return true;
}

export function removeCustomStatusPreset(presetId: string): void {
	const normalized = sanitizeText(presetId, 64);
	if (!normalized) return;
	customStatusPresetsStore.update((current) => {
		const nextPresets = current.presets.filter((preset) => preset.id !== normalized);
		return sanitizeCustomStatusPresetSettings({
			...current,
			presets: nextPresets,
			activePresetId: current.activePresetId === normalized ? null : current.activePresetId
		});
	});
}

export function setActiveCustomStatusPreset(presetId: string | null): void {
	const normalized = sanitizeText(presetId, 64);
	customStatusPresetsStore.update((current) =>
		sanitizeCustomStatusPresetSettings({
			...current,
			activePresetId: normalized || null
		})
	);
}

export function clearActiveCustomStatusPreset(): void {
	setActiveCustomStatusPreset(null);
}

export function clearCustomStatusPresets(): void {
	customStatusPresetsStore.update((current) =>
		sanitizeCustomStatusPresetSettings({
			...current,
			presets: [],
			activePresetId: null
		})
	);
}

export function resetCustomStatusPresetsToDefaults(): void {
	customStatusPresetsStore.update((current) =>
		sanitizeCustomStatusPresetSettings({
			...current,
			presets: DEFAULT_CUSTOM_STATUS_PRESETS,
			activePresetId: null
		})
	);
}
