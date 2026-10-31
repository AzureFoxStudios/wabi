<!--
	Present (design contract §8.8; integration candidate, PREVIEW).

	Row A is the office editor header (ArtifactShell): the crumb back to the library, PREVIEW, the
	deck title, its locality and save state, the Edit | Present segment, then the split primary
	"Present ▾" (main: present locally from the first slide; menu: Present locally, from this slide,
	Present to channel…, and the live room's actions), Share… and ⋯ (exports with their truths).

	Edit: a 168px filmstrip of real thumbnails (the current slide ringed in --w-accent; arrows move,
	Alt + arrows reorder, Delete removes, right-click for the slide menu), the slide centred on a
	--w-sink pasteboard with the private speaker notes under it, and the 272px inspector
	(Slide | Object, NativeSlideDesigner).

	Present: the local show in center stage: the slide as large as the stage allows on a dark
	surface, a transport (‹ 2 / 5 › · Blank · Notes · Fullscreen · End), keyboard control
	(←/→, PageUp/PageDown, Space, Home/End, B, F, Esc) and the speaker notes only when asked for.
	Slide changes are announced politely.

	Errors are one notice at the top of the stage (our sentences; anything else is logged and the
	action's cause stands in). Long work (imports, exports, starting a room) shows an info notice,
	with Cancel only while an import can be cancelled. Every dialog is the centred kit dialog.
-->
<script lang="ts">
	import PresentedVersion from './PresentedVersion.svelte';
	import NativeSlideDesigner from './NativeSlideDesigner.svelte';
	import OfficeConversion from './OfficeConversion.svelte';
	import { editionFingerprint } from './versionPreview';
	import { resolveSlideSelection } from './selection';
	import { slideAnchor, objectAnchor } from '../anchors';
	import { onMount, onDestroy, tick as settled } from 'svelte';
	import { channels } from '$lib/channelStore';
	import ArtifactShell from '../ArtifactShell.svelte';
	import ArtifactLibrary from '../ArtifactLibrary.svelte';
	import AudienceSlideView from '../AudienceSlide.svelte';
	import type { OfficeHeaderModes } from '../OfficeEditorHeader.svelte';
	import { ArtifactSession, createArtifact, openArtifact, editText, download, readPrivateNotes, savePrivateNote, from64, Y } from '../session';
	import { captureScope, request, targets, openWorkspace, presentationLink, registerWorkspaceDisposer, WorkspaceError, type Scope, type AudienceState, type AudienceSlide } from '../bridge';
	import { initialize, readSlides, collection, addSlide, moveSlide, audienceSlides, validateNative, fromMarkdown, type DeckSlide } from './model';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import Switch from '$lib/components/ui/Switch.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import type { StageHeaderAction } from '$lib/stageHeader';
	import { isMobile } from '$lib/layoutStoreStates';
	import { toast } from '$lib/toast';
	import '../workspace.css';
	import './present.css';

	type Proposal = { title: string; aspect: number; slides: Omit<AudienceSlide, 'id'>[]; warnings: string[]; source?: File };

	let scope = $state<Scope | null>(null), active = $state<ArtifactSession | null>(null);
	let tick = $state(0), busy = $state(false), error = $state(''), errorDetail = $state<unknown>(null), progress = $state(''), importing = $state(false);
	let selectedId = $state(''), selectedObject = $state<string | null>(null);
	let note = $state(''), noteStatus = $state(''), notes = $state<Record<string, string>>({});
	let noteChain: Promise<void> = Promise.resolve();
	let stop = () => {}, unregisterNotes = () => {};
	let disposed = false, epoch = 0, previous: unknown;
	let importAbort = new AbortController();
	let imageInput = $state<HTMLInputElement>(), filmList = $state<HTMLOListElement>(), showStage = $state<HTMLDivElement>();
	let presented = $state<PresentedVersion>();
	let pendingOffice = $state<File | null>(null);
	let proposed = $state<Proposal | null>(null), previewOpen = $state(false);
	let channelId = $state(''), startOpen = $state(false), startPreview = $state<AudienceSlide[]>([]), startAspect = $state(16 / 9);
	let mode = $state<'edit' | 'present'>('edit');
	let show = $state<{ slides: AudienceSlide[]; index: number; blank: boolean; aspect: number }>({ slides: [], index: 0, blank: false, aspect: 16 / 9 });
	let notesOpen = $state(false), fullscreen = $state(false), idle = $state(false);
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let roomId = $state('');
	let presentAnchor = $state<HTMLElement | null>(null), presentOpen = $state(false);
	/** The stage width: below ROW_A_ROOM the Edit | Present segment moves into ⋯ as radio rows. */
	let stageWidth = $state(0);
	const ROW_A_ROOM = 1040;
	let slideMenuAnchor = $state<HTMLElement | null>(null), slideMenuOpen = $state(false), slideMenuId = $state('');

	const slides = $derived.by(() => { tick; return active ? readSlides(active.data) : []; });
	const current = $derived(slides.find((s) => s.id === selectedId) || slides[0] || null);
	const currentIndex = $derived(slides.findIndex((s) => s.id === current?.id));
	const aspect = $derived.by(() => { tick; return active ? Number(active.data.get('aspect') || 16 / 9) : 16 / 9; });
	const editable = $derived.by(() => { tick; return active?.editable || false; });
	const liveTitle = $derived.by(() => { tick; return active?.title || ''; });
	const visibleCount = $derived(slides.filter((s) => !s.hidden).length);
	const shown = $derived(show.slides[show.index] || null);
	const RATIOS = [{ value: '16:9', ratio: 16 / 9 }, { value: '4:3', ratio: 4 / 3 }, { value: '1:1', ratio: 1 }];
	const ratioKey = $derived(RATIOS.find((item) => Math.abs(item.ratio - aspect) < 0.001)?.value || '16:9');

	$effect(() => { if (current && current.id !== selectedId) select(current.id); });

	function select(id: string) {
		selectedObject = null;
		selectedId = id;
		note = notes[id] || '';
		noteStatus = '';
	}
	/** Our own sentences show; a browser or library failure is logged and the action's cause stands in. */
	function fail(e: unknown, cause: string) {
		errorDetail = e;
		error = e instanceof WorkspaceError || (e instanceof Error && e.constructor === Error) || !cause ? (e instanceof Error ? e.message : String(e)) : cause;
	}
	/** A quick edit on this device: no busy state, a notice only if it fails. */
	function attempt(fn: () => void, cause = "That change wasn't applied") {
		error = '';
		try { fn(); } catch (e) { fail(e, cause); }
	}
	/** Longer work. `label` shows as the busy notice ("Preparing the PDF…"). */
	async function run(fn: () => Promise<void>, cause: string, label = '') {
		busy = true; error = ''; progress = label;
		try { await fn(); }
		catch (e) { if (!disposed) fail(e, cause); }
		finally { if (!disposed) { busy = false; progress = ''; importing = false; } }
	}

	async function use(session: ArtifactSession) {
		const ticket = ++epoch;
		const valid = () => !disposed && !!scope?.isCurrent() && ticket === epoch;
		if (!valid()) { await session.close(); return; }
		await noteChain;
		if (!valid()) { await session.close(); return; }
		const savedNotes = await readPrivateNotes(session.scope, session.id);
		if (!valid()) { await session.close(); return; }
		const prior = active;
		if (prior && prior !== session && !(await prior.close())) { await session.close(); throw new Error('Save or export the current deck before closing it.'); }
		if (!valid()) { await session.close(); return; }
		stop();
		active = session;
		mode = 'edit';
		stop = session.state.subscribe((v) => { tick = v.tick; });
		notes = savedNotes;
		const first = readSlides(session.data)[0];
		if (first) select(first.id);
		roomId = session.record.presentationSession || '';
	}
	async function create() { if (scope) await use(await createArtifact(scope, 'present', 'Untitled presentation', (doc) => initialize(doc.getMap('data')))); }
	async function open(id: string, anchor?: string) {
		if (!scope) return;
		const session = await openArtifact(scope, id, 'present');
		await use(session);
		if (active !== session || !session.scope.isCurrent()) return;
		const target = resolveSlideSelection(session.data, anchor);
		if (target) { select(target.slideId); selectedObject = target.objectId; }
	}
	async function library() {
		await noteChain;
		if (active && !(await active.close())) throw new Error('Local save failed. Export recovery before leaving.');
		await endShow();
		stop();
		active = null;
	}
	function changeText(field: 'title' | 'body', text: string) {
		if (!active || !current || !editable) return;
		const value = collection(active.data).get(current.id)?.get(field);
		if (value instanceof Y.Text) editText(value, text, active.origin);
		else fail(new Error('This imported text field is not editable in the native format.'), '');
	}
	function set(field: string, value: unknown, id = current?.id) {
		if (!active || !id || !editable) return;
		const session = active;
		session.doc.transact(() => collection(session.data).get(id)?.set(field, value), session.origin);
	}
	function newSlide(duplicate = false, from = current) {
		if (!active || !editable) return;
		const session = active;
		session.doc.transact(() => { select(addSlide(session.data, duplicate && from ? from : { title: 'New slide', body: '', layout: 'text' }, from?.id)); }, session.origin);
		void focusFilm();
	}
	function move(direction: number, id = current?.id) {
		if (!active || !id || !editable) return;
		const session = active;
		session.doc.transact(() => moveSlide(session.data, id, direction), session.origin);
		void focusFilm();
	}
	function remove(id = current?.id) {
		if (!active || !id || !editable) return;
		if (slides.length <= 1) throw new Error('Keep at least one slide.');
		const at = slides.findIndex((s) => s.id === id);
		set('removed', true, id);
		const next = readSlides(active.data);
		const neighbour = next[Math.min(at, next.length - 1)];
		if (neighbour) select(neighbour.id);
		void focusFilm();
	}
	/** Keep keyboard focus on the current slide's thumbnail after it moves or changes. */
	async function focusFilm() {
		const hadFocus = !!filmList?.contains(document.activeElement);
		await settled();
		if (hadFocus) filmList?.querySelector<HTMLButtonElement>(`[data-slide="${CSS.escape(selectedId)}"]`)?.focus();
	}
	function filmKeys(event: KeyboardEvent, slide: DeckSlide, index: number) {
		const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
		if (step && event.altKey) { event.preventDefault(); attempt(() => move(step, slide.id), "Couldn't move the slide"); return; }
		if (step || event.key === 'Home' || event.key === 'End') {
			event.preventDefault();
			const target = event.key === 'Home' ? slides[0] : event.key === 'End' ? slides[slides.length - 1] : slides[index + step];
			if (target) { select(target.id); void settled().then(() => filmList?.querySelector<HTMLButtonElement>(`[data-slide="${CSS.escape(target.id)}"]`)?.focus()); }
			return;
		}
		if ((event.key === 'Delete' || event.key === 'Backspace') && editable) { event.preventDefault(); attempt(() => remove(slide.id), "Couldn't remove the slide"); return; }
		if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); slideMenuId = slide.id; slideMenuAnchor = event.currentTarget as HTMLElement; slideMenuOpen = true; }
	}
	function openSlideMenu(event: MouseEvent, id: string) {
		event.preventDefault();
		select(id);
		slideMenuId = id;
		slideMenuAnchor = event.currentTarget as HTMLElement;
		slideMenuOpen = true;
	}
	const slideMenuItems = $derived.by((): MenuEntry[] => {
		const slide = slides.find((s) => s.id === slideMenuId);
		if (!slide) return [];
		const index = slides.indexOf(slide);
		return [
			{ id: 'duplicate', label: 'Duplicate slide', icon: 'copy', disabled: !editable, onSelect: () => attempt(() => newSlide(true, slide), "Couldn't duplicate the slide") },
			{ id: 'up', label: 'Move up', icon: 'chevUp', shortcut: 'Alt ↑', disabled: !editable || index === 0, onSelect: () => attempt(() => move(-1, slide.id), "Couldn't move the slide") },
			{ id: 'down', label: 'Move down', icon: 'chevDown', shortcut: 'Alt ↓', disabled: !editable || index === slides.length - 1, onSelect: () => attempt(() => move(1, slide.id), "Couldn't move the slide") },
			{ id: 'hide', label: slide.hidden ? 'Show to audience' : 'Hide from audience', icon: slide.hidden ? 'eye' : 'eyeOff', disabled: !editable, onSelect: () => attempt(() => set('hidden', !slide.hidden, slide.id)) },
			{ id: 'sep', type: 'separator', label: '' },
			{ id: 'remove', label: 'Remove slide', icon: 'trash', danger: true, shortcut: 'Delete', disabled: !editable || slides.length <= 1, hint: slides.length <= 1 ? 'Keep at least one slide' : undefined, onSelect: () => attempt(() => remove(slide.id), "Couldn't remove the slide") }
		];
	});

	function saveNote(value: string) {
		if (!scope || !active || !current) return;
		const capturedScope = scope, id = active.id, slide = current.id;
		notes = { ...notes, [slide]: value };
		noteStatus = 'Saving…';
		noteChain = noteChain.catch(() => {}).then(() => savePrivateNote(capturedScope, id, slide, value));
		void noteChain
			.then(() => { if (active?.id === id && selectedId === slide) noteStatus = 'Saved on this device'; })
			.catch((e) => { noteStatus = 'Not saved'; fail(e, "Couldn't save the private note"); });
	}
	async function image(file: File) {
		if (!active || !current) return;
		const session = active, id = current.id;
		const value = await (await import('./files')).rasterImage(file, importAbort.signal);
		if (active !== session || !scope?.isCurrent()) return;
		session.doc.transact(() => collection(session.data).get(id)?.set('image', value), session.origin);
	}
	async function loadFile(file: File) {
		if (!scope) return;
		if (/\.(pptx|odp)$/i.test(file.name)) {
			if (file.size > 12 * 1024 * 1024) throw new Error('Presentation import is limited to 12 MB.');
			pendingOffice = file;
			return;
		}
		if (file.name.endsWith('.wabi.json')) {
			if (file.size > 24 * 1024 * 1024) throw new Error('This backup is larger than 24 MB, the most Present can open.');
			const value = JSON.parse(await file.text());
			if (value.schema !== 1 || value.kind !== 'present' || typeof value.update !== 'string') throw new Error('This is not a Wabi presentation backup.');
			const source = new Y.Doc();
			try {
				Y.applyUpdate(source, from64(value.update));
				const data = source.getMap('data');
				validateNative(data);
				await use(await createArtifact(scope, 'present', source.getText('title').toString(), (doc) => {
					const target = doc.getMap('data');
					target.set('schema', 1);
					target.set('aspect', data.get('aspect') || 16 / 9);
					target.set('slides', collection(data).clone());
				}, 'native', undefined, { name: file.name, type: file.type, blob: file }));
				if (value.privateNotes && typeof value.privateNotes === 'object' && active) {
					for (const [id, text] of Object.entries(value.privateNotes)) if (typeof text === 'string' && readSlides(active.data).some((s) => s.id === id)) await savePrivateNote(scope, active.id, id, text);
					notes = await readPrivateNotes(scope, active.id);
					select(selectedId);
				}
			} finally { source.destroy(); }
			return;
		}
		importAbort.abort();
		importAbort = new AbortController();
		importing = true;
		const sourceScope = scope;
		const signal = importAbort.signal;
		const result = await (await import('./files')).importSlides(file, signal, (text) => { if (!disposed && sourceScope?.isCurrent()) progress = text; });
		if (disposed || !sourceScope?.isCurrent() || signal.aborted) return;
		proposed = { title: file.name, ...result, source: file };
		previewOpen = true;
	}
	async function convertedOffice(pdf: File, warnings: string[], original: File) {
		const sourceScope = scope;
		importAbort.abort();
		importAbort = new AbortController();
		const signal = importAbort.signal;
		const result = await (await import('./files')).importSlides(pdf, signal, (text) => { if (!disposed && sourceScope?.isCurrent()) progress = text; });
		if (disposed || !sourceScope?.isCurrent() || signal.aborted) return;
		proposed = { title: original.name, ...result, warnings: [...warnings, ...result.warnings], source: original };
		pendingOffice = null;
		previewOpen = true;
	}
	async function confirmImport() {
		if (!scope || !proposed) return;
		const value = proposed;
		await use(await createArtifact(scope, 'present', value.title, (doc) => {
			const root = doc.getMap('data');
			root.set('schema', 1);
			root.set('aspect', value.aspect);
			root.set('slides', new Y.Map());
			for (const slide of value.slides) addSlide(root, slide);
		}, 'native', undefined, value.source ? { name: value.source.name, type: value.source.type, blob: value.source } : undefined));
		previewOpen = false;
		proposed = null;
	}
	function cancelImport() {
		if (busy) return;
		previewOpen = false;
		proposed = null;
	}
	function moveProposed(index: number, direction: number) {
		if (!proposed) return;
		const item = proposed.slides.splice(index, 1)[0];
		proposed.slides.splice(index + direction, 0, item);
	}
	function previewSource(source: { title: string; content: string }) {
		const generated = fromMarkdown(source.content, source.title);
		proposed = {
			title: source.title,
			aspect: 16 / 9,
			slides: generated.map((s) => ({ ...s, image: null })),
			warnings: ['Headings and explicit breaks proposed these slides. Your Reader document is unchanged.', 'Review text length and slide boundaries before creating the deck.']
		};
		previewOpen = true;
	}

	// ---------- Present: the local show in center stage ----------
	function startShow(from: 'first' | 'current' = 'first') {
		if (!active) return;
		const pinned = audienceSlides(active.data);
		if (!pinned.length) throw new Error('Unhide at least one slide before presenting.');
		const at = from === 'current' ? Math.max(0, pinned.findIndex((s) => s.id === current?.id)) : 0;
		show = { slides: pinned, index: at, blank: false, aspect };
		mode = 'present';
		wake();
		void settled().then(() => showStage?.focus());
	}
	async function endShow() {
		if (mode !== 'present') return;
		const at = shown;
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
		mode = 'edit';
		if (at && slides.some((s) => s.id === at.id)) select(at.id);
	}
	function go(index: number) {
		show.index = Math.max(0, Math.min(show.slides.length - 1, index));
	}
	async function toggleFullscreen() {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await showStage?.requestFullscreen();
		} catch {
			fail(new Error('Fullscreen was not allowed. The slide stays here in the stage.'), '');
		}
	}
	/** In fullscreen the transport fades after 2s without pointer movement. */
	function wake() {
		idle = false;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => { idle = true; }, 2000);
	}
	function showKeys(event: KeyboardEvent) {
		if (mode !== 'present' || previewOpen || startOpen || pendingOffice) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], dialog')) return;
		const onButton = target instanceof HTMLButtonElement;
		const key = event.key;
		if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(key) || (key === ' ' && !onButton)) { event.preventDefault(); go(show.index + 1); }
		else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(key)) { event.preventDefault(); go(show.index - 1); }
		else if (key === 'Home') { event.preventDefault(); go(0); }
		else if (key === 'End') { event.preventDefault(); go(show.slides.length - 1); }
		else if ((key === 'b' || key === 'B' || key === '.') && !event.ctrlKey && !event.metaKey) { event.preventDefault(); show.blank = !show.blank; }
		else if ((key === 'f' || key === 'F') && !event.ctrlKey && !event.metaKey) { event.preventDefault(); void toggleFullscreen(); }
		else if (key === 'Escape' && !document.fullscreenElement) { event.preventDefault(); void endShow(); }
	}

	// ---------- Present to channel ----------
	function prepareStartRoom() {
		if (!active || !active.scope.isCurrent()) throw new Error('The account or server changed. Nothing was published.');
		startPreview = audienceSlides(active.data);
		if (!startPreview.length) throw new Error('Unhide at least one slide before presenting.');
		startAspect = aspect;
		channelId = '';
		startOpen = true;
	}
	async function startRoom() {
		if (!scope || !active) return;
		const session = active, targetChannel = channelId, approved = editionFingerprint(startPreview, startAspect);
		if (approved !== editionFingerprint(audienceSlides(session.data), aspect)) throw new Error('The deck changed after the preview. Cancel and preview it again before starting.');
		const valid = () => !disposed && active === session && session.scope.isCurrent();
		await session.flush();
		if (!valid()) return;
		await session.publish(session.record.meta?.mode || 'snapshot');
		if (!valid()) return;
		if (approved !== editionFingerprint(audienceSlides(session.data), Number(session.data.get('aspect') || 16 / 9))) throw new Error('The deck changed while preparing the presentation. Review the new preview and start again.');
		const state = await request<AudienceState>(session.scope, '/presentations', { id: crypto.randomUUID(), artifactId: session.id, channelId: targetChannel || null, sourceSequence: session.record.meta!.sequence });
		if (!valid()) return;
		roomId = state.id;
		await session.rememberPresentation(state.id);
		if (!valid()) return;
		startOpen = false;
		openWorkspace('audience', { sessionId: state.id });
	}
	async function copyRoomLink() {
		if (!active || !roomId) return;
		await navigator.clipboard.writeText(presentationLink(active.scope.server, roomId));
		toast('Presentation link copied. It opens only for people who can see the deck.', { tone: 'info', timeout: 6000 });
	}

	// ---------- Exports (⋯ Export) ----------
	async function exportPptx() {
		const session = active;
		if (!session) return;
		const title = session.title, visible = audienceSlides(session.data), ratio = aspect;
		const files = await import('./files');
		if (disposed || active !== session || !session.scope.isCurrent()) return;
		await files.exportPptx(title, visible, ratio);
		toast('PPTX subset exported: visible slides only, without speaker notes.', { tone: 'info', timeout: 7000 });
	}
	async function printPdf() {
		const session = active;
		if (!session) return;
		const title = session.title, visible = audienceSlides(session.data), ratio = aspect;
		const files = await import('./files');
		if (disposed || active !== session || !session.scope.isCurrent()) return;
		files.printAudience(title, visible, ratio);
	}
	function exportPrivate() {
		if (!active) return;
		const data = JSON.parse(active.recovery());
		data.privateNotes = notes;
		download(`${active.title}.private.wabi.json`, JSON.stringify(data, null, 2));
		toast('Private notes backup saved. It contains your speaker notes: keep it private.', { tone: 'info', timeout: 7000 });
	}
	const exports = $derived.by((): MenuEntry[] => [
		{ id: 'pptx', label: 'PPTX subset (.pptx)', icon: 'download', hint: 'Visible slides · no speaker notes', onSelect: () => void run(exportPptx, "Couldn't export the PPTX", 'Preparing the PPTX…') },
		{ id: 'pdf', label: 'Audience PDF', icon: 'download', hint: 'Visible slides · through the print dialog', onSelect: () => void run(printPdf, "Couldn't open the print view") },
		{ id: 'notes', label: 'Private notes backup (.json)', icon: 'download', hint: 'Your speaker notes · keep it private', onSelect: () => attempt(exportPrivate, "Couldn't save the notes backup") }
	]);

	// ---------- Row A ----------
	const modes = $derived<OfficeHeaderModes>({
		label: 'Presentation mode',
		options: [{ value: 'edit', label: 'Edit' }, { value: 'present', label: 'Present' }],
		value: mode,
		onchange: (value: string) => { if (value === 'present') attempt(() => startShow('first'), "Couldn't start presenting"); else void endShow(); }
	});
	const waysToPresent = $derived.by((): MenuEntry[] => [
		{ id: 'local', label: 'Present locally', icon: 'play', hint: 'On this screen · nothing is shared', onSelect: () => attempt(() => startShow('first'), "Couldn't start presenting") },
		{ id: 'here', label: 'Present from this slide', icon: 'present', disabled: !current || current.hidden, onSelect: () => attempt(() => startShow('current'), "Couldn't start presenting") },
		{ id: 'channel', label: 'Present to channel…', icon: 'users', hint: 'Publishes the visible slides to this server', disabled: busy, onSelect: () => attempt(prepareStartRoom, "Couldn't prepare the presentation") },
		...(roomId
			? [
					{ id: 'k-room', type: 'kicker', label: 'Room started from this deck' } satisfies MenuEntry,
					{ id: 'room', label: 'Open room view', icon: 'externalLink', onSelect: () => openWorkspace('audience', { sessionId: roomId }) } satisfies MenuEntry,
					{ id: 'room-link', label: 'Copy presentation link', icon: 'link', onSelect: () => void run(copyRoomLink, "Couldn't copy the link") } satisfies MenuEntry,
					{ id: 'room-update', label: 'Update presented version…', icon: 'upload', hint: 'Review before the audience sees it', disabled: busy, onSelect: () => void presented?.prepare() } satisfies MenuEntry
				]
			: [])
	]);
	const presentActions = $derived.by((): StageHeaderAction[] => [{
		id: 'present',
		label: 'Present',
		icon: 'play',
		variant: 'primary',
		// A phone has no room for the split: Present plays; the other ways are first in ⋯.
		iconOnly: $isMobile,
		disabled: !visibleCount,
		onSelect: () => { if (mode === 'present') void toggleFullscreen(); else attempt(() => startShow('first'), "Couldn't start presenting"); },
		menu: { label: 'Ways to present', onSelect: (anchor) => { presentAnchor = anchor; presentOpen = !presentOpen; } }
	}]);
	// Row A keeps the title readable: on a narrow stage (a pinned panel, a laptop) the mode
	// segment steps into ⋯ as radio rows; on a phone the ways to present come first there too.
	const rowAModes = $derived(stageWidth >= ROW_A_ROOM || $isMobile ? modes : null);
	const phoneTools = $derived.by((): MenuEntry[] => [
		...($isMobile ? [{ id: 'k-present', type: 'kicker', label: 'Present' } satisfies MenuEntry, ...waysToPresent.filter((item) => item.id !== 'local'), { id: 'sep-present', type: 'separator', label: '' } satisfies MenuEntry] : []),
		...(!rowAModes
			? [
					{ id: 'k-mode', type: 'kicker', label: modes.label } satisfies MenuEntry,
					...modes.options.map((option) => ({ id: `mode-${option.value}`, label: option.label, role: 'menuitemradio', checked: modes.value === option.value, onSelect: () => modes.onchange(option.value) }) satisfies MenuEntry),
					{ id: 'sep-mode', type: 'separator', label: '' } satisfies MenuEntry
				]
			: [])
	]);

	onMount(() => {
		let unsubscribe = () => {};
		unregisterNotes = registerWorkspaceDisposer('present', () => noteChain);
		const onFullscreen = () => { fullscreen = !!document.fullscreenElement && document.fullscreenElement === showStage; };
		document.addEventListener('fullscreenchange', onFullscreen);
		void run(async () => {
			scope = await captureScope();
			unsubscribe = targets.subscribe((value) => {
				if (value.present && value.present !== previous) {
					previous = value.present;
					const target = value.present;
					if (target.id) void run(() => open(target.id!, target.anchor), "Couldn't open the presentation");
					else if (target.source) previewSource(target.source);
				}
			});
		}, "Couldn't open Present");
		return () => { unsubscribe(); document.removeEventListener('fullscreenchange', onFullscreen); };
	});
	onDestroy(() => {
		disposed = true;
		epoch++;
		stop();
		unregisterNotes();
		importAbort.abort();
		if (idleTimer) clearTimeout(idleTimer);
		if (active) void active.close();
	});
