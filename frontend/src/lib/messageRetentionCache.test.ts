import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const list = readFileSync(new URL('./components/MessageList.svelte', import.meta.url), 'utf8');

// "Message timers poofed" after changing channel: the timeline was reset to null on every switch and only
// refilled when a request returned (never, if it failed), so every countdown disappeared meanwhile.
test('a channel already seen keeps its timers when you switch back, refreshed in the background', () => {
	expect(list).toContain('const retentionCache = new Map<string, RetentionEpoch[]>();');
	expect(list).toContain('retentionEpochs = retentionCache.get(key) ?? null;');
	expect(list).not.toContain('retentionEpochs = null;\n\t\t\tvoid refreshRetentionEpochs');
	// The cache key carries the policy, so a changed policy is refetched and never served stale; it stays bounded.
	expect(list).toContain('${activeChannelId}|${policyKey}');
	expect(list).toContain('retentionCache.size > 64');
});
