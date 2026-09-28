import { describe, expect, test } from 'bun:test';
import { reactionPresentation } from './reactionPresentation';

const me = { id: 'self-socket', dbUserId: 42, username: 'Me' };
const other = { id: 'other-socket', dbUserId: 7, username: 'Other' };

describe('reaction attribution', () => {
	test('unknown IDs remain unknown and never borrow the current username', () => {
		expect(reactionPresentation(['user-999', 'missing-socket'], [other], me, 'Unknown user'))
			.toEqual({ userReacted: false, tooltip: 'Unknown user, Unknown user' });
	});

	test('numeric live IDs and stable history IDs agree on selection and attribution', () => {
		for (const id of ['42', 'user-42', 'self-socket']) {
			expect(reactionPresentation([id], [other], me, 'Unknown user'))
				.toEqual({ userReacted: true, tooltip: 'Me' });
		}
	});

	test('other users resolve by stable, numeric or socket ID without selecting my reaction', () => {
		for (const id of ['7', 'user-7', 'other-socket']) {
			expect(reactionPresentation([id], [other], me, 'Unknown user'))
				.toEqual({ userReacted: false, tooltip: 'Other' });
		}
	});

	test('malformed identity suffixes do not resolve to a registered user', () => {
		expect(reactionPresentation(['user-7bad'], [other], undefined, 'Unknown user'))
			.toEqual({ userReacted: false, tooltip: 'Unknown user' });
	});
});
