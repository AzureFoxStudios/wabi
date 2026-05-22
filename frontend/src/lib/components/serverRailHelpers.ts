import type { SavedServerFolderView, SavedServerView } from '$lib/savedServers';

export type RailDropPosition = 'before' | 'after' | 'inside';

export interface DragState {
	draggedServerUrl: string | null;
	draggedItemId: string | null;
	draggedItemKind: 'server' | 'folder' | null;
	dropTargetId: string | null;
	dropPosition: RailDropPosition;
}

export function clearDragState(): DragState {
	return {
		draggedServerUrl: null,
		draggedItemId: null,
		draggedItemKind: null,
		dropTargetId: null,
		dropPosition: 'before'
	};
}

export function computeDropPosition(
	event: DragEvent,
	itemKind: 'server' | 'folder',
	element: HTMLElement
): RailDropPosition {
	const rect = element.getBoundingClientRect();
	const localY = event.clientY - rect.top;
	if (itemKind === 'folder') {
		return localY >= rect.height / 2 ? 'after' : 'before';
	}
	const innerBand = Math.min(14, rect.height * 0.26);
	if (localY > innerBand && localY < rect.height - innerBand) {
		return 'inside';
	}
	return localY >= rect.height / 2 ? 'after' : 'before';
}

export function avatarText(server: SavedServerView | null): string {
	if (!server?.effectiveName) return 'W';
	return server.effectiveName.charAt(0).toUpperCase();
}

export function canRenderServerImage(url: string | null | undefined, brokenImageUrls: Set<string>): boolean {
	return Boolean(url && !brokenImageUrls.has(url));
}

export function markImageBroken(url: string | null | undefined, brokenImageUrls: Set<string>): Set<string> {
	if (!url || brokenImageUrls.has(url)) return brokenImageUrls;
	const next = new Set(brokenImageUrls);
	next.add(url);
	return next;
}

export function folderPreviewMembers(folder: SavedServerFolderView): SavedServerView[] {
	return folder.members.slice(0, 4);
}

export function formatUnreadBadge(count: number): string {
	if (count <= 0) return '';
	if (count > 99) return '99+';
	return String(count);
}

export function getServerUnreadCount(
	serverUrl: string,
	followUnreadCountsByServer: Record<string, number>
): number {
	return followUnreadCountsByServer[serverUrl] || 0;
}

export function getFolderUnreadCount(
	folder: SavedServerFolderView,
	followUnreadCountsByServer: Record<string, number>
): number {
	return folder.members.reduce((sum, server) => sum + getServerUnreadCount(server.url, followUnreadCountsByServer), 0);
}

export function shouldSuppressTap(suppressTapUntil: number, mobile: boolean): boolean {
	return mobile && Date.now() < suppressTapUntil;
}

export function beginManageGesture(): number {
	return Date.now() + 700;
}
