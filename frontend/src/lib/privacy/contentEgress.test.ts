/**
 * Decrypted content from a room with experimental encryption must not leave the device through
 * previews, third-party media, translation, albums, Lore or reports without the member's explicit
 * choice (docs/PRIVACY_STANCE.md, point 6). These tests drive the pure gates; the components that
 * call them are rendered in components/message/keptContent.render.test.ts, and the HTML
 * renderers run in a real browser (scripts/kept-content-browser-smoke.mjs).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	albumsHint,
	albumsUnavailable,
	clearTranslationConsent,
	contentStaysOnDevice,
	forwardHint,
	keepReasonFor,
	mayTranslate,
	messageUnderExperimentalEncryption,
	roomKeepReason,
	roomKeepsContentOnDevice,
	translationConsentRequest,
	type KeepReason
} from './contentEgress';
import { isWabiServerMediaUrl, remoteAttachmentUrls } from './remoteMedia';
import { needsLinkPreviewComponent, planLinkEmbeds } from '../components/message/linkEmbedPolicy';
import { addMessageAttachmentsToAlbum, getMessageAttachmentActionItems } from '../components/message/messageAttachmentActions';
import { serverReadableActionBlock, shouldFetchPromotes, translationRoomKey } from '../components/message/messageListGuards';
import { DISCLOSED_SNAPSHOT_MAX_CHARS, planReportRequest } from '../components/reportMessageRequest';
import { clearAutoTranslationState, requestAutoTranslation } from '../addons/translatorAuto';
import { autoTranslationSkip } from '../addons/translatorAutoPolicy';
import { addMediaAlbumItem, listMediaAlbums } from '../api/albums';
import type { Message } from '../socket-types';

const requests: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
	requests.length = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		requests.push(url);
		if (url.includes('/detect')) return new Response(JSON.stringify([{ language: 'de', confidence: 90 }]));
		if (url.includes('/translate')) return new Response(JSON.stringify({ translatedText: 'hello' }));
		if (url.includes('/api/albums')) return new Response(JSON.stringify({ albums: [{ id: 7, name: 'Trip', itemCount: 0 }] }));
		return new Response('{}');
	}) as typeof fetch;
	clearAutoTranslationState();
	clearTranslationConsent();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** What prepareIncomingE2eeMessage (e2ee.ts) returns for a decrypted envelope. */
function decrypted(patch: Partial<Message> = {}): Message {
	return {
		id: 'm-1',
		channelId: 'dm-1',
		user: 'iris',
		userId: 'user-2',
		text: 'meet at https://example.org/plan and look https://cdn.example.net/photo.png',
		type: 'text',
		timestamp: 1,
		encrypted: true,
		e2ee: true,
		e2eeVerified: true,
		...patch
	} as Message;
}

const encryptedRoom = { channelType: 'dm', policy: { enabled: true } };
const pendingRoom = { channelType: 'group', policy: { enabled: false, pendingDefault: true } };
const olderReadableDm = { channelType: 'dm', policy: { enabled: false, pendingDefault: false, serverReadableSelected: false } };
const communityChannel = { channelType: 'text', policy: null };

describe('one source of truth, with its reason', () => {
	test('decrypted and undecryptable envelopes, and own encrypted sends, count as encrypted', () => {
		expect(messageUnderExperimentalEncryption(decrypted())).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'Unable to decrypt', e2ee: true, e2eeUnreadable: 'no-key' } as Message)).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'hi', encrypted: true })).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'wabi-e2ee-v1:{"v":1}' })).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'plain' })).toBe(false);
	});

	test('rooms answer with what is actually true about them', () => {
		expect(roomKeepReason(encryptedRoom)).toBe('experimental-encryption');
		expect(roomKeepReason(pendingRoom)).toBe('encryption-pending');
		expect(roomKeepReason({ channelType: 'dm', policy: null })).toBe('checking');
		expect(roomKeepReason(olderReadableDm)).toBeNull();
		expect(roomKeepReason({ channelType: 'dm', policy: { serverReadableSelected: true, serverReadableAllowedByMe: true } })).toBeNull();
		expect(roomKeepReason(communityChannel)).toBeNull();
		expect(roomKeepsContentOnDevice(pendingRoom)).toBe(true);
	});

	test('an encrypted message keeps its content even when the room says otherwise', () => {
		expect(keepReasonFor(decrypted(), roomKeepReason(olderReadableDm))).toBe('encrypted-message');
		expect(keepReasonFor(decrypted(), 'checking')).toBe('encrypted-message');
		expect(keepReasonFor(decrypted(), 'experimental-encryption')).toBe('experimental-encryption');
		expect(keepReasonFor({ text: 'plain' }, 'encryption-pending')).toBe('encryption-pending');
		expect(contentStaysOnDevice({ text: 'plain' }, null)).toBe(false);
	});
});

