import { expect, test } from 'bun:test';
import { parseServerBuildIdentity } from './buildIdentity';
test('build diagnostics distinguish component versions and unknown source identity', () => {
	expect(parseServerBuildIdentity({ schemaVersion: 1, component: 'wabi-server', version: '0.1.0', sourceRevision: null })).toEqual({ version: '0.1.0', sourceRevision: null });
	expect(parseServerBuildIdentity({ schemaVersion: 1, component: 'wabi-server', version: '0.1.0-alpha.1', sourceRevision: 'a'.repeat(40) })?.sourceRevision).toBe('a'.repeat(40));
});
test('malformed or wrong-component metadata is not presented as server identity', () => {
	for (const value of [null, {}, { schemaVersion: 1, component: 'wabi-frontend', version: '1.0.0', sourceRevision: null }, { schemaVersion: 1, component: 'wabi-server', version: '0.1.0', sourceRevision: 'unknown-or-runtime-value' }]) expect(parseServerBuildIdentity(value)).toBeNull();
});
