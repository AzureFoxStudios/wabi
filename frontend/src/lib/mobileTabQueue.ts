import { derived, get, writable } from 'svelte/store';

export interface AddonTabSpec {
	id: string;
	label: string;
	shortLabel?: string;
	onSelect?: () => void;
	badgeCount?: number;
}

export type MobileQueueTab =
	| { id: string; type: 'channel'; channelId: string }
	| { id: string; type: 'addon'; addonId: string };

const channelQueue = writable<string[]>([]);
const addonTabs = writable<AddonTabSpec[]>([]);
const openAddonQueue = writable<string[]>([]);
const activeTabId = writable<string | null>(null);

function toChannelTabId(channelId: string): string {
	return `channel:${channelId}`;
}

function toAddonTabId(addonId: string): string {
	return `addon:${addonId}`;
}

function ensureInQueue(items: string[], value: string): string[] {
	if (items.includes(value)) return items;
	return [...items, value];
}

function enqueueChannel(channelId: string): void {
	if (!channelId) return;
	channelQueue.update((queue) => ensureInQueue(queue, channelId));
}

function setActiveChannel(channelId: string): void {
	if (!channelId) return;
	enqueueChannel(channelId);
	activeTabId.set(toChannelTabId(channelId));
}

function pruneChannels(validChannelIds: string[]): void {
	const allowed = new Set(validChannelIds);
	channelQueue.update((queue) => queue.filter((id) => allowed.has(id)));

	const currentActive = get(activeTabId);
	if (currentActive?.startsWith('channel:')) {
		const activeChannelId = currentActive.slice('channel:'.length);
		if (!allowed.has(activeChannelId)) {
			const fallback = get(channelQueue)[0];
			activeTabId.set(fallback ? toChannelTabId(fallback) : null);
		}
	}
}

function registerAddonTab(spec: AddonTabSpec): void {
	if (!spec?.id || !spec.label) return;
	addonTabs.update((tabs) => {
		const filtered = tabs.filter((tab) => tab.id !== spec.id);
		return [...filtered, spec];
	});
	openAddonQueue.update((queue) => ensureInQueue(queue, spec.id));
}

function unregisterAddonTab(addonId: string): void {
	addonTabs.update((tabs) => tabs.filter((tab) => tab.id !== addonId));
	openAddonQueue.update((queue) => queue.filter((id) => id !== addonId));
	const currentActive = get(activeTabId);
	if (currentActive === toAddonTabId(addonId)) {
		const fallback = get(channelQueue)[0];
		activeTabId.set(fallback ? toChannelTabId(fallback) : null);
	}
}

function setActiveTab(tabId: string): void {
	if (!tabId) return;
	activeTabId.set(tabId);
	if (tabId.startsWith('channel:')) {
		const channelId = tabId.slice('channel:'.length);
		enqueueChannel(channelId);
		return;
	}
	if (tabId.startsWith('addon:')) {
		const addonId = tabId.slice('addon:'.length);
		openAddonQueue.update((queue) => ensureInQueue(queue, addonId));
	}
}

function closeAddonTab(addonId: string): void {
	if (!addonId) return;
	openAddonQueue.update((queue) => queue.filter((id) => id !== addonId));
	const currentActive = get(activeTabId);
	if (currentActive === toAddonTabId(addonId)) {
		const fallbackChannel = get(channelQueue)[0];
		if (fallbackChannel) {
			activeTabId.set(toChannelTabId(fallbackChannel));
			return;
		}
		const fallbackAddon = get(openAddonQueue)[0];
		activeTabId.set(fallbackAddon ? toAddonTabId(fallbackAddon) : null);
	}
}

function openAddonTab(addonId: string): void {
	if (!addonId) return;
	openAddonQueue.update((queue) => ensureInQueue(queue, addonId));
	activeTabId.set(toAddonTabId(addonId));
}

function closeChannelTab(channelId: string): void {
	if (!channelId) return;
	channelQueue.update((queue) => {
		const next = queue.filter((id) => id !== channelId);
		const currentActive = get(activeTabId);
		if (currentActive === toChannelTabId(channelId)) {
			activeTabId.set(next[0] ? toChannelTabId(next[0]) : null);
		}
		return next;
	});
}

function reorderChannelTab(
	sourceChannelId: string,
	targetChannelId: string,
	position: 'before' | 'after' = 'before'
): void {
	if (!sourceChannelId || !targetChannelId || sourceChannelId === targetChannelId) return;
	channelQueue.update((queue) => {
		const sourceIndex = queue.indexOf(sourceChannelId);
		const targetIndex = queue.indexOf(targetChannelId);
		if (sourceIndex === -1 || targetIndex === -1) return queue;
		const next = [...queue];
		next.splice(sourceIndex, 1);
		const adjustedTargetIndex = next.indexOf(targetChannelId);
		const insertIndex = position === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex;
		next.splice(insertIndex, 0, sourceChannelId);
		return next;
	});
}

const tabs = derived([channelQueue, addonTabs, openAddonQueue], ([$channelQueue, $addonTabs, $openAddonQueue]): MobileQueueTab[] => {
	const channelTabItems = $channelQueue.map((channelId) => ({
		id: toChannelTabId(channelId),
		type: 'channel' as const,
		channelId
	}));
	const addonTabItems = $addonTabs
		.filter((tab) => $openAddonQueue.includes(tab.id))
		.map((tab) => ({
		id: toAddonTabId(tab.id),
		type: 'addon' as const,
		addonId: tab.id
		}));
	return [...channelTabItems, ...addonTabItems];
});

export const mobileTabQueue = {
	channelQueue,
	addonTabs,
	tabs,
	activeTabId,
	setActiveTab,
	setActiveChannel,
	enqueueChannel,
	closeChannelTab,
	openAddonTab,
	closeAddonTab,
	reorderChannelTab,
	pruneChannels,
	registerAddonTab,
	unregisterAddonTab,
	toChannelTabId,
	toAddonTabId
};
