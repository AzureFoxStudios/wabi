export type ChatBackdropScene = 'none' | 'koi';

export type ChatBackdropSettings = {
	scene: ChatBackdropScene;
	motion: number;
	dim: number;
	frost: number;
};

const STORAGE_KEY = 'wabi.chatBackdrop';

export const defaultChatBackdropSettings: ChatBackdropSettings = {
	scene: 'none',
	motion: 0.65,
	dim: 0.16,
	frost: 0.32
};

export function loadChatBackdropSettings(): ChatBackdropSettings {
	if (typeof localStorage === 'undefined') return { ...defaultChatBackdropSettings };
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		return {
			scene: parsed.scene === 'koi' ? 'koi' : 'none',
			motion: clamp(parsed.motion, defaultChatBackdropSettings.motion),
			dim: clamp(parsed.dim, defaultChatBackdropSettings.dim),
			frost: clamp(parsed.frost, defaultChatBackdropSettings.frost)
		};
	} catch {
		return { ...defaultChatBackdropSettings };
	}
}

export function saveChatBackdropSettings(settings: ChatBackdropSettings) {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	window.dispatchEvent(new CustomEvent('wabi:chat-backdrop-change', { detail: settings }));
}

function clamp(value: unknown, fallback: number) {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.max(0, Math.min(1, value))
		: fallback;
}
