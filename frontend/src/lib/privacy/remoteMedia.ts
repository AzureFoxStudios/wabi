/**
 * The rules for media in content that stays on the device (privacy/contentEgress.ts).
 *
 * 1. Locality is decided by parsing the URL (`new URL(...)`), never by a string prefix or by
 *    concatenating strings: "//host/x.gif" is another host, and a path is never glued onto the
 *    server URL as text. A URL on this server under `/api/` (after percent-decoding and path
 *    normalisation) counts as remote, because server endpoints such as `/api/image-proxy?url=…`
 *    fetch on the caller's behalf.
 * 2. Attachments: `resolveAttachmentUrl` is the ONE function that turns a message's `fileUrl`
 *    into the URL an element renders, and the gate decides on exactly that URL.
 * 3. Audio and video in kept content are never played from an http(s) URL, same-origin
 *    included: a media file on this server can still be an HLS playlist that the browser follows
 *    to other hosts (Chromium sniffs and plays HLS from the bytes). Same-origin images stay
 *    allowed; an image cannot pull in other hosts. A decrypted blob: playlist is followed too
 *    (scripts/kept-content-browser-smoke.mjs records it), so today no decrypted audio/video is
 *    played inline at all (decrypted attachments are images via E2eeImage, or downloads); an
 *    inline player for decrypted media must first refuse bodies that start with #EXTM3U.
 */
import { getServerUrl } from '$lib/serverUrl';

/** The origins that count as "this Wabi server": the page, and the server it talks to. */
export function wabiOrigins(): string[] {
	const origins: string[] = [];
	try {
		if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') origins.push(location.origin);
	} catch {
		// No page origin (tests, SSR).
	}
	try {
		const server = getServerUrl();
		if (server) origins.push(new URL(server).origin);
	} catch {
		// No configured server yet.
	}
	return origins;
}

/**
 * Percent-decode (repeatedly) and normalise a path the way a decoding, `;param`-stripping front
 * proxy might route it: backslashes are slashes, each segment loses its `;…` part, and empty,
 * `.` and `;`-only segments are dropped before `..` is applied.
 */
