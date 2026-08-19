/**
 * Deep-link targets from push notifications / notification clicks.
 */
import { browser } from '$app/environment';
import { layoutStore } from '$lib/layoutStore';
import { currentChannel, joinChannel } from '$lib/socket';

export type WabiNavTarget =
	| { kind: 'channel'; channelId: string; messageId?: string }
	| { kind: 'dm'; channelId: string }
	| { kind: 'call'; callId: string }
	| { kind: 'settings'; section?: string }
	| { kind: 'messages' };

export function parseWabiNavFromSearch(search: string): WabiNavTarget | null {
	const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
	const kind = q.get('wabiNav');
	if (!kind) return null;
	if (kind === 'channel') {
		const channelId = q.get('channelId') || q.get('id');
		if (!channelId) return null;
		return { kind: 'channel', channelId, messageId: q.get('messageId') || undefined };
	}
	if (kind === 'dm') {
		const channelId = q.get('channelId') || q.get('id');
		if (!channelId) return null;
		return { kind: 'dm', channelId };
	}
	if (kind === 'call') {
		const callId = q.get('callId') || q.get('id');
		if (!callId) return null;
		return { kind: 'call', callId };
	}
	if (kind === 'settings') return { kind: 'settings', section: q.get('section') || undefined };
	if (kind === 'messages') return { kind: 'messages' };
	return null;
}

export function parseWabiNavFromData(data: Record<string, unknown> | null | undefined): WabiNavTarget | null {
	if (!data || typeof data !== 'object') return null;
	const kind = typeof data.wabiNav === 'string' ? data.wabiNav : typeof data.kind === 'string' ? data.kind : null;
	if (!kind) return null;
	const channelId =
		typeof data.channelId === 'string' ? data.channelId : typeof data.id === 'string' ? data.id : null;
	if (kind === 'channel' && channelId) {
		return {
			kind: 'channel',
			channelId,
			messageId: typeof data.messageId === 'string' ? data.messageId : undefined
		};
	}
	if (kind === 'dm' && channelId) return { kind: 'dm', channelId };
	if (kind === 'call') {
		const callId = typeof data.callId === 'string' ? data.callId : channelId;
		if (!callId) return null;
		return { kind: 'call', callId };
	}
	if (kind === 'settings') {
		return { kind: 'settings', section: typeof data.section === 'string' ? data.section : undefined };
	}
	if (kind === 'messages') return { kind: 'messages' };
	return null;
}

export function applyWabiNavTarget(target: WabiNavTarget): void {
	if (!browser) return;
	if (target.kind === 'channel') {
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		layoutStore.closeDM();
		currentChannel.set(target.channelId);
		void joinChannel(target.channelId);
		window.dispatchEvent(
			new CustomEvent('wabi:navigate', {
				detail: { view: 'chat', channelId: target.channelId, messageId: target.messageId }
			})
		);
		return;
	}
	if (target.kind === 'dm') {
		layoutStore.showMobileChannels.set(false);
		layoutStore.closeRightPanel();
		void joinChannel(target.channelId);
		layoutStore.openCenterDm(target.channelId, null);
		window.dispatchEvent(
			new CustomEvent('wabi:navigate', { detail: { view: 'dm', channelId: target.channelId } })
		);
		return;
	}
	if (target.kind === 'messages') {
		window.dispatchEvent(new CustomEvent('wabi:navigate', { detail: { view: 'dm' } }));
		return;
	}
	if (target.kind === 'settings') {
		window.dispatchEvent(
			new CustomEvent('wabi:navigate', { detail: { view: 'settings', section: target.section } })
		);
		return;
	}
	if (target.kind === 'call') {
		window.dispatchEvent(
			new CustomEvent('wabi:navigate', { detail: { view: 'call', callId: target.callId } })
		);
	}
}

export function consumeWabiNavFromLocation(): WabiNavTarget | null {
	if (!browser) return null;
	const target = parseWabiNavFromSearch(window.location.search);
	if (!target) return null;
	try {
		const url = new URL(window.location.href);
		['wabiNav', 'channelId', 'messageId', 'callId', 'id', 'section'].forEach((k) =>
			url.searchParams.delete(k)
		);
		window.history.replaceState({}, '', url.pathname + url.search + url.hash);
	} catch {
		/* ignore */
	}
	return target;
}

export function listenForServiceWorkerNavigation(handler: (target: WabiNavTarget) => void): () => void {
	if (!browser || !('serviceWorker' in navigator)) return () => {};
	const onMessage = (event: MessageEvent) => {
		const data = event.data;
		if (!data || data.type !== 'wabi-navigate') return;
		const target = parseWabiNavFromData(data.payload || data);
		if (target) handler(target);
	};
	navigator.serviceWorker.addEventListener('message', onMessage);
	return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}
