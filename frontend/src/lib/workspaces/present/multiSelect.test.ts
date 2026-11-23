import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { initialize, collection, readSlides } from './model';
import { setDesign, presetDesign, readDesign, patchSceneObjects, removeSceneObjects, addSceneObjects } from './nativeScene';
import type { ArtifactSession } from '../session';

function fixture() {
	const doc = new Y.Doc(), root = doc.getMap('data');
	initialize(root);
	const slideId = readSlides(root)[0].id;
	setDesign(root, slideId, presetDesign('comparison', 'Title', 'Left'));
	const origin = { who: 'test' };
	const session = { editable: true, isClosed: false, scope: { isCurrent: () => true }, data: root, doc, origin } as unknown as ArtifactSession;
	const design = collection(root).get(slideId)!.get('design') as Y.Map<unknown>;
	const undo = new Y.UndoManager(design, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
	return { doc, root, slideId, session, undo };
}

describe('multi-object edits are one Yjs transaction (one undo)', () => {
	test('patching several objects is undone together', () => {
		const { root, slideId, session, undo } = fixture();
		const before = readDesign(root, slideId)!.objects.map((o) => ({ id: o.id, x: o.x, y: o.y }));
		patchSceneObjects(session, slideId, before.map((o) => ({ id: o.id, patch: { x: o.x + 0.02, y: o.y + 0.05 } })));
		const moved = readDesign(root, slideId)!.objects;
		for (const [i, o] of moved.entries()) { expect(o.x).toBeCloseTo(before[i].x + 0.02); expect(o.y).toBeCloseTo(before[i].y + 0.05); }
		undo.undo();
		const back = readDesign(root, slideId)!.objects;
		for (const [i, o] of back.entries()) { expect(o.x).toBe(before[i].x); expect(o.y).toBe(before[i].y); }
		expect(undo.undoStack.length).toBe(0);
	});
	test('a bad patch writes nothing (all or none)', () => {
		const { root, slideId, session, undo } = fixture();
		const [a, b] = readDesign(root, slideId)!.objects;
		expect(() => patchSceneObjects(session, slideId, [{ id: a.id, patch: { x: 0.01 } }, { id: b.id, patch: { x: 5 } }])).toThrow();
		expect(readDesign(root, slideId)!.objects[0].x).toBe(a.x);
		expect(undo.undoStack.length).toBe(0);
	});
	test('removing several objects is one undo step', () => {
		const { root, slideId, session, undo } = fixture();
		const ids = readDesign(root, slideId)!.objects.map((o) => o.id);
		removeSceneObjects(session, slideId, ids.slice(0, 2));
		expect(readDesign(root, slideId)!.objects.length).toBe(ids.length - 2);
		expect(undo.undoStack.length).toBe(1);
		undo.undo();
		expect(readDesign(root, slideId)!.objects.length).toBe(ids.length);
	});
	test('pasting a group keeps order on top, one undo step, and respects the object limit', () => {
		const { root, slideId, session, undo } = fixture();
		const before = readDesign(root, slideId)!.objects;
		const items = before.map(({ id: _id, z: _z, ...rest }) => rest);
		const made = addSceneObjects(session, slideId, items);
		expect(made.length).toBe(items.length);
		const after = readDesign(root, slideId)!.objects;
		expect(after.length).toBe(before.length * 2);
		const zs = made.map((id) => after.find((o) => o.id === id)!.z);
		expect(zs).toEqual([...zs].sort((a, b) => a - b));
		expect(Math.min(...zs)).toBeGreaterThan(Math.max(...before.map((o) => o.z)));
		expect(undo.undoStack.length).toBe(1);
		undo.undo();
		expect(readDesign(root, slideId)!.objects.length).toBe(before.length);
		expect(() => addSceneObjects(session, slideId, Array.from({ length: 70 }, () => items[0]))).toThrow('64');
	});
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const designer = read('./NativeSlideDesigner.svelte');
const workspace = read('./PresentWorkspace.svelte');
const css = read('./present.css');

describe('designer selection and snapping (source)', () => {
	test('selection is a list; Shift, Ctrl and Cmd toggle; a rubber band selects; Ctrl+A selects all', () => {
		expect(designer).toContain('ids = $state<string[]>([])');
		expect(designer).toContain('event.shiftKey || event.ctrlKey || event.metaKey');
		expect(designer).toContain('function startBand(event: PointerEvent)');
		expect(designer).toContain("lower === 'a'");
		expect(designer).toContain('class="rubber-band"');
		expect(designer).toContain('{chosenSet.length} objects selected');
	});
	test('keyboard focus selects the object so Tab and Shift+Tab walk the selection', () => {
		expect(designer).toContain('onfocus={(event) => focused(event, object)}');
		expect(designer).toContain("matches(':focus-visible')");
	});
	test('Ctrl+arrows nudge 0.2%, Shift 5%, plain 1%', () => {
		expect(designer).toContain('const step = mod ? 0.002 : event.shiftKey ? 0.05 : 0.01;');
	});
	test('group edits go through the one-transaction helpers', () => {
		for (const call of ['patchSceneObjects(', 'removeSceneObjects(', 'addSceneObjects(']) expect(designer).toContain(call);
	});
	test('dragging snaps through snap.ts unless Alt is held and draws guides', () => {
		expect(designer).toContain("from './snap'");
		expect(designer).toContain('snap: !event.altKey');
		expect(designer).toContain('class="snap-guide snap-guide--v"');
		expect(css).toContain('.snap-guide');
	});
});

describe('slide and show keys (source)', () => {
	test('PowerPoint slide keys and honest menu hints', () => {
		for (const text of ["lower === 'm'", "lower === 'd'", "event.key === 'ArrowUp' || event.key === 'ArrowDown'", 'slides.length - 1 - index', "shortcut: 'Ctrl M'", "shortcut: 'Ctrl Shift D'", "shortcut: 'Ctrl ↑'", "shortcut: 'Ctrl Shift ↓'"]) expect(workspace).toContain(text);
		expect(workspace).not.toContain("shortcut: 'Alt ↑'");
		// Alt + arrows still move a slide in the filmstrip.
		expect(workspace).toContain('if (step && event.altKey)');
		// The browser owns F5 and Ctrl+N/W/T.
		expect(workspace).not.toMatch(/key === 'F5'/);
	});
	test('slideshow: N/P, Backspace, digits then Enter, W for white, Home/End', () => {
		for (const text of ["key === 'n' || key === 'N'", "key === 'p' || key === 'P'", "'Backspace'", '/^[0-9]$/.test(key)', "key === 'Enter' && plain", "key === 'w' || key === 'W'", "key === 'Home'", "key === 'End'", 'present-show__white']) expect(workspace).toContain(text);
	});
});