function normalisedPath(pathname: string): string {
	let path = pathname;
	for (let i = 0; i < 4; i += 1) {
		let decoded = path;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			break;
		}
		if (decoded === path) break;
		path = decoded;
	}
	const segments: string[] = [];
	for (const raw of path.replace(/\\/g, '/').split('/')) {
		// A front proxy that strips `;params` would route "/api;x/…" and "/;/api/…" to /api/.
		const segment = raw.split(';')[0];
		if (!segment || segment === '.') continue;
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join('/')}`.toLowerCase();
}

/** True when `url` is a server endpoint (under /api/) rather than a stored file. */
function isServerEndpoint(url: URL): boolean {
	const path = normalisedPath(url.pathname);
	return path === '/api' || path.startsWith('/api/');
}

/** True when loading `value` contacts only this Wabi server (or nothing, for data:/blob:). */
export function isWabiServerMediaUrl(value: string | null | undefined, origins: string[] = wabiOrigins()): boolean {
	const raw = String(value ?? '').trim();
	if (!raw) return true;
	let url: URL;
	try {
		url = new URL(raw, origins[0] ?? 'https://wabi.invalid');
	} catch {
		return false;
	}
	if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	if (!origins.includes(url.origin)) return false;
	return !isServerEndpoint(url);
}

/** The outside URL a server proxy endpoint would fetch (`/api/…?url=…`), if any. */
export function proxiedTarget(value: string, origins: string[] = wabiOrigins()): string | null {
	try {
		const url = new URL(value, origins[0] ?? 'https://wabi.invalid');
		if (!origins.includes(url.origin) || !isServerEndpoint(url)) return null;
		const target = url.searchParams.get('url');
		return target && /^https?:\/\//i.test(target) ? target : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------- attachments

export type ResolvedAttachmentUrl = {
	/** What every element renders: an absolute URL, or '' when the value is unusable. */
	url: string;
	/** Loading `url` contacts only this Wabi server (or nothing). The gate decides on this. */
	local: boolean;
	/** `url` is a data:/blob: URL (decrypted or inline bytes, no network). */
	inline: boolean;
};

/** What the URL parser itself ignores: C0 controls and spaces at the ends, tab/LF/CR anywhere. */
function urlParserInput(value: string): string {
	return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');
}

/**
 * The one function that turns a message's `fileUrl` (sender-controlled for decrypted messages)
 * into the URL that is rendered and gated.
 * - data:/blob: stay as they are (inline: no network).
 * - Absolute http(s) URLs are parsed; the old localhost `/uploads/` rewrite is kept.
 * - Anything else is a path on the server: leading slashes and backslashes are dropped and it is
 *   resolved with `new URL()` against the server's base, so "relative" input can never change the
 *   host (".evil.test/x", "@evil.test/x", ":8443/x", "\\\\evil.test/x" all stay on the server).
 *   The result must still have the server's origin.
 * - Other schemes (javascript:, file:, …) give ''.
 */
export function resolveAttachmentUrl(
	fileUrl: string | null | undefined,
	options: { serverUrl?: string; origins?: string[] } = {}
): ResolvedAttachmentUrl {
	const raw = urlParserInput(String(fileUrl ?? ''));
	if (!raw) return { url: '', local: true, inline: false };
	const origins = options.origins ?? wabiOrigins();
	let serverBase: URL;
	try {
		const server = options.serverUrl ?? getServerUrl();
		serverBase = new URL(server.endsWith('/') ? server : `${server}/`);
	} catch {
		return { url: '', local: true, inline: false };
	}
	const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
	if (scheme === 'data' || scheme === 'blob') return { url: raw, local: true, inline: true };
	if (scheme === 'http' || scheme === 'https') {
		let absolute: URL;
		try {
			absolute = new URL(raw);
		} catch {
			return { url: '', local: true, inline: false };
		}
		const isLocalUpload =
			(absolute.hostname === 'localhost' || absolute.hostname === '127.0.0.1') && absolute.pathname.startsWith('/uploads/');
		if (isLocalUpload) return onServer(`${absolute.pathname}${absolute.search}${absolute.hash}`, serverBase, origins);
		return { url: absolute.href, local: isWabiServerMediaUrl(absolute.href, origins), inline: false };
	}
	if (scheme) return { url: '', local: true, inline: false };
	return onServer(raw, serverBase, origins);
}

function onServer(path: string, serverBase: URL, origins: string[]): ResolvedAttachmentUrl {
	let resolved: URL;
	try {
		resolved = new URL(path.replace(/^[\\/]+/, ''), serverBase);
	} catch {
		return { url: '', local: true, inline: false };
	}
	if (resolved.origin !== serverBase.origin) return { url: '', local: true, inline: false };
	const withServer = origins.includes(serverBase.origin) ? origins : [...origins, serverBase.origin];
	return { url: resolved.href, local: isWabiServerMediaUrl(resolved.href, withServer), inline: false };
}

/** Attachment URLs of a message, as rendered, that would be fetched from another host. */
export function remoteAttachmentUrls(
	message: { fileUrl?: string; files?: Array<{ fileUrl?: string } | null | undefined> } | null | undefined,
	options: { serverUrl?: string; origins?: string[] } = {}
): string[] {
	if (!message) return [];
	const values = [message.fileUrl, ...(message.files ?? []).map((file) => file?.fileUrl)]
		.filter((value): value is string => typeof value === 'string' && value.length > 0);
	const remote = values.map((value) => resolveAttachmentUrl(value, options)).filter((resolved) => resolved.url && !resolved.local);
	return [...new Set(remote.map((resolved) => resolved.url))];
}

// ---------------------------------------------------------------------------- rendered HTML

/** Every URL in a srcset value. */
function srcsetUrls(value: string): string[] {
	return value
		.split(',')
		.map((candidate) => candidate.trim().split(/\s+/)[0])
		.filter(Boolean);
}

/** Attributes through which an element can make the browser fetch something on its own. */
const FETCH_ATTRIBUTES = ['src', 'srcset', 'poster', 'data', 'background', 'xlink:href', 'lowsrc', 'dynsrc'];
/** Elements that fetch through `href` (an <a href> only fetches when clicked). */
const HREF_FETCHING = new Set(['image', 'use', 'feimage', 'link']);
/** Media containers replaced whole when any part of them is remote. */
const MEDIA_CONTAINERS = new Set(['video', 'audio', 'picture']);
/** Audio/video elements: in kept content none is ever left in place, whatever its origin. */
const AV_ELEMENTS = 'video, audio, source, track';

function remoteUrlsOf(element: Element, origins: string[]): string[] {
	const found: string[] = [];
	for (const name of FETCH_ATTRIBUTES) {
		const value = element.getAttribute(name);
		if (value == null) continue;
		const urls = name === 'srcset' ? srcsetUrls(value) : [value];
		for (const url of urls) if (!isWabiServerMediaUrl(url, origins)) found.push(url);
	}
	if (HREF_FETCHING.has(element.localName.toLowerCase())) {
		const href = element.getAttribute('href');
		if (href != null && !isWabiServerMediaUrl(href, origins)) found.push(href);
	}
	return found;
}

function firstMediaUrl(element: Element): string {
	for (const candidate of [element, ...Array.from(element.querySelectorAll('*'))]) {
		for (const name of ['src', 'srcset', 'poster']) {
			const value = candidate.getAttribute(name);
			if (value) return name === 'srcset' ? srcsetUrls(value)[0] ?? '' : value;
		}
	}
	return '';
}

function linkFor(document: Document, url: string, label: string): HTMLAnchorElement | Text {
	if (!url) return document.createTextNode(label);
	const link = document.createElement('a');
	link.setAttribute('href', url);
	link.setAttribute('target', '_blank');
	link.setAttribute('rel', 'noopener noreferrer nofollow');
	link.textContent = label || url;
	return link;
}

export type NeutralizeOptions = {
	origins?: string[];
	/**
	 * Replace every audio/video element with a link, same-origin included (rule 3). The chat
	 * sanitizer never keeps audio/video; the Reader's does.
	 */
	noAudioVideo?: boolean;
};

/**
 * Replace every element in already-sanitized HTML that would fetch from another host with a
 * plain link to what it pointed at. Runs on a parsed DOM (an inert <template>, which loads
 * nothing), so the HTML parser's own renaming (`<image>` → `<img>`) and attribute values are
 * already resolved; link labels are set as text, never as markup. Nested <template> elements are
 * removed (their content is inert now, but nothing here inspects it).
 */
export function neutralizeRemoteMediaHtml(html: string, options: NeutralizeOptions | string[] = {}): string {
	if (typeof document === 'undefined' || !html) return html;
	const opts: NeutralizeOptions = Array.isArray(options) ? { origins: options } : options;
	const origins = opts.origins ?? wabiOrigins();
	const template = document.createElement('template');
	template.innerHTML = html;
	const root = template.content;

	for (const nested of Array.from(root.querySelectorAll('template'))) nested.remove();

	if (opts.noAudioVideo) {
		for (const element of Array.from(root.querySelectorAll(AV_ELEMENTS))) {
			if (!root.contains(element)) continue;
			const url = firstMediaUrl(element);
			const kind = element.localName === 'audio' ? 'audio' : 'video';
			element.replaceWith(linkFor(document, url, url ? `${url} (${kind}, not played here)` : ''));
		}
	}
	for (const container of Array.from(root.querySelectorAll('video, audio, picture'))) {
		if (!root.contains(container)) continue;
		const remote = [container, ...Array.from(container.querySelectorAll('*'))].flatMap((element) => remoteUrlsOf(element, origins));
		if (!remote.length) continue;
		const kind = container.localName === 'picture' ? 'image' : container.localName;
		container.replaceWith(linkFor(document, remote[0], `${remote[0]} (${kind})`));
	}
	for (const element of Array.from(root.querySelectorAll('*'))) {
		if (!root.contains(element)) continue;
		if (MEDIA_CONTAINERS.has(element.localName)) continue;
		const remote = remoteUrlsOf(element, origins);
		if (!remote.length) continue;
		const alt = (element.getAttribute('alt') || element.getAttribute('title') || '').trim();
		element.replaceWith(linkFor(document, remote[0], alt ? `${alt} (image)` : remote[0]));
	}
	return template.innerHTML;
}
