import { browser } from '$app/environment';
import { isDesktopTauri } from '$lib/tauri-platform';

export type DetachedPanelKind = 'channel-chat';

export interface DetachedPanelState {
	kind: DetachedPanelKind;
	channelId?: string;
	channelName?: string;
}

function makeDetachedUrl(state: DetachedPanelState): string {
	const url = new URL('/detached', window.location.origin);
	url.searchParams.set('kind', state.kind);

	if (state.channelId) {
		url.searchParams.set('channelId', state.channelId);
	}

	if (state.channelName) {
		url.searchParams.set('channelName', state.channelName);
	}

	return url.toString();
}

function makeDetachedTitle(state: DetachedPanelState): string {
	if (state.kind === 'channel-chat') {
		return state.channelName ? `Wabi - #${state.channelName}` : 'Wabi - Detached Channel';
	}
	return 'Wabi - Detached Panel';
}

export async function openDetachedPanel(state: DetachedPanelState): Promise<void> {
	if (!browser) return;

	const url = makeDetachedUrl(state);
	const title = makeDetachedTitle(state);

	if (isDesktopTauri()) {
		const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
		const label = `detached-${state.kind}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
		const detachedWindow = new WebviewWindow(label, {
			url,
			title,
			width: 1100,
			height: 760,
			minWidth: 420,
			minHeight: 320,
			focus: true,
			center: true
		});

		detachedWindow.once('tauri://error', (error) => {
			console.error('[DetachedPanel] Failed to open detached Tauri window:', error);
		});
		return;
	}

	// Web fallback: open a separate browser window.
	// To match Tauri behavior on web later, wire BroadcastChannel or SharedWorker
	// to sync tab state and lifecycle between windows.
	window.open(
		url,
		`wabi-detached-${Date.now()}`,
		'popup=yes,width=1100,height=760,noopener,noreferrer'
	);
}

export function readDetachedPanelState(url: URL): DetachedPanelState | null {
	const kind = url.searchParams.get('kind');
	if (kind !== 'channel-chat') return null;

	return {
		kind,
		channelId: url.searchParams.get('channelId') || undefined,
		channelName: url.searchParams.get('channelName') || undefined
	};
}
