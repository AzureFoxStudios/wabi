/**
 * The one rule for media in content that stays on the device (privacy/contentEgress.ts): no
 * element may fetch from a host other than this Wabi server until the member clicks a
 * "Load from <host>" gate (RemoteMediaGate.svelte).
 *
 * Remote-ness is decided by parsing the URL (`new URL(value, pageOrigin).origin`), never by a
 * string prefix: "//host/x.gif" is another host. A URL on this server under `/api/` is treated
 * as remote too, because server endpoints such as `/api/image-proxy?url=…` fetch on the
 * caller's behalf and so would learn the outside URL.
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
	return !url.pathname.toLowerCase().startsWith('/api/');
}

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

function linkFor(document: Document, url: string, label: string): HTMLAnchorElement {
	const link = document.createElement('a');
	link.setAttribute('href', url);
	link.setAttribute('target', '_blank');
	link.setAttribute('rel', 'noopener noreferrer nofollow');
	link.textContent = label || url;
	return link;
}

/**
 * Replace every element in already-sanitized HTML that would fetch from another host with a
 * plain link to what it pointed at. Runs on a parsed DOM (an inert <template>, which loads
 * nothing), so the HTML parser's own renaming (`<image>` → `<img>`) and attribute values are
 * already resolved; link labels are set as text, never as markup.
 */
export function neutralizeRemoteMediaHtml(html: string, origins: string[] = wabiOrigins()): string {
	if (typeof document === 'undefined' || !html) return html;
	const template = document.createElement('template');
	template.innerHTML = html;
	const root = template.content;

	for (const container of Array.from(root.querySelectorAll('video, audio, picture'))) {
		if (!container.isConnected && !root.contains(container)) continue;
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

/** Attachment URLs of a message that would be fetched from a host other than this Wabi server. */
export function remoteAttachmentUrls(
	message: { fileUrl?: string; files?: Array<{ fileUrl?: string } | null | undefined> } | null | undefined,
	origins: string[] = wabiOrigins()
): string[] {
	if (!message) return [];
	const urls = [message.fileUrl, ...(message.files ?? []).map((file) => file?.fileUrl)]
		.filter((url): url is string => typeof url === 'string' && url.length > 0);
	return [...new Set(urls)].filter((url) => !isWabiServerMediaUrl(url, origins));
}
