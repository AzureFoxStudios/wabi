import { describe, expect, test } from 'bun:test';
import { albumsAgreementView } from './albumsAgreementView';
import { serverReadableActionBlock } from '../message/messageListGuards';
import { albumsCanOpenByAgreement } from '$lib/privacy/contentEgress';
import type { E2eeRoomStatus } from '$lib/e2ee';

const status = (extra: Partial<E2eeRoomStatus>) => ({ enabled: true, memberUserIds: [1, 2, 3], ...extra }) as E2eeRoomStatus;

describe('albums agreement: what a member is shown', () => {
	test('unknown status shows nothing to act on', () => {
		expect(albumsAgreementView(null)).toEqual({ open: false, agreedByMe: false, agreedCount: 0, waitingFor: 0, askedByOthers: false });
	});

	test('someone else agreed: this member is asked', () => {
		const view = albumsAgreementView(status({ albumsAgreedUserIds: [2], albumsAgreedByMe: false, albumsAgreed: false }));
		expect(view.askedByOthers).toBe(true);
		expect(view.waitingFor).toBe(2);
	});

	test('this member agreed and waits for the rest', () => {
		const view = albumsAgreementView(status({ albumsAgreedUserIds: [1], albumsAgreedByMe: true, albumsAgreed: false }));
		expect(view).toMatchObject({ open: false, agreedByMe: true, askedByOthers: false, waitingFor: 2 });
	});

	test('everyone agreed: open, nobody is asked', () => {
		const view = albumsAgreementView(status({ albumsAgreedUserIds: [1, 2, 3], albumsAgreedByMe: true, albumsAgreed: true }));
		expect(view).toMatchObject({ open: true, waitingFor: 0, askedByOthers: false });
	});

	test('an agreement from someone who left does not count', () => {
		expect(albumsAgreementView(status({ albumsAgreedUserIds: [2, 9] })).agreedCount).toBe(1);
	});
});

describe('albums agreement: the privacy gate', () => {
	test('the agreement lifts the album block and nothing else', () => {
		expect(serverReadableActionBlock('album', { text: 'x' }, 'experimental-encryption')).not.toBeNull();
		expect(serverReadableActionBlock('album', { text: 'x' }, 'experimental-encryption', { album: true })).toBeNull();
		expect(serverReadableActionBlock('forward', { text: 'x' }, 'experimental-encryption', { album: true })).not.toBeNull();
		expect(serverReadableActionBlock('gallery', { text: 'x' }, 'experimental-encryption', { album: true })).not.toBeNull();
	});

	test('the hint points to the agreement only when the conversation state is known', () => {
		expect(serverReadableActionBlock('album', { text: 'x' }, 'experimental-encryption')).toContain('everyone in the conversation agrees');
		expect(serverReadableActionBlock('album', { text: 'x' }, 'checking')).not.toContain('agrees');
		expect(albumsCanOpenByAgreement('status-unavailable')).toBe(false);
	});
});
