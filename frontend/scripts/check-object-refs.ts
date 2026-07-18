import {
	registerObjectRef,
	unregisterObjectRef,
	clearObjectRefs,
	resolveObjectRef,
	searchObjectRefs,
	slugify
} from '../src/lib/objectRefRegistry';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		passed++;
		console.log(`  PASS  ${label}`);
	} else {
		failed++;
		console.log(`  FAIL  ${label}`);
	}
}

// --- setup ---
clearObjectRefs();

// --- slugify ---
assert(slugify('Hello World') === 'hello-world', 'slugify basic');
assert(slugify('  Spaces   Around  ') === 'spaces-around', 'slugify trim+collapse');
assert(slugify('UPPER_CASE') === 'upper_case', 'slugify preserves underscore');
assert(slugify('a!b@c#d$e%f^') === 'a-b-c-d-e-f', 'slugify strips non-alnum');

// --- register + resolve unique ---
registerObjectRef({
	kind: 'forum_post',
	id: 'p1',
	slug: 'ux_1151',
	title: 'Walls in level 2',
	channelId: 'c1'
});

const r1 = resolveObjectRef('ux_1151');
assert(r1.status === 'unique', 'resolve unique slug');
if (r1.status === 'unique') {
	assert(r1.record.kind === 'forum_post', '  kind is forum_post');
	assert(r1.record.id === 'p1', '  id is p1');
}

// --- resolve namespaced ---
const r2 = resolveObjectRef('f/ux_1151');
assert(r2.status === 'unique', 'resolve namespaced f/ux_1151');
if (r2.status === 'unique') {
	assert(r2.record.kind === 'forum_post', '  kind is forum_post');
}

const r3 = resolveObjectRef('w/ux_1151');
assert(r3.status === 'miss', 'resolve namespaced w/ux_1151 -> miss');

// --- ambiguous ---
registerObjectRef({
	kind: 'wiki_page',
	id: 'w1',
	slug: 'ux_1151',
	title: 'UX guidelines',
	channelId: 'c2'
});

const r4 = resolveObjectRef('ux_1151');
assert(r4.status === 'ambiguous', 'resolve ambiguous slug');
if (r4.status === 'ambiguous') {
	assert(r4.candidates.length === 2, '  two candidates');
}

// --- miss ---
const r5 = resolveObjectRef('nonexistent');
assert(r5.status === 'miss', 'resolve miss');

const r6 = resolveObjectRef('  ');
assert(r6.status === 'miss', 'resolve empty -> miss');

const r7 = resolveObjectRef('');
assert(r7.status === 'miss', 'resolve empty string -> miss');

// --- search ---
const s1 = searchObjectRefs('ux');
assert(s1.length >= 1, 'search "ux" returns results');
assert(s1.some((r) => r.id === 'p1'), 'search "ux" contains forum_post p1');

// search exact slug prefix ranks higher
registerObjectRef({
	kind: 'gallery_work',
	id: 'g1',
	slug: 'ux_skyline',
	title: 'Skyline',
	channelId: 'c3'
});

const s2 = searchObjectRefs('ux_');
assert(s2.length >= 2, 'search "ux_" returns multiple');
// First result should be exact match prefix for ux_1151 (but ux_skyline also starts with ux_)
// Both match startsWith. ux_1151 was registered first... order is by score then insertion order (Map preserves)
// We just check that both are in results
assert(s2.some((r) => r.id === 'p1'), 'search "ux_" contains p1');
assert(s2.some((r) => r.id === 'g1'), 'search "ux_" contains g1');

// --- unregister ---
unregisterObjectRef('forum_post', 'p1');
const r8 = resolveObjectRef('ux_1151');
assert(r8.status === 'ambiguous', 'after unregister, still wiki_page with same slug');
if (r8.status === 'ambiguous') {
	assert(r8.candidates.length === 1, '  only wiki_page remains');
	assert(r8.candidates[0].kind === 'wiki_page', '  remaining is wiki_page');
}

// --- clear ---
clearObjectRefs();
const r9 = resolveObjectRef('ux_1151');
assert(r9.status === 'miss', 'after clear -> miss');

// --- namespaced resolve for all 4 kinds ---
clearObjectRefs();
registerObjectRef({ kind: 'forum_post', id: 'fp1', slug: 'test', title: 'Forum', channelId: 'c' });
registerObjectRef({ kind: 'wiki_page', id: 'wp1', slug: 'test', title: 'Wiki', channelId: 'c' });
registerObjectRef({ kind: 'gallery_work', id: 'gw1', slug: 'test', title: 'Gallery', channelId: 'c' });
registerObjectRef({ kind: 'place', id: 'pl1', slug: 'test', title: 'Place', channelId: 'c' });

assert(resolveObjectRef('f/test').status === 'unique', 'f/test resolve unique forum_post');
assert(resolveObjectRef('w/test').status === 'unique', 'w/test resolve unique wiki_page');
assert(resolveObjectRef('g/test').status === 'unique', 'g/test resolve unique gallery_work');
assert(resolveObjectRef('m/test').status === 'unique', 'm/test resolve unique place');
assert(resolveObjectRef('x/test').status === 'miss', 'x/test -> miss (bad namespace)');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