describe('wording never claims more than the reason', () => {
	const reasons: KeepReason[] = ['experimental-encryption', 'encryption-pending', 'checking', 'encrypted-message'];
	const words = (reason: KeepReason) => [
		albumsHint(reason),
		forwardHint(reason),
		albumsUnavailable(reason).title,
		albumsUnavailable(reason).text,
		translationConsentRequest('https://translate.example.org/translate', reason).body
	];

	test('only an enabled room is told it uses experimental encryption', () => {
		for (const reason of reasons) {
			const claims = words(reason).some((text) => /uses experimental encryption/.test(text));
			expect([reason, claims]).toEqual([reason, reason === 'experimental-encryption']);
		}
		expect(words('checking').every((text) => !/encrypt(ed|ion) (is|uses)/i.test(text))).toBe(true);
		expect(albumsHint('checking')).toContain('still checking');
		expect(albumsHint('encryption-pending')).toContain('waiting for encryption');
	});

	test('no surface says secure, verified or end-to-end', () => {
		for (const reason of reasons) {
			for (const text of words(reason)) expect(text).not.toMatch(/\b(secure|verified|end-to-end|E2EE)\b/i);
		}
	});
});

describe('the locality rule for media', () => {
	const origins = ['https://wabi.example.org'];

	test('a real URL parse decides, not a prefix', () => {
		expect(isWabiServerMediaUrl('/uploads/a.png', origins)).toBe(true);
		expect(isWabiServerMediaUrl('https://wabi.example.org/uploads/a.png', origins)).toBe(true);
		expect(isWabiServerMediaUrl('//t.example.net/x.gif', origins)).toBe(false);
		expect(isWabiServerMediaUrl('https://t.example.net/x.gif', origins)).toBe(false);
		expect(isWabiServerMediaUrl('/api/image-proxy?url=https://t.example.net/x.gif', origins)).toBe(false);
		expect(isWabiServerMediaUrl('/API/image-proxy?url=x', origins)).toBe(false);
		expect(isWabiServerMediaUrl('data:image/png;base64,AAAA', origins)).toBe(true);
		expect(isWabiServerMediaUrl('blob:https://wabi.example.org/1234', origins)).toBe(true);
		expect(isWabiServerMediaUrl('javascript:alert(1)', origins)).toBe(false);
		expect(isWabiServerMediaUrl('https://wabi.example.org.evil.net/a.png', origins)).toBe(false);
	});

	test('remote attachments are found among a message’s files', () => {
		const message = { fileUrl: '/uploads/a.wabi', files: [{ fileUrl: 'https://cdn.example.net/b.png' }, { fileUrl: '//cdn.example.net/c.mp4' }] };
		expect(remoteAttachmentUrls(message, origins)).toEqual(['https://cdn.example.net/b.png', '//cdn.example.net/c.mp4']);
		expect(remoteAttachmentUrls({ fileUrl: '/uploads/a.wabi' }, origins)).toEqual([]);
	});
});

describe('link plans', () => {
	const context = (keepOnDevice: boolean) => ({ keepOnDevice, spotifyControlsEnabled: true, youtubeQueueChannel: false });

	test('kept content never plans a server preview', () => {
		const text = 'see https://example.org/a and https://www.youtube.com/watch?v=abc';
		expect(planLinkEmbeds(text, context(true)).some((plan) => plan.preview)).toBe(false);
		expect(needsLinkPreviewComponent(text, context(true))).toBe(false);
		expect(needsLinkPreviewComponent(text, context(false))).toBe(true);
	});

	test('media hosted elsewhere waits for a click in kept content, and loads as before elsewhere', () => {
		const text = 'https://cdn.example.net/photo.png https://open.spotify.com/track/abc https://cdn.example.net/clip.mp4';
		expect(planLinkEmbeds(text, context(true)).map((plan) => [plan.direct, plan.directNeedsClick])).toEqual([
			['image', true],
			['spotify', true],
			['video', true]
		]);
		expect(planLinkEmbeds(`${text} https://example.org/a`, context(false)).map((plan) => [plan.direct, plan.directNeedsClick, plan.preview])).toEqual([
			['image', false, false],
			['spotify', false, false],
			['video', false, false],
			[null, false, true]
		]);
	});
});

