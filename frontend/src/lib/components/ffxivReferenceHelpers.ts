export type LookupKind = 'item' | 'job' | 'action' | 'quest' | 'status' | 'zone' | 'map' | 'market' | 'profile';

export interface LookupCard {
	id: string;
	kind: LookupKind;
	title: string;
	subtitle?: string;
	detail?: string;
	iconUrl?: string;
	link?: string;
	source: 'xivapi' | 'universalis' | 'fallback';
	pinKey?: string;
}

export interface RaidNote {
	id: string;
	title: string;
	body: string;
	phase?: string;
	createdAt: number;
	createdBy?: string;
}

export interface WipeLogEntry {
	id: string;
	encounter: string;
	phase?: string;
	reason: string;
	createdAt: number;
	createdBy?: string;
}

export interface PrepBoardTemplate {
	id: string;
	name: string;
	description?: string;
	notes: RaidNote[];
	createdAt: number;
	createdBy?: string;
}

export interface FfxivChannelState {
	channelId: string;
	pinnedCards: LookupCard[];
	raidNotes: RaidNote[];
	wipeLogs: WipeLogEntry[];
	templates: PrepBoardTemplate[];
	updatedAt: number;
}

export const lookupKinds: Array<{ id: LookupKind; label: string }> = [
	{ id: 'item', label: 'Item' },
	{ id: 'job', label: 'Job' },
	{ id: 'action', label: 'Action' },
	{ id: 'quest', label: 'Quest' },
	{ id: 'status', label: 'Status' },
	{ id: 'zone', label: 'Zone' },
	{ id: 'map', label: 'Map' },
	{ id: 'market', label: 'Market' },
	{ id: 'profile', label: 'Profile' }
];

export function formatTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	}).format(timestamp);
}

export function buildHeaders(token: string | null): HeadersInit {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchJson(
	serverUrl: string,
	path: string,
	token: string | null,
	init: RequestInit = {}
): Promise<{ data: any | null; error: string | null }> {
	try {
		const response = await fetch(`${serverUrl}${path}`, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				...(init.headers || {}),
				...buildHeaders(token)
			}
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			return {
				data: null,
				error: typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status})`
			};
		}
		return { data: payload, error: null };
	} catch (error) {
		return { data: null, error: error instanceof Error ? error.message : 'Request failed' };
	}
}
