/**
 * Decrypted content from a room with experimental encryption must not leave the device through
 * previews, third-party embeds, translation, albums or reports without the member's explicit
 * choice (docs/PRIVACY_STANCE.md, point 6). Each test drives the gate a component uses with an
 * encrypted message and records every request a fake `fetch` sees.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	clearTranslationConsent,
	contentStaysOnDevice,
	mayTranslate,
	messageUnderExperimentalEncryption,
	roomKeepsContentOnDevice
} from './contentEgress';
import { needsLinkPreviewComponent, planLinkEmbeds } from '../components/message/linkEmbedPolicy';
import { addMessageAttachmentsToAlbum, getMessageAttachmentActionItems } from '../components/message/messageAttachmentActions';
import { planReportRequest } from '../components/reportMessageRequest';
import { clearAutoTranslationState, requestAutoTranslation } from '../addons/translatorAuto';
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

describe('one source of truth', () => {
	test('decrypted and undecryptable envelopes, and own encrypted sends, count as encrypted', () => {
		expect(messageUnderExperimentalEncryption(decrypted())).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'Unable to decrypt', e2ee: true, e2eeUnreadable: 'no-key' } as Message)).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'hi', encrypted: true })).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'wabi-e2ee-v1:{"v":1}' })).toBe(true);
		expect(messageUnderExperimentalEncryption({ text: 'plain' })).toBe(false);
	});

	test('encrypted, pending and still-checking private rooms keep content on the device', () => {
		expect(roomKeepsContentOnDevice(encryptedRoom)).toBe(true);
		expect(roomKeepsContentOnDevice(pendingRoom)).toBe(true);
		expect(roomKeepsContentOnDevice({ channelType: 'dm', policy: null })).toBe(true);
		expect(roomKeepsContentOnDevice(olderReadableDm)).toBe(false);
		expect(roomKeepsContentOnDevice({ channelType: 'dm', policy: { serverReadableSelected: true, serverReadableAllowedByMe: true } })).toBe(false);
		expect(roomKeepsContentOnDevice(communityChannel)).toBe(false);
	});

	test('an encrypted message keeps its content on the device even when the room status says otherwise', () => {
		expect(contentStaysOnDevice(decrypted(), roomKeepsContentOnDevice(olderReadableDm))).toBe(true);
		expect(contentStaysOnDevice({ text: 'plain' }, roomKeepsContentOnDevice(pendingRoom))).toBe(true);
		expect(contentStaysOnDevice({ text: 'plain' }, roomKeepsContentOnDevice(communityChannel))).toBe(false);
	});
});

describe('link previews and direct embeds', () => {
	const context = (keepOnDevice: boolean) => ({ keepOnDevice, spotifyControlsEnabled: true, youtubeQueueChannel: false });

	test('an encrypted message never asks for /api/url-preview or /api/image-proxy', () => {
		const message = decrypted({ text: 'see https://example.org/a and https://www.youtube.com/watch?v=abc' });
		const plans = planLinkEmbeds(message.text, context(contentStaysOnDevice(message, false)));
		expect(plans.some((plan) => plan.preview)).toBe(false);
		expect(plans.every((plan) => plan.plainLink)).toBe(true);
		expect(needsLinkPreviewComponent(message.text, context(true))).toBe(false);
		expect(requests.filter((url) => url.includes('/api/url-preview') || url.includes('/api/image-proxy'))).toEqual([]);
	});

	test('media hosted elsewhere waits for a click in an encrypted room, and loads as before elsewhere', () => {
		const text = 'https://cdn.example.net/photo.png https://open.spotify.com/track/abc https://cdn.example.net/clip.mp4';
		const encrypted = planLinkEmbeds(text, context(true));
		expect(encrypted.map((plan) => [plan.direct, plan.directNeedsClick, plan.plainLink])).toEqual([
			['image', true, true],
			['spotify', true, true],
			['video', true, true]
		]);
		const readable = planLinkEmbeds(`${text} https://example.org/a`, context(false));
		expect(readable.map((plan) => [plan.direct, plan.directNeedsClick, plan.preview])).toEqual([
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

	test('auto-translate sends nothing for a message that stays on the device', async () => {
		const result = await requestAutoTranslation('m-1', 'Wir treffen uns morgen am Bahnhof', settings, { keepOnDevice: true });
		expect(result).toBeNull();
		expect(requests).toEqual([]);
	});

	test('auto-translate still works for a server-readable message', async () => {
		const result = await requestAutoTranslation('m-2', 'Wir treffen uns morgen am Bahnhof', settings);
		expect(result?.translatedText).toBe('hello');
		expect(requests.some((url) => url.startsWith('https://translate.example.org/'))).toBe(true);
	});

	test('manual translation asks once per room, and a refusal sends nothing', async () => {
		const asked: string[] = [];
		const decline = async (request: { body: string }) => { asked.push(request.body); return false; };
		const accept = async (request: { body: string }) => { asked.push(request.body); return true; };
		const base = { roomKey: 'server|dm-1', keepOnDevice: true, providerUrl: settings.providerUrl };

		expect(await mayTranslate({ ...base, ask: decline })).toBe(false);
		expect(asked[0]).toContain('translate.example.org');
		expect(await mayTranslate({ ...base, ask: accept })).toBe(true);
		expect(await mayTranslate({ ...base, ask: decline })).toBe(true);
		expect(asked.length).toBe(2);
		expect(await mayTranslate({ ...base, roomKey: 'server|dm-2', ask: decline })).toBe(false);
		expect(await mayTranslate({ ...base, keepOnDevice: false, roomKey: 'server|text-1', ask: decline })).toBe(true);
		expect(asked.length).toBe(3);
		expect(requests).toEqual([]);
	});
});

describe('albums', () => {
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
			keepOnDevice: contentStaysOnDevice(withFile, false),
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
			keepOnDevice: contentStaysOnDevice(plain, roomKeepsContentOnDevice(communityChannel)),
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
			body: { channelId: 'dm-1', messageId: 'm-1', reason: 'Harassment', comment: null, disclosedSnapshot: 'the decrypted words' }
		});
	});

	test('a server-readable message never sends a disclosed snapshot', () => {
		const plan = planReportRequest({ ...base, message: { id: 'm-9', text: 'plain' }, disclosureConfirmed: true });
		expect(plan).toEqual({ kind: 'send', body: { channelId: 'dm-1', messageId: 'm-9', reason: 'Harassment', comment: null } });
	});

	test('a message this device could not decrypt has nothing to disclose', () => {
		const message = decrypted({ text: 'This message could not be decrypted on this device.', e2eeUnreadable: 'no-key', e2eeVerified: false });
		expect(planReportRequest({ ...base, message, disclosureConfirmed: true })).toEqual({ kind: 'unreadable' });
	});
});