describe('translation', () => {
	const settings = {
		mode: 'auto' as const,
		model: 'libretranslate-self-hosted' as const,
		providerUrl: 'https://translate.example.org/translate',
		sourceLang: 'auto',
		targetLang: 'en',
		understoodLanguages: ['en'],
		useProxy: false as const
	};
	const visible = { visible: true, manualTranslation: undefined, ownMessage: false, mode: 'auto', messageType: 'text', localCard: false };

	test('MessageItem’s rule skips kept content before anything else', () => {
		expect(autoTranslationSkip({ ...visible, keepOnDevice: true })).toBe('kept');
		expect(autoTranslationSkip({ ...visible, visible: false, keepOnDevice: true })).toBe('kept');
		expect(autoTranslationSkip({ ...visible, keepOnDevice: false })).toBeNull();
		expect(autoTranslationSkip({ ...visible, mode: 'on-demand', keepOnDevice: false })).toBe('mode');
	});

	test('auto-translate sends nothing for kept content, and still works for server-readable content', async () => {
		const words = 'Wir treffen uns morgen am Bahnhof';
		expect(await requestAutoTranslation('m-1', words, settings, { message: decrypted({ text: words }), channelId: 'general', channelType: 'text' })).toBeNull();
		expect(await requestAutoTranslation('m-1', words, settings, { message: { text: words }, channelId: 'dm-1', channelType: 'dm' })).toBeNull();
		expect(requests).toEqual([]);
		const result = await requestAutoTranslation('m-2', words, settings, { message: { text: words }, channelId: 'general', channelType: 'text' });
		expect(result?.translatedText).toBe('hello');
		expect(requests.some((url) => url.startsWith('https://translate.example.org/'))).toBe(true);
	});

	test('manual translation asks once per server, account and room; a refusal is final for that call', async () => {
		const asked: string[] = [];
		const decline = async (request: { body: string }) => { asked.push(request.body); return false; };
		const accept = async (request: { body: string }) => { asked.push(request.body); return true; };
		const room = translationRoomKey('https://wabi.example.org', 12, 'dm-1');
		const base = { roomKey: room, reason: 'experimental-encryption' as const, providerUrl: settings.providerUrl };

		expect(await mayTranslate({ ...base, ask: decline })).toBe(false);
		expect(asked[0]).toContain('translate.example.org');
		expect(await mayTranslate({ ...base, ask: accept })).toBe(true);
		expect(await mayTranslate({ ...base, ask: decline })).toBe(true);
		expect(asked.length).toBe(2);
		expect(await mayTranslate({ ...base, roomKey: translationRoomKey('https://wabi.example.org', 13, 'dm-1'), ask: decline })).toBe(false);
		expect(await mayTranslate({ ...base, roomKey: translationRoomKey('https://other.example.org', 12, 'dm-1'), ask: decline })).toBe(false);
		expect(await mayTranslate({ ...base, reason: null, roomKey: 'x|1|text-1', ask: decline })).toBe(true);
		expect(asked.length).toBe(4);
	});
});

