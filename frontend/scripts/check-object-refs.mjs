// Standalone sanity check for objectRefRegistry logic.
// Duplicates core functions to avoid SvelteKit virtual module dependency.

function slugify(s) {
	return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const refStore = new Map();

function refKey(kind, id) { return `${kind}:${id}`; }
function register(record) { refStore.set(refKey(record.kind, record.id), record); }
function unregister(kind, id) { refStore.delete(refKey(kind, id)); }
function clear() { refStore.clear(); }

function searchObjectRefs(query, limit = 8) {
	const q = query.trim().toLowerCase();
	if (!q) return [];

	const scored = [];
	for (const record of refStore.values()) {
		const slugL = record.slug.toLowerCase();
		const titleL = record.title.toLowerCase();
		const subL = (record.subtitle ?? '').toLowerCase();

		let score = 0;
		if (slugL === q) score = 100;
		else if (slugL.startsWith(q)) score = 50;
		else if (slugL.includes(q)) score = 30;
		else if (titleL.includes(q)) score = 20;
		else if (subL.includes(q)) score = 10;
		if (score > 0) scored.push({ record, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map(r => r.record);
}

function resolveObjectRef(token) {
	const trimmed = token.trim();
	if (!trimmed) return { status: 'miss' };

	const candidates = [];
	const nsMatch = trimmed.match(/^([fwgm])\/(.+)/);
	if (nsMatch) {
		const kindMap = { f: 'forum_post', w: 'wiki_page', g: 'gallery_work', m: 'place' };
		const kind = kindMap[nsMatch[1]];
		const slug = nsMatch[2].toLowerCase();
		for (const record of refStore.values()) {
			if (record.kind === kind && record.slug.toLowerCase() === slug) {
				candidates.push(record);
			}
		}
	} else {
		const slug = trimmed.toLowerCase();
		for (const record of refStore.values()) {
			if (record.slug.toLowerCase() === slug) {
				candidates.push(record);
			}
		}
	}

	if (candidates.length === 0) return { status: 'miss' };
	if (candidates.length === 1) return { status: 'unique', record: candidates[0] };
	return { status: 'ambiguous', candidates };
}

let passed = 0, failed = 0;
function assert(condition, label) {
	if (condition) { passed++; console.log(`  PASS  ${label}`); }
	else { failed++; console.log(`  FAIL  ${label}`); }
}

// --- slugify ---
assert(slugify('Hello World') === 'hello-world', 'slugify basic');
assert(slugify('  Spaces   Around  ') === 'spaces-around', 'slugify trim+collapse');
assert(slugify('UPPER_CASE') === 'upper-case', 'slugify underscore->hyphen');
assert(slugify('a!b@c#d$e%f^') === 'a-b-c-d-e-f', 'slugify strips special chars');

// --- register + resolve unique ---
clear();
register({ kind: 'forum_post', id: 'p1', slug: 'ux_1151', title: 'Walls in level 2', channelId: 'c1' });

let r = resolveObjectRef('ux_1151');
assert(r.status === 'unique', 'resolve unique slug');
if (r.status === 'unique') {
	assert(r.record.kind === 'forum_post', '  kind is forum_post');
	assert(r.record.id === 'p1', '  id is p1');
}

// --- resolve namespaced ---
r = resolveObjectRef('f/ux_1151');
assert(r.status === 'unique', 'resolve namespaced f/ux_1151');
if (r.status === 'unique') assert(r.record.kind === 'forum_post', '  kind is forum_post');

r = resolveObjectRef('w/ux_1151');
assert(r.status === 'miss', 'resolve namespaced w/ux_1151 -> miss');

// --- ambiguous ---
register({ kind: 'wiki_page', id: 'w1', slug: 'ux_1151', title: 'UX guidelines', channelId: 'c2' });
r = resolveObjectRef('ux_1151');
assert(r.status === 'ambiguous', 'resolve ambiguous slug');
if (r.status === 'ambiguous') assert(r.candidates.length === 2, '  two candidates');

// --- miss ---
assert(resolveObjectRef('nonexistent').status === 'miss', 'resolve miss');
assert(resolveObjectRef('  ').status === 'miss', 'resolve whitespace -> miss');
assert(resolveObjectRef('').status === 'miss', 'resolve empty -> miss');

// --- search ---
let s = searchObjectRefs('ux');
assert(s.length >= 1, 'search "ux" returns results');
assert(s.some(r => r.id === 'p1'), 'search "ux" contains p1');

register({ kind: 'gallery_work', id: 'g1', slug: 'ux_skyline', title: 'Skyline', channelId: 'c3' });
s = searchObjectRefs('ux_');
assert(s.length >= 2, 'search "ux_" returns multiple');
assert(s.some(r => r.id === 'p1'), 'search "ux_" contains p1');
assert(s.some(r => r.id === 'g1'), 'search "ux_" contains g1');

// --- unregister ---
unregister('forum_post', 'p1');
r = resolveObjectRef('ux_1151');
assert(r.status === 'unique', 'after unregister, unique wiki_page');
if (r.status === 'unique') {
	assert(r.record.kind === 'wiki_page', '  remaining is wiki_page');
}

// --- clear ---
clear();
assert(resolveObjectRef('ux_1151').status === 'miss', 'after clear -> miss');

// --- all 4 kinds with namespaced resolve ---
clear();
register({ kind: 'forum_post', id: 'fp1', slug: 'test', title: 'Forum', channelId: 'c' });
register({ kind: 'wiki_page', id: 'wp1', slug: 'test', title: 'Wiki', channelId: 'c' });
register({ kind: 'gallery_work', id: 'gw1', slug: 'test', title: 'Gallery', channelId: 'c' });
register({ kind: 'place', id: 'pl1', slug: 'test', title: 'Place', channelId: 'c' });

assert(resolveObjectRef('f/test').status === 'unique', 'f/test -> unique forum_post');
assert(resolveObjectRef('w/test').status === 'unique', 'w/test -> unique wiki_page');
assert(resolveObjectRef('g/test').status === 'unique', 'g/test -> unique gallery_work');
assert(resolveObjectRef('m/test').status === 'unique', 'm/test -> unique place');
assert(resolveObjectRef('x/test').status === 'miss', 'x/test -> miss (bad namespace)');

// --- search empty ---
assert(searchObjectRefs('').length === 0, 'empty search returns []');
assert(searchObjectRefs('  ').length === 0, 'whitespace search returns []');

// --- search by title ---
clear();
register({ kind: 'wiki_page', id: 'wa', slug: 'wa', title: 'Waterfall Architecture', channelId: 'c' });
register({ kind: 'forum_post', id: 'fp', slug: 'fp', title: 'Fun with Waterfalls', channelId: 'c' });
s = searchObjectRefs('waterfall');
assert(s.length === 2, 'title search finds 2');
assert(s[0].id === 'wa', 'slug prefix ranks higher than title-only');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