</script>

<svelte:window onkeydown={showKeys} />

{#snippet failure()}
	{#if error}
		<Notice class="present-notice" title={error} text={active ? 'Your deck is still here on this device.' : 'Nothing was changed.'} error={errorDetail} ondismiss={() => (error = '')} />
	{/if}
	{#if busy && progress}
		<Notice class="present-notice" tone="info" title={progress} text={importing ? 'Nothing is uploaded while the file is read.' : 'This takes a moment.'}>
			{#snippet actions()}
				{#if importing}<button type="button" class="w-btn w-btn--sm" onclick={() => importAbort.abort()}>Cancel import</button>{/if}
			{/snippet}
		</Notice>
	{/if}
{/snippet}

{#snippet slideFields()}
	{#if current}
		<label class="present-field">
			<span class="w-label">Layout</span>
			<span class="w-field">
				<select aria-label="Slide layout" disabled={!editable} value={current.layout} onchange={(event) => attempt(() => set('layout', event.currentTarget.value))}>
					<option value="title">Title</option><option value="text">Text</option><option value="split">Text and image</option><option value="image">Full image</option><option value="quote">Quotation</option>
					{#if current.design}<option value="canvas">Canvas</option>{/if}
				</select>
			</span>
		</label>
		{#if current.layout !== 'canvas'}
			<label class="present-field">
				<span class="w-label">Title</span>
				<input class="w-field" aria-label="Slide title" value={current.title} maxlength="2000" disabled={!editable} oninput={(event) => changeText('title', event.currentTarget.value)} />
			</label>
			<label class="present-field">
				<span class="w-label">Text</span>
				<textarea class="w-field present-area" aria-label="Slide text" value={current.body} maxlength="16000" disabled={!editable} oninput={(event) => changeText('body', event.currentTarget.value)}></textarea>
			</label>
			<div class="present-field">
				<span class="w-label" id="present-image-label">Image</span>
				<div class="present-row" role="group" aria-labelledby="present-image-label">
					<button type="button" class="w-btn w-btn--sm" disabled={!editable || busy} onclick={() => imageInput?.click()}><Icon name="image" size={16} />{current.image ? 'Replace image…' : 'Add image…'}</button>
					{#if current.image}<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={!editable} onclick={() => attempt(() => set('image', null))}>Remove image</button>{/if}
				</div>
			</div>
		{:else}
			<p class="present-hint present-hint--lead">A canvas slide shows its objects only. Select one on the slide to edit it.</p>
		{/if}
	{/if}
{/snippet}

{#snippet slideFooter()}
	{#if current}
		<section class="present-inspector__group" aria-label="Audience">
			<div class="present-switch">
				<span class="present-switch__label" id="present-visible-label">Visible to audience</span>
				<Switch labelledby="present-visible-label" describedby="present-visible-hint" checked={!current.hidden} disabled={!editable} onchange={(on) => attempt(() => set('hidden', !on))} />
			</div>
			<p class="present-hint" id="present-visible-hint">Hidden slides stay in the deck but never reach the room, the PDF or the PPTX.</p>
		</section>
		<section class="present-inspector__group" aria-labelledby="present-deck-kicker">
			<h3 class="w-kicker present-inspector__kicker" id="present-deck-kicker">Deck</h3>
			<Segmented
				label="Slide ratio"
				value={ratioKey}
				disabled={!editable}
				options={RATIOS.map((item) => ({ value: item.value, label: item.value === '1:1' ? 'Square' : item.value }))}
				onchange={(value) => attempt(() => { const session = active!, ratio = RATIOS.find((item) => item.value === value)?.ratio || 16 / 9; session.doc.transact(() => session.data.set('aspect', ratio), session.origin); })}
			/>
		</section>
	{/if}
{/snippet}

{#snippet speakerNotes()}
	<section class="present-notes" aria-labelledby="present-notes-title">
		<div class="present-notes__head">
			<h3 class="w-kicker present-notes__title" id="present-notes-title">Speaker notes</h3>
			<span class="w-tag present-notes__scope" title="Never in the room, the shared deck or the exports">Private · this device</span>
			<span class="present-notes__status" role="status">{noteStatus}</span>
		</div>
		<textarea class="present-notes__field" aria-label="Private speaker notes" placeholder="What you want to remember on this slide…" bind:value={note} maxlength="32000" oninput={(event) => saveNote(event.currentTarget.value)}></textarea>
	</section>
{/snippet}

{#if scope && pendingOffice}
	<OfficeConversion {scope} file={pendingOffice} onconverted={convertedOffice} oncancel={() => { importAbort.abort(); pendingOffice = null; }} />
{/if}

{#if scope && active}
	{#key active.id}
		<ArtifactShell
			session={active}
			selectionAnchor={current ? (selectedObject ? objectAnchor(current.id, selectedObject, 'Slide object') : slideAnchor(current.id, current.title)) : null}
			onlibrary={() => void run(library, "Couldn't close the deck")}
			modes={rowAModes}
			{exports}
			actions={presentActions}
			tools={phoneTools}
		>
			<div class="present" data-mode={mode} bind:clientWidth={stageWidth}>
				{@render failure()}
				{#if roomId && mode === 'edit'}
					<div class="present-live" role="status">
						<span class="w-dot w-dot--online" aria-hidden="true"></span>
						<span class="present-live__text">A room was started from this deck. Its audience sees the revision you approved.</span>
						<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => openWorkspace('audience', { sessionId: roomId })}>Open room</button>
						<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={busy} onclick={() => void presented?.prepare()}>Update presented version…</button>
					</div>
				{/if}
				{#if mode === 'present'}
					<div class="present-show" class:present-show--notes={notesOpen}>
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div class="present-show__stage" class:present-show__stage--idle={fullscreen && idle} bind:this={showStage} tabindex="-1" role="region" aria-label="Presentation" onpointermove={wake}>
							<div class="present-show__fit">
								<div class="present-show__frame" style:--present-ratio={show.aspect}>
									<AudienceSlideView slide={shown} aspect={show.aspect} blank={show.blank} />
								</div>
							</div>
							<div class="w-tool present-transport" role="toolbar" aria-label="Presentation controls">
								<Tooltip text="Previous slide" shortcut="←" placement="top"><button type="button" class="w-ibtn" aria-label="Previous slide" disabled={show.index <= 0} onclick={() => go(show.index - 1)}><Icon name="chevLeft" /></button></Tooltip>
								<span class="present-transport__count">{show.index + 1} / {show.slides.length}</span>
								<Tooltip text="Next slide" shortcut="→" placement="top"><button type="button" class="w-ibtn" aria-label="Next slide" disabled={show.index >= show.slides.length - 1} onclick={() => go(show.index + 1)}><Icon name="chevRight" /></button></Tooltip>
								<span class="w-tool__sep" aria-hidden="true"></span>
								<Tooltip text="Blank screen" shortcut="B" placement="top"><button type="button" class="w-ibtn" aria-label="Blank screen" aria-pressed={show.blank} onclick={() => (show.blank = !show.blank)}><Icon name="eyeOff" /></button></Tooltip>
								{#if !fullscreen}
									<Tooltip text="Speaker notes, on this screen only" placement="top"><button type="button" class="w-ibtn" aria-label="Speaker notes" aria-pressed={notesOpen} onclick={() => (notesOpen = !notesOpen)}><Icon name="note" /></button></Tooltip>
								{/if}
								<Tooltip text={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} shortcut="F" placement="top"><button type="button" class="w-ibtn" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onclick={() => void toggleFullscreen()}><Icon name={fullscreen ? 'collapse' : 'expand'} /></button></Tooltip>
								<span class="w-tool__sep" aria-hidden="true"></span>
								<button type="button" class="w-btn w-btn--sm present-transport__end" onclick={() => void endShow()}>End<kbd class="w-kbd">Esc</kbd></button>
							</div>
						</div>
						{#if notesOpen && !fullscreen}
							{@const upcoming = show.slides[show.index + 1]}
							<aside class="present-show__notes" aria-label="Speaker notes">
								<div class="present-notes__head">
									<h3 class="w-kicker present-notes__title">Speaker notes</h3>
									<span class="w-tag present-notes__scope" title="Only on this screen, never in fullscreen or the room">Private · this screen</span>
								</div>
								<p class="present-show__note" class:present-show__note--empty={!shown || !notes[shown.id]}>{shown && notes[shown.id] ? notes[shown.id] : 'No notes for this slide.'}</p>
								{#if upcoming}
									<h3 class="w-kicker present-notes__title">Next</h3>
									<div class="present-show__next" aria-hidden="true"><AudienceSlideView slide={upcoming} aspect={show.aspect} /></div>
									<p class="present-show__next-title">{upcoming.title || 'Untitled slide'}</p>
								{:else}
									<p class="present-show__note present-show__note--empty">This is the last slide.</p>
								{/if}
							</aside>
						{/if}
						<p class="sr-only" aria-live="polite">{show.blank ? 'Screen blanked' : `Slide ${show.index + 1} of ${show.slides.length}${shown?.title ? `: ${shown.title}` : ''}`}</p>
					</div>
				{:else}
					<div class="present-edit">
						<aside class="present-film" aria-label="Slides">
							<ol class="present-film__list" bind:this={filmList}>
								{#each slides as slide, index (slide.id)}
									<li class="present-film__item" class:present-film__item--hidden={slide.hidden} class:present-film__item--current={slide.id === current?.id}>
										<span class="present-film__num" aria-hidden="true">{index + 1}</span>
										<div class="present-film__card" class:present-film__card--current={slide.id === current?.id}>
											<span class="present-film__frame" aria-hidden="true"><AudienceSlideView {slide} {aspect} /></span>
											{#if slide.hidden}<span class="present-film__flag" aria-hidden="true"><Icon name="eyeOff" size={14} /></span>{/if}
											<button
												type="button"
												class="present-film__hit"
												data-slide={slide.id}
												aria-label={`Slide ${index + 1}: ${slide.title || 'Untitled slide'}${slide.hidden ? ', hidden from audience' : ''}`}
												aria-current={slide.id === current?.id ? 'true' : undefined}
												aria-keyshortcuts="ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown Delete"
												tabindex={slide.id === current?.id ? 0 : -1}
												onclick={() => select(slide.id)}
												oncontextmenu={(event) => openSlideMenu(event, slide.id)}
												onkeydown={(event) => filmKeys(event, slide, index)}
											></button>
										</div>
									</li>
								{/each}
							</ol>
							<button type="button" class="w-btn w-btn--quiet w-btn--sm present-film__add" disabled={!editable} onclick={() => attempt(() => newSlide(), "Couldn't add a slide")}><Icon name="plus" size={16} />Add slide</button>
						</aside>
						{#if current}
							<NativeSlideDesigner
								session={active}
								slide={current}
								{aspect}
								selectedObjectId={selectedObject}
								onselect={(id) => (selectedObject = id)}
								onerror={fail}
								{slideFields}
								{slideFooter}
								below={speakerNotes}
							/>
						{/if}
					</div>
				{/if}
			</div>
			<input class="workspace-file-input" type="file" accept="image/png,image/jpeg,image/webp" bind:this={imageInput} onchange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void run(() => image(file), "Couldn't use that image", 'Preparing the image…'); }} />
		</ArtifactShell>
		<Menu label="Ways to present" anchor={presentAnchor} bind:open={presentOpen} items={waysToPresent} align="end" heading={liveTitle} />
		<Menu label="Slide actions" anchor={slideMenuAnchor} bind:open={slideMenuOpen} items={slideMenuItems} heading={slides.find((s) => s.id === slideMenuId)?.title || 'Slide'} />
		{#if roomId}<PresentedVersion bind:this={presented} session={active} {roomId} onerror={fail} />{/if}
	{/key}
{:else if scope}
	<section class="wabi-workspace present-home">
		{@render failure()}
		<ArtifactLibrary {scope} kind="present" label="Present" onopen={(id) => void run(() => open(id), "Couldn't open the presentation")} onnew={() => void run(create, "Couldn't create a presentation")} onimport={(file) => void run(() => loadFile(file), "Couldn't read that file", 'Reading the file…')} accept=".pdf,.png,.jpg,.jpeg,.webp,.pptx,.odp,.wabi.json" />
	</section>
{:else}
	<section class="wabi-workspace present-home">{@render failure()}</section>
{/if}

<BaseModal isOpen={previewOpen} onClose={cancelImport} size="lg" padded title="Create a private presentation" note="Nothing is uploaded">
	<div class="present-dialog">
		{#if error && previewOpen}<Notice title={error} text="Nothing was created." error={errorDetail} />{/if}
		{#if proposed}
			<label class="present-field">
				<span class="w-label">Deck title</span>
				<input class="w-field" aria-label="Proposed deck title" bind:value={proposed.title} maxlength="200" disabled={busy} />
			</label>
			<p class="present-dialog__truth">{proposed.slides.length} proposed {proposed.slides.length === 1 ? 'slide' : 'slides'}. Edit the text and order here; confirming creates a separate private deck on this device.</p>
			{#if proposed.warnings.length}
				<ul class="present-dialog__notes">
					{#each proposed.warnings as warning, index (index)}<li><Icon name="info" size={16} />{warning}</li>{/each}
				</ul>
			{/if}
			<ol class="present-proposal">
				{#each proposed.slides as slide, i (i)}
					<li class="present-proposal__item">
						<span class="present-proposal__thumb" aria-hidden="true"><AudienceSlideView slide={{ ...slide, id: String(i) }} aspect={proposed.aspect} /></span>
						<div class="present-proposal__fields">
							<span class="present-proposal__num">Slide {i + 1}</span>
							<input class="w-field" aria-label={`Proposed slide ${i + 1} title`} bind:value={slide.title} maxlength="2000" disabled={busy} />
							<textarea class="w-field present-area present-area--short" aria-label={`Proposed slide ${i + 1} text`} bind:value={slide.body} maxlength="16000" disabled={busy}></textarea>
						</div>
						<div class="present-proposal__actions">
							<Tooltip text="Move earlier" placement="left"><button type="button" class="w-ibtn w-ibtn--sm" aria-label="Move earlier" disabled={busy || i === 0} onclick={() => moveProposed(i, -1)}><Icon name="chevUp" /></button></Tooltip>
							<Tooltip text="Move later" placement="left"><button type="button" class="w-ibtn w-ibtn--sm" aria-label="Move later" disabled={busy || i === proposed.slides.length - 1} onclick={() => moveProposed(i, 1)}><Icon name="chevDown" /></button></Tooltip>
							<Tooltip text="Remove proposed slide" placement="left"><button type="button" class="w-ibtn w-ibtn--sm" aria-label="Remove proposed slide" disabled={busy || proposed.slides.length <= 1} onclick={() => proposed?.slides.splice(i, 1)}><Icon name="trash" /></button></Tooltip>
						</div>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" disabled={busy} onclick={cancelImport}>Cancel</button>
		<button type="button" class="w-btn w-btn--primary" disabled={busy || !proposed?.slides.length} onclick={() => void run(confirmImport, "Couldn't create the deck")}>Create private deck</button>
	</div>
</BaseModal>

<BaseModal isOpen={startOpen} onClose={() => { if (!busy) startOpen = false; }} size="lg" padded title="Present to a channel" note={liveTitle}>
	<div class="present-dialog">
		<p class="present-dialog__truth">This uploads the native deck to your Wabi server under its existing access rules, then publishes only the visible slides to the audience. <strong>The server operator can read uploaded slides.</strong> Speaker notes stay on this device.</p>
		{#if error && startOpen}<Notice title={error} text="Nothing was published." error={errorDetail} />{/if}
		<label class="present-field">
			<span class="w-label">Audience channel</span>
			<span class="w-field">
				<select aria-label="Audience channel" bind:value={channelId} disabled={busy}>
					<option value="">Only people who can already read the deck</option>
					{#each $channels as channel (channel.id)}<option value={channel.id}>{channel.name}</option>{/each}
				</select>
			</span>
		</label>
		<p class="present-dialog__count">{startPreview.length} visible {startPreview.length === 1 ? 'slide' : 'slides'} will be published. Hidden slides are left out of what the audience receives.</p>
		<ol class="present-thumbs" aria-label="Slides the audience will see">
			{#each startPreview as slide, index (slide.id)}
				<li class="present-thumbs__item">
					<span class="present-thumbs__frame" aria-hidden="true"><AudienceSlideView {slide} aspect={startAspect} /></span>
					<span class="present-thumbs__caption"><span class="present-thumbs__num">{index + 1}</span>{slide.title || 'Untitled slide'}</span>
				</li>
			{/each}
		</ol>
	</div>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" disabled={busy} onclick={() => (startOpen = false)}>Cancel</button>
		<button type="button" class="w-btn w-btn--primary" disabled={busy} onclick={() => void run(startRoom, "Couldn't start the presentation", 'Publishing the approved slides…')}>Start approved presentation</button>
	</div>
</BaseModal>
