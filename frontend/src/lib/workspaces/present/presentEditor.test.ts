import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Present (design contract §8.8; critiques office-present#1–#17). Sources are read as text: a
// regression that brings back the theme heading leak, the button walls, top-left dialogs, the
// postage-stamp presenter view or the untruthful overlay pill fails here. Comments are removed by
// a loop that repeats one pattern until nothing changes (never a single-pass replace).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => {
	let previous = '';
	let current = source;
	while (current !== previous) {
		previous = current;
		current = current.replace(/\/\*[\s\S]*?\*\//, '');
	}
	return current;
};
const workspace = read('./PresentWorkspace.svelte');
const designer = read('./NativeSlideDesigner.svelte');
const version = read('./PresentedVersion.svelte');
const conversion = read('./OfficeConversion.svelte');
const css = stripComments(read('./present.css'));
const files = read('./files.ts');
const slide = read('../AudienceSlide.svelte');
const scene = read('../SceneView.svelte');
const room = read('../AudienceWorkspace.svelte');
const headings = stripComments(read('../../../styles/surfaces/headings.css'));
const overlay = read('../../components/PresenterOverlayCanvas.svelte');
const menu = read('../../components/ui/Menu.svelte');
const stageBar = read('../../components/StageBar.svelte');

describe('the slide owns its typography (office-present#1)', () => {
	test('no app heading rule reaches into a slide or a canvas', () => {
		const rules = headings.match(/:root \.main-content (?::is\(h1, h2\)|h1)[^{]*\{/g) || [];
		expect(rules.length).toBe(2);
		for (const rule of rules) {
			expect(rule).toContain(':not(.audience-slide *)');
			expect(rule).toContain(':not(.scene *)');
		}
		// Row A sets its own type; the old .chat-header escape is gone with it.
		expect(headings).toContain(':not(.stage-bar *)');
		expect(headings).not.toContain('.chat-header');
	});

	test('the slide tokens are the exports’ values, never theme roles', () => {
		expect(slide).toContain('--slide-paper: #f4f1e9;');
		expect(slide).toContain('--slide-ink: #242836;');
		expect(files).toContain("slide.background={color:'F4F1E9'}");
		expect(files).toContain("color:'242836'");
		expect(slide).not.toMatch(/system-ui|var\(--w-/);
		expect(scene).toContain('font-family:var(--slide-face, Arial, sans-serif)');
	});

	test('on screen, in the PPTX and in the PDF, title and text are the same share of the slide width', () => {
		const pptxTitle = Number(files.match(/fontFace:'Arial',fontSize:(\d+),bold:true/)![1]);
		const pptxText = Number(files.match(/fontFace:'Arial',fontSize:(\d+),color:'242836',margin:0,fit:'shrink'/)![1]);
		const printTitle = Number(files.match(/h1\{font-size:(\d+)pt/)![1]);
		const printText = Number(files.match(/p\{white-space:pre-wrap;font-size:(\d+)pt/)![1]);
		const screenTitle = Number(slide.match(/--slide-title: ([\d.]+)cqw;/)![1]);
		const screenText = Number(slide.match(/--slide-text: ([\d.]+)cqw;/)![1]);
		// A 10in slide is 720pt wide; cqw is 1% of the slide's width.
		expect(printTitle).toBe(pptxTitle);
		expect(printText).toBe(pptxText);
		expect(screenTitle).toBeCloseTo((pptxTitle / 720) * 100, 1);
		expect(screenText).toBeCloseTo((pptxText / 720) * 100, 1);
	});

	test('a thumbnail is the slide made smaller: no pixel floors, no self-clamped height', () => {
		const code = slide.slice(slide.indexOf('<style>'));
		expect(code).not.toMatch(/clamp\(/);
		expect(code).not.toMatch(/\.audience-slide \{[^}]*max-height/);
	});
});

describe('the designer (office-present#5, #6, #9, #13, #14)', () => {
	test('row A: Edit | Present and the split primary “Present ▾” with the ways to present', () => {
		expect(workspace).toContain("options: [{ value: 'edit', label: 'Edit' }, { value: 'present', label: 'Present' }]");
		expect(workspace).toContain("menu: { label: 'Ways to present'");
		for (const way of ["label: 'Present locally'", "label: 'Present from this slide'", "label: 'Present to channel…'", "label: 'Update presented version…'"]) expect(workspace).toContain(way);
		expect(stageBar).toContain('<span class="w-split stage-a__split">');
		// No button wall: exports live in ⋯ Export with their truths.
		for (const gone of ['Export PPTX subset</button>', 'Print / Save audience PDF</button>', 'deck-tools', 'Move up</button>', 'Move down</button>']) expect(workspace).not.toContain(gone);
		expect(workspace).toContain("{ id: 'pptx', label: 'PPTX subset (.pptx)', icon: 'download', hint: 'Visible slides · no speaker notes'");
	});

	test('a narrow stage moves the mode segment into ⋯ so the title keeps its room', () => {
		expect(workspace).toContain('const rowAModes = $derived(stageWidth >= ROW_A_ROOM || $isMobile ? modes : null);');
		expect(workspace).toContain("role: 'menuitemradio', checked: modes.value === option.value");
	});

	test('the filmstrip: real thumbnails hidden from assistive tech, the current one named, keys to move and reorder', () => {
		expect(workspace).toContain('<span class="present-film__frame" aria-hidden="true"><AudienceSlideView {slide} {aspect} /></span>');
		expect(workspace).toContain("aria-current={slide.id === current?.id ? 'true' : undefined}");
		expect(workspace).toContain('if (step && event.altKey) { event.preventDefault(); attempt(() => move(step, slide.id)');
		expect(workspace).toContain("oncontextmenu={(event) => openSlideMenu(event, slide.id)}");
	});

	test('canvas slides hide the title, text and image fields they never draw', () => {
		const fields = workspace.slice(workspace.indexOf('{#snippet slideFields()}'), workspace.indexOf('{#snippet slideFooter()}'));
		const canvasGate = fields.indexOf("{#if current.layout !== 'canvas'}");
		expect(canvasGate).toBeGreaterThan(-1);
		expect(fields.indexOf('aria-label="Slide title"')).toBeGreaterThan(canvasGate);
		expect(fields.indexOf('aria-label="Slide text"')).toBeGreaterThan(canvasGate);
	});

	test('the inspector is Slide | Object with kit fields; no developer leftovers', () => {
		expect(designer).toContain("{ value: 'slide', label: 'Slide' }");
		expect(designer).toContain("{ value: 'object', label: 'Object', disabled: !design");
		for (const gone of ['#498DCF', 'designer-controls', 'Native layout and object controls', 'Add {kind}', 'object-fields']) expect(designer).not.toContain(gone);
		// Position and size read as percent; the model keeps fractions.
		expect(designer).toContain('const percent = (value: number) => Math.round(value * 1000) / 10;');
		expect(designer).toContain('number(field as \'x\' | \'y\' | \'w\' | \'h\', Number(event.currentTarget.value) / 100)');
		// Keyboard resize and delete, not only drag.
		expect(designer).toContain('if (event.altKey) {');
		expect(designer).toContain("if (event.key === 'Delete' || event.key === 'Backspace') {");
	});

	test('errors are one notice in view; Cancel import only while an import can be cancelled (office-present#4)', () => {
		expect(workspace).not.toContain('workspace-home-note');
		expect(workspace).toContain('{@render failure()}');
		expect(workspace).toContain('{#if importing}<button type="button" class="w-btn w-btn--sm" onclick={() => importAbort.abort()}>Cancel import</button>{/if}');
		expect(workspace).toContain("error = e instanceof WorkspaceError || (e instanceof Error && e.constructor === Error) || !cause ?");
	});

	test('present.css draws with roles: the 168 · pasteboard · 272 grid, solid edges in High Contrast', () => {
		expect(css).toContain('grid-template-columns: 168px minmax(0, 1fr) 272px;');
		expect(css).toContain('background: var(--w-sink);');
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(css).not.toMatch(/rgba?\(/);
		expect(css).not.toMatch(/--surface-|--text-primary|--accent-primary|--border-subtle|system-ui|!important|:has\(|:global/);
		expect(css).toContain(":root[data-char='contrast'] .present-film__card,");
	});
});

describe('presenting (office-present#2, #3, #8, #10, #12, #17)', () => {
	test('the local show is a stage mode with keys, not a top-left dialog with browser buttons', () => {
		expect(workspace).not.toContain('<dialog');
		expect(workspace).not.toContain('local-presentation');
		for (const key of ["['ArrowRight', 'ArrowDown', 'PageDown'].includes(key)", "key === 'Home'", "key === 'End'", "key === 'b' || key === 'B'", "key === 'f' || key === 'F'", "key === 'Escape' && !document.fullscreenElement"]) expect(workspace).toContain(key);
		// Notes are off by default and say where they show.
		expect(workspace).toContain('let notesOpen = $state(false)');
		expect(workspace).toContain('Private · this screen');
		expect(workspace).toContain('aria-live="polite"');
	});

	test('the presenter’s slide keeps at least 60%: one column of at most a third', () => {
		expect(css).toContain('grid-template-columns: minmax(0, 1fr) min(320px, 34%);');
		expect(css.match(/min\(320px, 34%\)/g)!.length).toBe(2);
	});

	test('the room: no role=img on the slide, announcements, private notes named, a person picker for handoff', () => {
		expect(room).not.toContain('role="img"');
		expect(room).toContain('<p class="sr-only" aria-live="polite">{announcement}</p>');
		expect(room).toContain('Private notes · this device');
		expect(room).toContain('<BaseModal isOpen={handoffOpen}');
		expect(room).toContain('aria-label="New presenter"');
		expect(room).not.toContain('Account ID for handoff');
		expect(room).toContain("if (presenter) return follow ? 'Presenting'");
		expect(room).toContain('setStageHeader(HEADER_OWNER, {');
		expect(room).toContain('clearStageHeader(HEADER_OWNER)');
	});

	test('every Present dialog is the centred kit dialog', () => {
		for (const source of [workspace, version, conversion, room]) {
			expect(source).not.toContain('<dialog');
			expect(source).toContain('<BaseModal');
		}
		expect(version).toContain('export async function prepare()');
	});

	test('conversion leads with “not set up” and sends nothing for a step that cannot happen', () => {
		const notConfigured = conversion.indexOf("Conversion isn't set up on this server");
		const consent = conversion.indexOf('The server operator can read the uploaded original.');
		expect(notConfigured).toBeGreaterThan(-1);
		expect(consent).toBeGreaterThan(notConfigured);
		expect(conversion).not.toContain('Keep original file');
	});

	test('the call overlay says its marks are local, on roles', () => {
		expect(overlay).toContain('Only you see these marks');
		expect(overlay).not.toContain('Presenter Overlay');
		const style = overlay.slice(overlay.indexOf('<style>'));
		expect(style).not.toMatch(/rgba?\(|--surface-|--text-inverse/);
	});
});

describe('menus opened from elsewhere leave nothing behind', () => {
	test('a Menu draws its own trigger only when it has trigger content', () => {
		expect(menu).toContain('{#if !anchor && children}');
	});
});
