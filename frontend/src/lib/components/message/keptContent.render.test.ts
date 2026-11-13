/**
 * The real message components, server-rendered (svelte/server) with a kept message or room, so
 * a change to how they are wired fails here: nothing in the markup may fetch from another host
 * until a "Load from <host>" click, no server link preview mounts, and server-readable album
 * actions are not offered. Each component derives "kept" itself from the message and the room
 * (dmE2eeState.roomContentKeepReason), so there is no parent prop to switch off.
 *
 * parseMessage needs a DOM (DOMPurify), so it is replaced by a recorder here; the real renderer
 * runs in Chromium in scripts/kept-content-browser-smoke.mjs.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { registerSvelteServerPlugin } from '../../../../test/svelteServerPlugin';

registerSvelteServerPlugin();

const parseCalls: Array<{ text: string; options: Record<string, unknown> }> = [];
mock.module('$lib/markdown', () => ({
	parseMessage: (text: string, _entities: unknown[] = [], options: Record<string, unknown> = {}) => {
		parseCalls.push({ text, options });
		return `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
	}
}));
mock.module('$lib/addonInventory', () => ({ hasAddonCapability: async () => false }));

(await import('$lib/i18n')).initI18n();
const { render } = await import('svelte/server');
const { default: MessageContent } = await import('./MessageContent.svelte');
const { default: LinkPreviewMarker } = await import('../../../../test/fixtures/LinkPreviewMarker.svelte');

const noop = () => {};
const DM = { id: 'dm-1', type: 'dm', name: 'iris' };
const TEXT = { id: 'general', type: 'text', name: 'general' };

function renderMessage(message: Record<string, unknown>, channel: { id: string; type: string; name: string }, settings: Record<string, unknown> = {}): string {
	const full = { id: 'm-1', user: 'iris', userId: 'user-2', timestamp: 1, type: 'text', text: '', ...message };
	return render(MessageContent as any, {
		props: {
			message: full,
			messageText: String(full.text ?? ''),
			albumAnnouncementUploadName: null,
			translatedText: undefined,
			translationLoading: false,
			gifCaptionStyleClass: '',
			displayEnhancementSettingsStore: settings,
			currentChannel: channel.id,
			channels: [channel],
			onOpenMapPanel: noop, onOpenFullMapTab: noop, onOpenPreferredMapSurface: noop, onOpenDirectionsExternal: noop,
			onHandleAlbumActivate: noop, onTriggerAlbumUpload: noop, onOpenAlbumPanel: noop, onOpenAlbumPreview: noop,
			onEnlargeImage: noop, onEnlargeVideo: noop, onImageContextMenu: noop, onDownloadAttachment: noop,
			onOpenBlendImportSettings: noop, onOpenModelInDedicatedTab: noop, onHandleMarkdownContentClick: noop,
			LinkPreviewComponent: LinkPreviewMarker, ensureLinkPreviewLoaded: noop, onHandleAlbumAnnouncementKeydown: noop
		}
	}).body;
}

const encrypted = { encrypted: true, e2ee: true, e2eeVerified: true };
const remoteSrc = (html: string, host: string) => new RegExp(`\\s(src|poster|srcset)="(https?:)?//${host.replace(/\./g, '\\.')}`).test(html);

beforeEach(() => {
	parseCalls.length = 0;
});

describe('a kept text message', () => {
	const text = 'see https://example.org/a and https://cdn.example.net/photo.png and https://open.spotify.com/track/abc';

	test('in a DM whose status is still unknown: no preview, no remote media, images-as-links rendering', () => {
		const html = renderMessage({ text }, DM, { spotifyControlsEnabled: true });
		expect(html).not.toContain('data-link-preview');
		expect(remoteSrc(html, 'cdn.example.net')).toBe(false);
		expect(html).not.toContain('<iframe');
		expect(html).toContain('Load from cdn.example.net');
		expect(html).toContain('Load from open.spotify.com');
		expect(html).toContain('No link previews here');
		expect(parseCalls.every((call) => call.options.remoteImages === false)).toBe(true);
		expect(parseCalls.length).toBeGreaterThan(0);
	});

	test('an encrypted message is kept by its own flag even in a shared channel', () => {
		const html = renderMessage({ text, ...encrypted }, TEXT);
		expect(html).not.toContain('data-link-preview');
		expect(remoteSrc(html, 'cdn.example.net')).toBe(false);
		expect(parseCalls.every((call) => call.options.remoteImages === false)).toBe(true);
	});

	test('the same message in a shared channel previews and embeds as before', () => {
		const html = renderMessage({ text }, TEXT, { spotifyControlsEnabled: true });
		expect(html).toContain('data-link-preview="https://example.org/a"');
		expect(remoteSrc(html, 'cdn.example.net')).toBe(true);
		expect(html).toContain('<iframe');
		expect(html).not.toContain('Load from');
		expect(parseCalls.every((call) => call.options.remoteImages === true)).toBe(true);
	});
});

describe('kept media of every message type', () => {
	test('a protocol-relative GIF waits for a click', () => {
		const html = renderMessage({ type: 'gif', gifUrl: '//t.example.net/x.gif', text: '', ...encrypted }, DM);
		expect(remoteSrc(html, 't.example.net')).toBe(false);
		expect(html).toContain('Load from t.example.net');
		expect(remoteSrc(renderMessage({ type: 'gif', gifUrl: '//t.example.net/x.gif', text: '' }, TEXT), 't.example.net')).toBe(true);
	});

	test('a sender-chosen emoji image waits for a click', () => {
		const html = renderMessage({ type: 'emoji', emojiUrl: 'https://t.example.net/e.png', emojiName: 'e', ...encrypted }, DM);
		expect(remoteSrc(html, 't.example.net')).toBe(false);
		expect(html).toContain('Load from t.example.net');
	});

	test('a file attachment on another host waits for a click', () => {
		const html = renderMessage({
			type: 'file', text: 'Shared: a.png', fileUrl: 'https://t.example.net/a.png', fileName: 'a.png', fileSize: 3, ...encrypted
		}, DM);
		expect(remoteSrc(html, 't.example.net')).toBe(false);
		expect(html).toContain('Load from t.example.net');
		const readable = renderMessage({ type: 'file', text: 'Shared: a.png', fileUrl: 'https://t.example.net/a.png', fileName: 'a.png', fileSize: 3 }, TEXT);
		expect(remoteSrc(readable, 't.example.net')).toBe(true);
	});

	test('an object card thumbnail from the message is not loaded', () => {
		const entities = [{ kind: 'wiki_page', targetId: 'p1', label: 'Plan', previewTitle: 'Plan', previewThumbUrl: 'https://t.example.net/thumb.png', start: 0, end: 4 }];
		expect(remoteSrc(renderMessage({ text: 'Plan', entities, ...encrypted }, DM), 't.example.net')).toBe(false);
		expect(remoteSrc(renderMessage({ text: 'Plan', entities }, TEXT), 't.example.net')).toBe(true);
	});
});

describe('album announcements', () => {
	test('a kept album post with files offers no server-readable album action', () => {
		const files = [
			{ fileUrl: '/uploads/a.png', fileName: 'a.png', fileSize: 1 },
			{ fileUrl: '/uploads/b.png', fileName: 'b.png', fileSize: 1 }
		];
		const message = { type: 'file', text: 'Shared 2 photos in album "Trip"', files };
		const kept = renderMessage({ ...message, ...encrypted }, DM);
		expect(kept).toContain('Albums are server-readable');
		expect(kept).not.toContain('Add Media');
		expect(renderMessage(message, TEXT)).toContain('Add Media');
	});

	test('a kept announcement offers no server-readable album action', () => {
		const html = renderMessage({ text: 'Opened album "Trip"', ...encrypted }, DM);
		expect(html).toContain('Albums are server-readable');
		expect(html).not.toContain('Add Media');
		expect(html).not.toContain('role="button"');
		const readable = renderMessage({ text: 'Opened album "Trip"' }, TEXT);
		expect(readable).toContain('Add Media');
	});
});

describe('Albums tab', () => {
	let tabRequests: string[] = [];
	let albumListCalls: string[] = [];
	beforeAll(async () => {
		const realAuth = await import('$lib/authSession');
		mock.module('$lib/authSession', () => ({ ...realAuth, getAuthToken: () => 'x.eyJzdWIiOjEyfQ.y' }));
		const realAlbums = await import('../../api/albums');
		mock.module('../../api/albums', () => ({
			...realAlbums,
			listMediaAlbums: async (_token: string, _scopeType: string, scopeId: string) => {
				albumListCalls.push(scopeId);
				return [];
			}
		}));
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			tabRequests.push(String(input));
			return new Response(JSON.stringify({ albums: [] }));
		}) as typeof fetch;
	});

	async function renderTab(channel: { id: string; type: string; name: string }): Promise<string> {
		tabRequests = [];
		albumListCalls = [];
		const socket = await import('$lib/socket');
		socket.channels.set([channel as any]);
		socket.currentChannel.set(channel.id);
		const { default: Tab } = await import('../media-albums/MediaAlbumsTabImpl.svelte');
		const html = render(Tab as any, { props: { variant: 'full' } }).body;
		await Bun.sleep(30);
		return html;
	}

	test('a DM whose status is unknown says it is still checking and asks nothing of /api/albums', async () => {
		const html = await renderTab(DM);
		expect(html).toContain('still checking');
		expect(html).not.toContain('uses experimental encryption');
		expect(html).not.toContain('New album name');
		// refreshAlbums never starts (a shared channel shows "Loading albums…" at this point).
		expect(albumListCalls).toEqual([]);
		expect(tabRequests.filter((url) => url.includes('/api/albums'))).toEqual([]);
		// It asks for the room's status itself, so it does not wait on another surface.
		expect(tabRequests.some((url) => url.endsWith('/api/e2ee/channels/dm-1'))).toBe(true);
	});

	test('a shared channel keeps the create controls and starts loading its albums', async () => {
		const html = await renderTab(TEXT);
		expect(html).toContain('New album name');
		expect(albumListCalls).toContain('general');
	});
});

describe('report dialog', () => {
	async function renderReport(message: Record<string, unknown>): Promise<string> {
		const { default: Dialog } = await import('../ReportMessageDialog.svelte');
		return render(Dialog as any, { props: { visible: true, channelId: 'dm-1', message: { id: 'm-1', user: 'iris', userId: 'user-2', timestamp: 1, type: 'text', ...message } } }).body;
	}
	const sendButton = (html: string) => html.match(/<button[^>]*>(Disclose &amp; send report|Preserve &amp; send report|Disclose & send report|Preserve & send report)<\/button>/)?.[0] ?? '';

	test('an encrypted message asks for explicit disclosure and cannot be sent before it', async () => {
		const html = await renderReport({ text: 'the decrypted words', ...encrypted });
		expect(html).toContain('holds it only in encrypted form');
		expect(html).not.toContain('cannot read');
		expect(html).toMatch(/<input type="checkbox" class="w-check[^"]*"(?![^>]*checked)[^>]*>/);
		expect(sendButton(html)).toContain('disabled');
		expect(sendButton(html)).toContain('Disclose');
	});

	test('an undecryptable message offers no disclosure', async () => {
		const html = await renderReport({ text: 'x', e2eeUnreadable: 'no-key', ...encrypted });
		expect(html).toContain('could not decrypt');
		expect(html).not.toContain('type="checkbox"');
		expect(sendButton(html)).toContain('disabled');
	});

	test('a server-readable message reports as before', async () => {
		const html = await renderReport({ text: 'plain words' });
		expect(html).toContain('This report preserves evidence');
		expect(sendButton(html)).not.toContain('disabled');
	});
});

describe('message menu', () => {
	async function renderMenu(message: Record<string, unknown>, roomKeepReason: string | null = null): Promise<string> {
		const { default: Menu } = await import('../MessageContextMenu.svelte');
		return render(Menu as any, {
			props: {
				message: { id: 'm-1', user: 'iris', userId: 'user-2', timestamp: 1, type: 'file', fileUrl: '/uploads/a.png', fileName: 'a.png', text: 'Shared: a.png', ...message },
				visible: true, x: 1, y: 1, roomKeepReason,
				onEdit: noop, onDelete: noop, onPin: noop, onReply: noop, onDownload: noop, onAddToAlbum: noop,
				onPromoteToLore: noop, onForward: noop, onReport: noop, canManageOwnMessage: false, canDeleteMessage: false
			}
		}).body;
	}

	test('an encrypted message gets disabled album and forward rows with the reason, and no Lore row', async () => {
		const html = await renderMenu(encrypted);
		expect(html).toContain('this message arrived with experimental encryption');
		expect(html).not.toContain('Promote to Lore');
	});

	test('a plain message in a room still being checked says so, not that it is encrypted', async () => {
		const html = await renderMenu({}, 'checking');
		expect(html).toContain('still checking');
		expect(html).not.toContain('uses experimental encryption');
	});

	test('a plain message in a shared room keeps every row', async () => {
		const html = await renderMenu({});
		expect(html).toContain('Promote to Lore');
		expect(html).not.toContain('Off because');
	});
});
