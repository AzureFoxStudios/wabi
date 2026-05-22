export interface QueueItem {
	id: string;
	videoId: string;
	title?: string;
	requestedBy?: string;
}

export interface VoteState {
	id: string;
	yes: string[];
	no: string[];
	threshold: number;
}

export interface WatchRoomState {
	channelId: string;
	currentVideoId?: string;
	positionSec: number;
	isPlaying: boolean;
	playbackRate: number;
	controlMode: 'open' | 'presenter' | 'vote';
	presenterUserId?: string;
	queue: QueueItem[];
	videoRequestStats?: Record<string, { count: number; lastRequestedAt: number; lastRequestedBy?: string }>;
	queueModerated?: boolean;
	pendingQueue?: QueueItem[];
	pendingVote?: VoteState;
	updatedAt: number;
	updatedBy?: string;
}

export type YTPlayerState = -1 | 0 | 1 | 2 | 3 | 5;

export function extractVideoId(input: string): string | null {
	const raw = input.trim();
	if (!raw) return null;
	const idPattern = /^[a-zA-Z0-9_-]{11}$/;
	if (idPattern.test(raw)) return raw;
	try {
		const parsed = new URL(raw);
		if (parsed.hostname.includes('youtu.be')) {
			const shortId = parsed.pathname.replace('/', '').trim();
			return idPattern.test(shortId) ? shortId : null;
		}
		if (parsed.hostname.includes('youtube.com')) {
			const v = parsed.searchParams.get('v') || '';
			if (idPattern.test(v)) return v;
			const parts = parsed.pathname.split('/').filter(Boolean);
			const idx = parts.findIndex((p) => p === 'embed' || p === 'shorts');
			if (idx >= 0 && parts[idx + 1] && idPattern.test(parts[idx + 1])) return parts[idx + 1];
		}
	} catch {
		return null;
	}
	return null;
}

export function thumbFor(videoId: string): string {
	return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function titleFor(
	item: QueueItem | null,
	videoTitles: Record<string, string>
): string {
	if (!item) return 'Unknown video';
	return item.title || videoTitles[item.videoId] || `Video ${item.videoId}`;
}

export function requestCountFor(
	videoId: string | undefined,
	room: WatchRoomState | null
): number {
	if (!videoId) return 0;
	return room?.videoRequestStats?.[videoId]?.count || 0;
}

export function displayId(videoId: string | undefined): string {
	if (!videoId) return '';
	return videoId.length > 8 ? `${videoId.slice(0, 8)}...` : videoId;
}

export function canPresent(
	socket: { id: string } | null,
	room: WatchRoomState | null
): boolean {
	return Boolean(socket && room && (room.controlMode === 'open' || !room.presenterUserId || room.presenterUserId === socket.id));
}

export function canManageQueue(
	socket: { id: string } | null,
	room: WatchRoomState | null
): boolean {
	return Boolean(canPresent(socket, room) && room?.controlMode !== 'vote');
}

export async function ensureYouTubeAPI(): Promise<void> {
	if (typeof window === 'undefined') return;
	const yt = (window as any).YT;
	if (yt?.Player) return;
	await new Promise<void>((resolve) => {
		const existing = document.querySelector<HTMLScriptElement>('script[data-youtube-api="1"]');
		if (!existing) {
			const script = document.createElement('script');
			script.src = 'https://www.youtube.com/iframe_api';
			script.async = true;
			script.setAttribute('data-youtube-api', '1');
			document.head.appendChild(script);
		}
		const prev = (window as any).onYouTubeIframeAPIReady;
		(window as any).onYouTubeIframeAPIReady = () => {
			if (typeof prev === 'function') prev();
			resolve();
		};
		const check = () => {
			if ((window as any).YT?.Player) {
				resolve();
				return true;
			}
			return false;
		};
		if (check()) return;
		const timer = setInterval(() => {
			if (check()) clearInterval(timer);
		}, 50);
	});
}

export function normalizeError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error ?? '');
	if (raw.toLowerCase().includes('abort')) return 'Request timed out';
	return raw || 'Request failed';
}
