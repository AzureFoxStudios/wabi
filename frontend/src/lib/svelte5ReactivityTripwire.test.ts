/**
 * Svelte 5 reactivity tripwire (calling-audit P0.3).
 *
 * Root cause class: in Svelte 5 legacy mode, template expressions that CALL
 * script functions compile to `$.untrack(() => fn(args))`. Arguments stay
 * tracked, but store/prop reads INSIDE the function body register NO
 * dependency — so a helper like `getVoiceMembers(id)` reading
 * `$voiceChannelMembers` makes the roster UI blind to join/leave events until
 * an unrelated signal forces a re-render ("must move channels to see voice
 * updates", proven via compiler probe 2026-08-24).
 *
 * Compiled-output facts established by probe (2026-08-24):
 *  - Helper call in template  -> `untrack(() => fn(args))`, ZERO deps. BROKEN.
 *  - Inline `$store.x` reads  -> emitted as `( $store(), untrack(() => ...) )`
 *    comma pairs; the leading call keeps a shallow tracked dep. Safe.
 *
 * Contract enforced here for the calling sidebar components: all
 * roster/presence reactivity flows through top-level `$:` derivations whose
 * values the template consumes via member access or as tracked arguments.
 * Never reintroduce a script helper that closes over a store AND is called
 * from the template.
 */
import { describe, expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const componentDir = join(here, 'components/sidebar');

/** Stores whose changes must be visible to these components' templates. */
const TRACKED_STORES = [
	'voiceChannelMembers',
	'speakingUsers',
	'voiceCallRecordingParticipants',
	'listeningVoiceChannels',
	'voiceTransmitMode',
	'isLocalSpeaking',
	'isMuted',
	'isDeafened',
	'currentUser'
];

interface UntrackHit {
	store: string;
	snippet: string;
}

/** Extract each full `$.untrack(...)` call via balanced parens (no regex spillage). */
function extractUntrackCalls(js: string): string[] {
	const calls: string[] = [];
	let from = 0;
	while (true) {
		const start = js.indexOf('$.untrack(', from);
		if (start === -1) break;
		let depth = 0;
		let i = start + '$.untrack'.length; // positioned at '('
		for (; i < js.length; i++) {
			if (js[i] === '(') depth++;
			else if (js[i] === ')') {
				depth--;
				if (depth === 0) break;
			}
		}
		calls.push(js.slice(start, i + 1));
		from = i + 1;
	}
	return calls;
}

/**
 * Detects the dangerous shape: a script-declared FUNCTION that reads a tracked
 * store, invoked from an untracked position (`untrack(() => fnName(`). The
 * store read lives in the function body, so detection must match on the
 * function NAME — the read never appears inside the untrack window itself.
 * (`includeInline` also reports raw `$store()` calls inside untrack windows;
 * those are normally paired with a tracked sibling by the compiler and safe,
 * so component assertions run in the default helper-only mode.)
 */
function findUntrackedStoreReads(
	source: string,
	opts: { includeInline?: boolean } = {}
): UntrackHit[] {
	const out = compile(source, { generate: 'client' }).js.code;
	const hits: UntrackHit[] = [];
	const push = (store: string, snippet: string) => {
		if (!hits.some((h) => h.store === store)) hits.push({ store, snippet });
	};

	// Script-level functions whose bodies read any tracked store.
	const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
	const storeReadingFns = new Set<string>();
	if (scriptMatch) {
		for (const decl of scriptMatch[1].matchAll(/function\s+(\w+)\s*\(/g)) {
			const name = decl[1];
			const after = scriptMatch[1].slice(decl.index ?? 0);
			const nextDecl = after.slice(1).search(/\n\t?(?:function\s|export\s|\/\*\*|const\s+\w+\s*=)/);
			const body = nextDecl === -1 ? after : after.slice(0, nextDecl + 1);
			for (const store of TRACKED_STORES) {
				if (new RegExp(`\\$${store}\\b`).test(body)) storeReadingFns.add(name);
			}
		}
	}

	for (const call of extractUntrackCalls(out)) {
		const window = call.replace(/\s+/g, ' ');
		const fnCall = call.match(/^\$\.untrack\(\s*\(\)\s*=>\s*\(?\s*(\w+)\s*\(/);
		if (fnCall && storeReadingFns.has(fnCall[1])) {
			push('helper:' + fnCall[1], window.slice(0, 180));
			continue;
		}
		if (!opts.includeInline) continue;
		for (const store of TRACKED_STORES) {
			if (new RegExp(`\\$${store}\\(\\)`).test(call)) push(store, window.slice(0, 180));
		}
	}
	return hits;
}

describe('svelte5 reactivity contract — calling sidebar', () => {
	test('VoiceChannelList has no store-closing helpers called from the template', () => {
		const source = readFileSync(join(componentDir, 'VoiceChannelList.svelte'), 'utf8');
		expect(findUntrackedStoreReads(source)).toEqual([]);
	});

	test('VoiceUserCard has no store-closing helpers called from the template', () => {
		const source = readFileSync(join(componentDir, 'VoiceUserCard.svelte'), 'utf8');
		expect(findUntrackedStoreReads(source)).toEqual([]);
	});

	// Self-check 1: the detector must fire on the original roster bug shape, so
	// a silent detector regression can never become an always-green test.
	test('detector fires on a helper that closes over a store (sanity)', () => {
		const buggy = `
<script lang="ts">
	import { voiceChannelMembers } from './stub';
	export let id: string;
	function getMembers(channelId: string) {
		return $voiceChannelMembers[channelId] || [];
	}
</script>
{#each getMembers(id) as m (m.userId)}<span>{m.username}</span>{/each}
`;
		const hits = findUntrackedStoreReads(buggy);
		expect(hits.some((h) => h.store === 'helper:getMembers')).toBe(true);
	});

	// Self-check 2 (inline mode): raw store reads DO appear inside untrack
	// windows when the compiler emits multi-read effects; includeInline must
	// surface them.
	test('detector surfaces inline store reads inside untrack windows (sanity, inline mode)', () => {
		const shape = `
<script lang="ts">
	import { currentUser } from './stub';
	export let rows: string[];
</script>
{#if $currentUser}
	{#each rows as r (r)}
		<img src={$currentUser.profilePicture} alt={$currentUser.name} />
	{/each}
{/if}
`;
		const hits = findUntrackedStoreReads(shape, { includeInline: true });
		expect(hits.some((h) => h.store === 'currentUser')).toBe(true);
	});
});
