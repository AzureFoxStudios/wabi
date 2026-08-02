import { browser } from '$app/environment';
import { isDesktopTauri } from '$lib/tauri-platform';
import { brandName } from '$lib/branding';

export type DetachedPanelKind = 'channel-chat' | 'server-map' | 'workspace-panel';

export interface DetachedPanelState {
	kind: DetachedPanelKind;
	channelId?: string;
	channelName?: string;
	placeId?: string;
	panelId?: string; // for workspace-panel kind
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

	if (state.placeId) {
		url.searchParams.set('placeId', state.placeId);
	}

	if (state.panelId) {
		url.searchParams.set('panelId', state.panelId);
	}

	return url.toString();
}

function makeDetachedTitle(state: DetachedPanelState): string {
	if (state.kind === 'channel-chat') {
		return state.channelName ? `${brandName} - #${state.channelName}` : `${brandName} - Detached Channel`;
	}
	if (state.kind === 'server-map') {
		return `${brandName} - Map`;
	}
	if (state.kind === 'workspace-panel') {
		return state.panelId ? `${brandName} - ${state.panelId}` : `${brandName} - Detached Panel`;
	}
	return `${brandName} - Detached Panel`;
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
	if (kind !== 'channel-chat' && kind !== 'server-map' && kind !== 'workspace-panel') return null;

	return {
		kind,
		channelId: url.searchParams.get('channelId') || undefined,
		channelName: url.searchParams.get('channelName') || undefined,
		placeId: url.searchParams.get('placeId') || undefined,
		panelId: url.searchParams.get('panelId') || undefined
	};
}

export function listenForDetachedWindowClose(callback: (panelId: string) => void): () => void {
	if (!browser) return () => {};

	// Tauri: listen for detached-window-closed event from child windows
	if (isDesktopTauri()) {
		let unlisten: (() => void) | null = null;
		import('@tauri-apps/api/event').then(({ listen }) => {
			listen('detached-window-closed', (event) => {
				const payload = event.payload as { panelId?: string };
				if (payload?.panelId) {
					callback(payload.panelId);
				}
			}).then((fn) => {
				unlisten = fn;
			});
		}).catch((err) => {
			console.warn('[DetachedPanel] Failed to listen for window close events:', err);
		});
		return () => {
			if (unlisten) unlisten();
		};
	}

	// Web: BroadcastChannel handles cross-tab state sync; nothing extra needed here
	return () => {};
}