describe('server-readable actions', () => {
	test('albums, forward, Lore and Blender import are blocked for kept content with the right reason', () => {
		for (const action of ['album', 'forward', 'lore', 'blend'] as const) {
			expect(serverReadableActionBlock(action, decrypted(), null)).toContain('this message arrived with experimental encryption');
			expect(serverReadableActionBlock(action, { text: 'plain' }, 'checking')).toContain('still checking');
			expect(serverReadableActionBlock(action, { text: 'plain' }, null)).toBeNull();
		}
	});

	test('the Lore badge lookup is skipped for kept content', () => {
		expect(shouldFetchPromotes(true, decrypted(), null)).toBe(false);
		expect(shouldFetchPromotes(true, { text: 'plain' }, 'encryption-pending')).toBe(false);
		expect(shouldFetchPromotes(true, { text: 'plain' }, null)).toBe(true);
		expect(shouldFetchPromotes(false, { text: 'plain' }, null)).toBe(false);
	});

	const withFile = decrypted({
		type: 'file',
		text: 'Shared: passport-scan.jpg',
		fileUrl: '/uploads/e2ee-1.wabi',
		fileName: 'passport-scan.jpg',
		fileSize: 10,
		attachmentEncryption: { scheme: 'dm-e2ee-v1', iv: 'x' } as Message['attachmentEncryption']
	});

	test('"Add to album" on an encrypted message sends nothing to /api/albums', async () => {
		const outcome = await addMessageAttachmentsToAlbum({
			keepOnDevice: serverReadableActionBlock('album', withFile, null) !== null,
			messageId: withFile.id,
			items: getMessageAttachmentActionItems(withFile),
			resolveAlbum: async () => {
				const albums = await listMediaAlbums('token', 'dm', 'dm-1');
				return albums[0] ? { id: albums[0].id, name: albums[0].name } : null;
			},
			addItem: (albumId, payload) => addMediaAlbumItem('token', albumId, payload)
		});
		expect(outcome.status).toBe('blocked');
		expect(requests.filter((url) => url.includes('/api/albums'))).toEqual([]);
	});

	test('a server-readable message still reaches the album index', async () => {
		const plain = { ...withFile, encrypted: false, e2ee: false, attachmentEncryption: undefined } as Message;
		const outcome = await addMessageAttachmentsToAlbum({
			keepOnDevice: serverReadableActionBlock('album', plain, null) !== null,
			messageId: plain.id,
			items: getMessageAttachmentActionItems(plain),
			resolveAlbum: async () => ({ id: 7, name: 'Trip' }),
			addItem: (albumId, payload) => addMediaAlbumItem('token', albumId, payload)
		});
		expect(outcome).toEqual({ status: 'added', count: 1, albumName: 'Trip' });
		expect(requests.some((url) => url.includes('/api/albums/7/items'))).toBe(true);
	});
});

describe('report', () => {
	const base = { channelId: 'dm-1', reason: 'Harassment', comment: '  ' };

	test('an encrypted message carries disclosedSnapshot only after the reporter confirms', () => {
		const message = decrypted({ text: 'the decrypted words' });
		expect(planReportRequest({ ...base, message, disclosureConfirmed: false })).toEqual({ kind: 'needs-disclosure' });
		expect(planReportRequest({ ...base, message, disclosureConfirmed: true })).toEqual({
			kind: 'send',
			truncated: false,
			body: { channelId: 'dm-1', messageId: 'm-1', reason: 'Harassment', comment: null, disclosedSnapshot: 'the decrypted words' }
		});
	});

	test('a server-readable message never sends a disclosed snapshot', () => {
		const plan = planReportRequest({ ...base, message: { id: 'm-9', text: 'plain' }, disclosureConfirmed: true });
		expect(plan).toEqual({ kind: 'send', truncated: false, body: { channelId: 'dm-1', messageId: 'm-9', reason: 'Harassment', comment: null } });
	});

	test('undecryptable, not-yet-decrypted and text-less messages have nothing to disclose', () => {
		const unreadable = decrypted({ text: 'This message could not be decrypted on this device.', e2eeUnreadable: 'no-key', e2eeVerified: false });
		expect(planReportRequest({ ...base, message: unreadable, disclosureConfirmed: true })).toEqual({ kind: 'unreadable' });
		// Reviewer probe: a raw envelope must never be offered as decrypted text.
		expect(planReportRequest({ channelId: 'dm-1', message: { id: 'm', text: 'wabi-e2ee-v1:{"v":1}' }, reason: 'Spam', comment: '', disclosureConfirmed: true }).kind).not.toBe('send');
		expect(planReportRequest({ ...base, message: decrypted({ text: '   ' }), disclosureConfirmed: true })).toEqual({ kind: 'nothing-to-disclose' });
	});

	test('a long disclosure is cut on a code-point boundary at the server’s limit, and says so', () => {
		// Reviewer probe: never end on a lone surrogate.
		const text = 'a'.repeat(11_999) + '😀' + 'tail';
		const plan = planReportRequest({ channelId: 'dm-1', message: { id: 'm', text, e2ee: true }, reason: 'Spam', comment: '', disclosureConfirmed: true });
		expect(plan.kind).toBe('send');
		const snapshot = plan.kind === 'send' ? plan.body.disclosedSnapshot ?? '' : '';
		expect(/[\uD800-\uDBFF]$/.test(snapshot)).toBe(false);
		expect(Array.from(snapshot).length).toBe(DISCLOSED_SNAPSHOT_MAX_CHARS);
		expect(snapshot.endsWith('😀')).toBe(true);
		expect(plan.kind === 'send' && plan.truncated).toBe(true);
	});
});
