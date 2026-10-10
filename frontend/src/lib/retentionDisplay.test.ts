import { expect, test } from 'bun:test';
import { currentRetentionFromPrivacy, explicitRetentionUpdate } from './retentionDisplay';

test('uses the actual short room policy instead of a missing snapshot fallback', () => {
    expect(currentRetentionFromPrivacy({ channelId: 'room', retention: '30s' }, 'room')).toBe('30s');
    expect(currentRetentionFromPrivacy({ channelId: 'room', retention: '1d' }, 'room')).toBe('24h');
});
test('refuses a different room or corrupt/absent policy without inventing a default', () => {
    for (const value of [null, {}, [], { channelId: 'other', retention: '30s' }, { channelId: 'room', retention: '0s' }, { channelId: 'room', retention: '366d' }]) {
        expect(currentRetentionFromPrivacy(value, 'room')).toBeNull();
    }
});
test('preserves live, forever and bounded custom policies distinctly', () => {
    for (const retention of ['live', 'forever', '2d']) expect(currentRetentionFromPrivacy({ channelId: 'room', retention }, 'room')).toBe(retention);
});
test('an unrelated settings save has no retention write', () => {
    expect(explicitRetentionUpdate(undefined)).toEqual({});
    expect(Object.hasOwn(explicitRetentionUpdate(undefined), 'autoDeleteAfter')).toBe(false);
    expect(explicitRetentionUpdate(null)).toEqual({ autoDeleteAfter: null });
    expect(explicitRetentionUpdate('30s')).toEqual({ autoDeleteAfter: '30s' });
    expect(explicitRetentionUpdate('live')).toEqual({ autoDeleteAfter: 'live' });
});
