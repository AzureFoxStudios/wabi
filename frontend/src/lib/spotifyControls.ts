const SPOTIFY_ENTITY_TYPES = new Set([
	'track',
	'album',
	'playlist',
	'artist',
	'episode',
	'show'
]);

export type SpotifyEntityType =
	| 'track'
	| 'album'
	| 'playlist'
	| 'artist'
	| 'episode'
	| 'show';

export interface SpotifyEntityRef {
	type: SpotifyEntityType;
	id: string;
}

function normalizeSpotifyPath(pathname: string): string[] {
	const segments = pathname
		.split('/')
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments[0] === 'embed') {
		segments.shift();
	}
	if (segments[0]?.startsWith('intl-')) {
		segments.shift();
	}
	return segments;
}

export function parseSpotifyEntity(url: string): SpotifyEntityRef | null {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		if (hostname !== 'open.spotify.com' && hostname !== 'play.spotify.com') return null;
		const segments = normalizeSpotifyPath(parsed.pathname);
		if (segments.length < 2) return null;
		const type = segments[0].toLowerCase();
		const id = segments[1];
		if (!SPOTIFY_ENTITY_TYPES.has(type)) return null;
		if (!/^[A-Za-z0-9]+$/.test(id)) return null;
		return {
			type: type as SpotifyEntityType,
			id
		};
	} catch {
		return null;
	}
}

export function isSpotifyUrl(url: string): boolean {
	return Boolean(parseSpotifyEntity(url));
}

export function buildSpotifyEmbedUrl(url: string): string | null {
	const parsed = parseSpotifyEntity(url);
	if (!parsed) return null;
	return `https://open.spotify.com/embed/${parsed.type}/${parsed.id}`;
}

export function buildSpotifyOpenUrl(url: string): string | null {
	const parsed = parseSpotifyEntity(url);
	if (!parsed) return null;
	return `https://open.spotify.com/${parsed.type}/${parsed.id}`;
}
