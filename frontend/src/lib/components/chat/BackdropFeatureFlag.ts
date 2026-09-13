import { loadChatBackdropSettings } from '$lib/theme/chatBackdrop';

export function syncChatBackdropMarker(root: HTMLElement | null) {
	if (!root) return;
	const active = loadChatBackdropSettings().scene !== 'none';
	root.dataset.chatBackdrop = String(active);
}
