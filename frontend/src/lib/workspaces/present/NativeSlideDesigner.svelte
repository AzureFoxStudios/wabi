<!--
	The Present designer's middle and right columns for one slide (design contract §8.8):

	- the pasteboard: the slide centred on --w-sink, sized to fit (width from the height and the
	  ratio, never a magic offset), with an "Add to slide" tool row above canvas slides and the
	  parent's speaker notes below (`below`);
	- the 272px inspector: a Slide | Object segment. Slide holds the parent's slide fields, this
	  slide's canvas theme and layout presets, then the parent's footer (visibility, ratio). Object
	  edits the selected canvas object: position and size in percent, type, colour, fill,
	  alignment, its text or data, image fit and crop, and an Arrange menu.

	The component renders two root elements so they sit straight in the parent's grid. Canvas
	objects are moved by drag or the arrow keys (Shift: 5%), resized by the corner grip or
	Alt + arrows, removed with Delete. Edits to a slide that is not a canvas never show here:
	canvas slides draw only their objects, so the title, text and image fields stay hidden for
	them (their stored values are kept).
-->
<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import AudienceSlideView from '../AudienceSlide.svelte';
	import type { ArtifactSession } from '../session';
	import type { DeckSlide } from './model';
	import type { SceneObject, SceneKind, SceneTheme } from '../scene';
	import { readDesign, presetDesign, setDesign, addSceneObject, patchSceneObject, removeSceneObject, setSceneTheme, type ScenePreset } from './nativeScene';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';

	interface Props {
		session: ArtifactSession;
		slide: DeckSlide;
		aspect: number;
		selectedObjectId?: string | null;
		onselect?: (id: string | null) => void;
		/** Our own sentences show; anything else is logged and `cause` stands in. */
		onerror?: (error: unknown, cause: string) => void;
		/** Slide fields from the deck (layout, title, text, image). */
		slideFields: Snippet;
		/** Deck-level fields after the canvas section (visibility, ratio). */
		slideFooter: Snippet;
		/** Under the slide on the pasteboard (the private speaker notes). */
		below?: Snippet;
	}
	let { session, slide, aspect, selectedObjectId = null, onselect = () => {}, onerror = () => {}, slideFields, slideFooter, below }: Props = $props();

	let tick = $state(0), selected = $state(''), busy = $state(false), preset = $state<ScenePreset>('body');
	let tab = $state<'slide' | 'object'>('slide');
	let stage = $state<HTMLDivElement>(), imageInput = $state<HTMLInputElement>(), arrangeAnchor = $state<HTMLElement | null>(null), arrangeOpen = $state(false);
	let resizing = $state<{ id: string; w: number; h: number } | null>(null);
	const abort = new AbortController();
	let disposed = false;

	const design = $derived.by(() => { tick; try { return slide.layout === 'canvas' ? readDesign(session.data, slide.id) : null; } catch { return null; } });
	const chosen = $derived(design?.objects.find((object) => object.id === selected) || null);
	const editable = $derived.by(() => { tick; return session.editable && !session.isClosed; });
	const ratio = $derived(Number.isFinite(aspect) ? Math.max(0.5, Math.min(3, aspect)) : 16 / 9);

	$effect(() => { if (selectedObjectId && design?.objects.some((object) => object.id === selectedObjectId)) { selected = selectedObjectId; tab = 'object'; } });
	$effect(() => session.state.subscribe((value) => (tick = value.tick)));
	$effect(() => { if (selected && !design?.objects.some((object) => object.id === selected)) { selected = ''; onselect(null); } });
	$effect(() => { if (!design && tab === 'object') tab = 'slide'; });
	onDestroy(() => { disposed = true; abort.abort(); });

	const KINDS: { kind: SceneKind; label: string; icon: IconName }[] = [
		{ kind: 'text', label: 'Add text', icon: 'type' },
		{ kind: 'image', label: 'Add image', icon: 'image' },
		{ kind: 'rect', label: 'Add rectangle', icon: 'shapeRect' },
		{ kind: 'ellipse', label: 'Add ellipse', icon: 'shapeEllipse' },
		{ kind: 'line', label: 'Add line', icon: 'shapeLine' },
		{ kind: 'table', label: 'Add table', icon: 'table' },
		{ kind: 'chart', label: 'Add chart', icon: 'chart' }
	];
	const KIND_NAME: Record<SceneKind, string> = { text: 'Text', image: 'Image', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', table: 'Table', chart: 'Chart' };
	const CONTENT: Partial<Record<SceneKind, { label: string; hint?: string }>> = {
		text: { label: 'Text' },
		image: { label: 'Image description', hint: 'Read aloud by screen readers in the room.' },
		line: { label: 'Description', hint: 'Read aloud by screen readers in the room.' },
		table: { label: 'Table data', hint: 'One row per line, columns separated by tabs. Up to 20 rows and 8 columns.' },
		chart: { label: 'Chart data', hint: 'One bar per line: a label, a tab, then a number.' }
	};
	const PRESETS: { value: ScenePreset; label: string }[] = [
		{ value: 'blank', label: 'Blank' },
		{ value: 'title', label: 'Title' },
		{ value: 'body', label: 'Title and body' },
		{ value: 'caption', label: 'Image and caption' },
		{ value: 'comparison', label: 'Two-column comparison' },
		{ value: 'grid', label: 'Image grid' },
		{ value: 'table', label: 'Table' },
		{ value: 'chart', label: 'Pinned chart' }
	];

	function choose(id: string) { selected = id; tab = 'object'; onselect(id); }
	function run(fn: () => void, cause = "That change wasn't applied") {
		try { if (!session.scope.isCurrent()) throw new Error('The account or server changed. Nothing was changed.'); fn(); }
		catch (e) { onerror(e, cause); }
	}
	function apply() {
		run(() => {
			if (!editable) return;
			session.doc.transact(() => setDesign(session.data, slide.id, presetDesign(preset, slide.title, slide.body, design?.theme || 'paper')), session.origin);
			selected = ''; tab = 'slide'; onselect(null);
		}, "Couldn't apply that layout");
	}
	function add(kind: SceneKind) { run(() => choose(addSceneObject(session, slide.id, kind)), "Couldn't add that to the slide"); }
	function patch(value: Partial<SceneObject>) { const object = chosen; if (object) run(() => patchSceneObject(session, slide.id, object.id, value)); }
	function number(field: 'x' | 'y' | 'w' | 'h' | 'fontSize' | 'cropX' | 'cropY', value: number) {
		if (!chosen || !Number.isFinite(value)) return;
		const limit = field === 'x' ? 1 - chosen.w : field === 'y' ? 1 - chosen.h : field === 'w' ? 1 - chosen.x : field === 'h' ? 1 - chosen.y : field === 'fontSize' ? 72 : 1;
		const min = field === 'w' || field === 'h' ? 0.02 : field === 'fontSize' ? 12 : 0;
		patch({ [field]: Math.max(min, Math.min(limit, value)) });
	}
	/** Position and size show as whole percent; the model keeps fractions of the slide. */
	const percent = (value: number) => Math.round(value * 1000) / 10;
	async function image(file: File) {
		if (!chosen || busy || !editable) return;
		const id = chosen.id, slideId = slide.id, captured = session;
		busy = true;
		try {
			const value = await (await import('./files')).rasterImage(file, abort.signal);
			if (disposed || session !== captured || !captured.scope.isCurrent() || slide.id !== slideId) return;
			patchSceneObject(captured, slideId, id, { image: value });
		} catch (e) { if (!disposed) onerror(e, "Couldn't use that image"); }
		finally { if (!disposed) busy = false; }
	}
	async function finishCrop() {
		if (!chosen || busy || !editable) return;
		const object = { ...chosen }, id = slide.id, captured = session, shape = aspect;
		busy = true;
		try {
			const image = await (await import('./finalizeCrop')).finalizeCrop(object, shape, abort.signal);
			if (disposed || session !== captured || !captured.scope.isCurrent() || slide.id !== id) return;
			const latest = readDesign(captured.data, id)?.objects.find((item) => item.id === object.id);
			if (!latest || JSON.stringify(latest) !== JSON.stringify(object)) throw new Error('The image changed while cropping. Review the latest object and try again.');
			patchSceneObject(captured, id, object.id, { image, fit: 'contain', cropX: 0.5, cropY: 0.5 });
		} catch (e) { if (!disposed) onerror(e, "Couldn't finalize the crop"); }
		finally { if (!disposed) busy = false; }
	}

	/** Arrows move the focused object (Shift: 5%), Alt + arrows resize it, Delete removes it. */
	function keys(event: KeyboardEvent, object: SceneObject) {
		if (!editable) return;
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			run(() => removeSceneObject(session, slide.id, object.id));
			return;
		}
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
		event.preventDefault();
		const step = event.shiftKey ? 0.05 : 0.01;
		const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
		const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
		if (event.altKey) {
			run(() => patchSceneObject(session, slide.id, object.id, { w: Math.max(0.02, Math.min(1 - object.x, object.w + dx)), h: Math.max(0.02, Math.min(1 - object.y, object.h + dy)) }));
			return;
		}
		run(() => patchSceneObject(session, slide.id, object.id, { x: Math.max(0, Math.min(1 - object.w, object.x + dx)), y: Math.max(0, Math.min(1 - object.h, object.y + dy)) }));
	}

	let drag: { id: string; slideId: string; x: number; y: number; px: number; py: number; width: number; height: number; target: HTMLElement; pointer: number } | null = null;
	function startDrag(event: PointerEvent, object: SceneObject) {
		choose(object.id);
		if (!editable || event.button !== 0 || !stage) return;
		const rect = stage.getBoundingClientRect();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		drag = { id: object.id, slideId: slide.id, x: object.x, y: object.y, px: event.clientX, py: event.clientY, width: rect.width, height: rect.height, target, pointer: event.pointerId };
	}
	function dragMove(event: PointerEvent) {
		if (drag && event.pointerId === drag.pointer) drag.target.style.transform = `translate(${event.clientX - drag.px}px,${event.clientY - drag.py}px)`;
	}
	function finishDrag(event: PointerEvent, cancel = false) {
		const previous = drag;
		drag = null;
		if (!previous) return;
		previous.target.style.transform = '';
		if (previous.target.hasPointerCapture(previous.pointer)) previous.target.releasePointerCapture(previous.pointer);
		if (cancel || previous.slideId !== slide.id || !session.scope.isCurrent()) return;
		const current = design?.objects.find((o) => o.id === previous.id);
		if (!current) return;
		if (current.x !== previous.x || current.y !== previous.y) {
			onerror(new Error('Another editor moved this object. Your drag was not applied over their move; try from its new position.'), '');
			return;
		}
		run(() => patchSceneObject(session, slide.id, current.id, {
			x: Math.max(0, Math.min(1 - current.w, current.x + (event.clientX - previous.px) / previous.width)),
			y: Math.max(0, Math.min(1 - current.h, current.y + (event.clientY - previous.py) / previous.height))
		}));
	}

	/** The corner grip resizes from the bottom-right; the outline previews, the object follows on release. */
	let grip: { id: string; slideId: string; x: number; y: number; w: number; h: number; px: number; py: number; width: number; height: number; pointer: number; target: HTMLElement } | null = null;
	function startResize(event: PointerEvent, object: SceneObject) {
		if (!editable || event.button !== 0 || !stage) return;
		event.stopPropagation();
		const rect = stage.getBoundingClientRect();
		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		grip = { id: object.id, slideId: slide.id, x: object.x, y: object.y, w: object.w, h: object.h, px: event.clientX, py: event.clientY, width: rect.width, height: rect.height, pointer: event.pointerId, target };
		resizing = { id: object.id, w: object.w, h: object.h };
	}
	type Grip = NonNullable<typeof grip>;
	function sizeFrom(from: Grip, event: PointerEvent, object: SceneObject) {
		return {
			w: Math.max(0.02, Math.min(1 - object.x, from.w + (event.clientX - from.px) / from.width)),
			h: Math.max(0.02, Math.min(1 - object.y, from.h + (event.clientY - from.py) / from.height))
		};
	}
	function resizeMove(event: PointerEvent, object: SceneObject) {
		if (grip && event.pointerId === grip.pointer) resizing = { id: object.id, ...sizeFrom(grip, event, object) };
	}
	function finishResize(event: PointerEvent, cancel = false) {
		const previous = grip;
		grip = null;
		resizing = null;
		if (!previous) return;
		if (previous.target.hasPointerCapture(previous.pointer)) previous.target.releasePointerCapture(previous.pointer);
		if (cancel || previous.slideId !== slide.id || !session.scope.isCurrent()) return;
		const current = design?.objects.find((o) => o.id === previous.id);
		if (!current) return;
		if (current.w !== previous.w || current.h !== previous.h || current.x !== previous.x || current.y !== previous.y) {
			onerror(new Error('Another editor changed this object. Your resize was not applied over their change; try again from its new size.'), '');
			return;
		}
		run(() => patchSceneObject(session, slide.id, current.id, sizeFrom(previous, event, current)));
	}

	const arrangeItems = $derived.by((): MenuEntry[] => {
		const object = chosen, objects = design?.objects || [];
		if (!object) return [];
		return [
			{ id: 'left', label: 'Align left', icon: 'alignLeft', disabled: !editable, onSelect: () => patch({ x: 0 }) },
			{ id: 'center', label: 'Center horizontally', icon: 'alignCenter', disabled: !editable, onSelect: () => patch({ x: (1 - object.w) / 2 }) },
			{ id: 'right', label: 'Align right', icon: 'alignRight', disabled: !editable, onSelect: () => patch({ x: 1 - object.w }) },
			{ id: 'middle', label: 'Center vertically', icon: 'columns', disabled: !editable, onSelect: () => patch({ y: (1 - object.h) / 2 }) },
			{ id: 'sep', type: 'separator', label: '' },
			{ id: 'forward', label: 'Bring forward', icon: 'layers', disabled: !editable, onSelect: () => patch({ z: Math.min(999999, Math.max(0, ...objects.map((o) => o.z)) + 1) }) },
			{ id: 'back', label: 'Send behind', icon: 'layers', disabled: !editable, onSelect: () => patch({ z: Math.max(-999999, Math.min(0, ...objects.map((o) => o.z)) - 1) }) }
		];
	});

	/** One tab stop for the Add to slide row; arrows move between its keys. */
	function rove(event: KeyboardEvent) {
		const keys = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
		const index = keys.indexOf(document.activeElement as HTMLButtonElement);
		if (index < 0) return;
		let next = -1;
		if (event.key === 'ArrowRight') next = (index + 1) % keys.length;
		else if (event.key === 'ArrowLeft') next = (index - 1 + keys.length) % keys.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = keys.length - 1;
		if (next < 0) return;
		event.preventDefault();
		for (const key of keys) key.tabIndex = -1;
		keys[next].tabIndex = 0;
		keys[next].focus();
	}
</script>

<div class="present-board">
	{#if design && editable}
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div class="w-tool present-insert" role="toolbar" aria-label="Add to slide" tabindex="-1" onkeydown={rove}>
			{#each KINDS as item, index (item.kind)}
				<Tooltip text={item.label} placement="bottom">
					<button type="button" class="w-ibtn" aria-label={item.label} tabindex={index === 0 ? 0 : -1} onclick={() => add(item.kind)}><Icon name={item.icon} /></button>
				</Tooltip>
			{/each}
		</div>
	{/if}
	<div class="present-board__stage">
		<div class="present-board__frame" style:--present-ratio={ratio}>
			<div class="designer-stage" bind:this={stage}>
				<AudienceSlideView {slide} {aspect} />
				{#if design}
					{#each design.objects as object, index (object.id)}
						{@const size = resizing?.id === object.id ? resizing : object}
						<button
							type="button"
							class="object-handle"
							class:chosen={selected === object.id}
							style:left={`${object.x * 100}%`}
							style:top={`${object.y * 100}%`}
							style:width={`${size.w * 100}%`}
							style:height={`${size.h * 100}%`}
							aria-label={`${KIND_NAME[object.kind]} ${index + 1}${object.text ? `: ${object.text.slice(0, 40)}` : ''}`}
							aria-pressed={selected === object.id}
							aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowRight Alt+ArrowDown Delete"
							onclick={() => choose(object.id)}
							onkeydown={(event) => keys(event, object)}
							onpointerdown={(event) => startDrag(event, object)}
							onpointermove={dragMove}
							onpointerup={(event) => finishDrag(event)}
							onpointercancel={(event) => finishDrag(event, true)}
						></button>
						{#if selected === object.id && editable}
							<span
								class="object-grip"
								aria-hidden="true"
								style:left={`${(object.x + size.w) * 100}%`}
								style:top={`${(object.y + size.h) * 100}%`}
								onpointerdown={(event) => startResize(event, object)}
								onpointermove={(event) => resizeMove(event, object)}
								onpointerup={(event) => finishResize(event)}
								onpointercancel={(event) => finishResize(event, true)}
							></span>
						{/if}
					{/each}
				{/if}
			</div>
		</div>
	</div>
	{@render below?.()}
</div>

<aside class="present-inspector" aria-label="Inspector">
	<div class="present-inspector__head">
		<Segmented
			label="Inspector"
			class="present-inspector__seg"
			value={tab}
			options={[
				{ value: 'slide', label: 'Slide' },
				{ value: 'object', label: 'Object', disabled: !design, title: design ? undefined : 'Canvas slides only' }
			]}
			onchange={(value) => (tab = value as 'slide' | 'object')}
		/>
	</div>
	<div class="present-inspector__body">
		{#if tab === 'slide'}
			{@render slideFields()}
			{#if design}
				<label class="present-field">
					<span class="w-label">Slide theme</span>
					<span class="w-field"><select aria-label="Slide theme" value={design.theme} disabled={!editable} onchange={(event) => run(() => setSceneTheme(session, slide.id, event.currentTarget.value as SceneTheme))}><option value="paper">Paper</option><option value="night">Night</option><option value="ocean">Ocean</option></select></span>
				</label>
			{/if}
			<section class="present-inspector__group" aria-labelledby="present-canvas-kicker">
				<h3 class="w-kicker present-inspector__kicker" id="present-canvas-kicker">{design ? 'Canvas layout' : 'Arrange freely'}</h3>
				<span class="w-field"><select aria-label="Native slide preset" bind:value={preset} disabled={!editable}>{#each PRESETS as item (item.value)}<option value={item.value}>{item.label}</option>{/each}</select></span>
				<button type="button" class="w-btn w-btn--sm present-inspector__wide" disabled={!editable} onclick={apply}>Apply native layout</button>
				<p class="present-hint">{design ? 'Replaces the arrangement on this slide.' : 'Turns this slide into a canvas you arrange by hand.'} Undo restores it. Charts keep copied values, never a live private workbook.</p>
			</section>
			{@render slideFooter()}
		{:else if chosen}
			<label class="present-field">
				<span class="w-label">Object</span>
				<span class="w-field"><select aria-label="Selected slide object" value={chosen.id} onchange={(event) => choose(event.currentTarget.value)}>{#each design?.objects || [] as object, index (object.id)}<option value={object.id}>{KIND_NAME[object.kind]} {index + 1}{object.text ? ` · ${object.text.slice(0, 24)}` : ''}</option>{/each}</select></span>
			</label>
			<section class="present-inspector__group" aria-labelledby="present-box-kicker">
				<h3 class="w-kicker present-inspector__kicker" id="present-box-kicker">Position and size</h3>
				<div class="present-grid4">
					{#each [['x', 'X'], ['y', 'Y'], ['w', 'Width'], ['h', 'Height']] as [field, name] (field)}
						<label class="present-num">
							<span class="present-num__name" aria-hidden="true">{field.toUpperCase()}</span>
							<input class="w-field" type="number" aria-label={`Object ${field}`} title={`${name}, % of the slide`} min="0" max="100" step="1" value={percent(chosen[field as 'x' | 'y' | 'w' | 'h'])} disabled={!editable} onchange={(event) => number(field as 'x' | 'y' | 'w' | 'h', Number(event.currentTarget.value) / 100)} />
							<span class="present-num__unit" aria-hidden="true">%</span>
						</label>
					{/each}
				</div>
				<button type="button" class="w-btn w-btn--sm present-inspector__wide" aria-haspopup="menu" aria-expanded={arrangeOpen} disabled={!editable} onclick={(event) => { arrangeAnchor = event.currentTarget; arrangeOpen = !arrangeOpen; }}>
					<Icon name="layers" size={16} />Arrange<Icon name="chevDown" size={14} />
				</button>
			</section>
			{#if chosen.kind !== 'image'}
				<section class="present-inspector__group" aria-labelledby="present-look-kicker">
					<h3 class="w-kicker present-inspector__kicker" id="present-look-kicker">Look</h3>
					<div class="present-row">
						{#if chosen.kind !== 'rect' && chosen.kind !== 'ellipse' && chosen.kind !== 'line'}
							<label class="present-num present-num--wide">
								<span class="present-num__name">Size</span>
								<input class="w-field" type="number" aria-label="Object font size" min="12" max="72" value={chosen.fontSize} disabled={!editable} onchange={(event) => number('fontSize', Number(event.currentTarget.value))} />
							</label>
						{/if}
						<label class="present-swatch" title={chosen.kind === 'line' ? 'Line colour' : 'Text colour'}>
							<input type="color" aria-label="Object text color" value={chosen.color} disabled={!editable} onchange={(event) => patch({ color: event.currentTarget.value })} />
							<span>{chosen.kind === 'line' || chosen.kind === 'ellipse' ? 'Stroke' : 'Text'}</span>
						</label>
						{#if chosen.kind !== 'line'}
							<label class="present-swatch" class:present-swatch--none={chosen.fill === 'transparent'} title="Fill colour">
								<input type="color" aria-label="Object fill color" value={chosen.fill === 'transparent' ? '#FFFFFF' : chosen.fill} disabled={!editable} onchange={(event) => patch({ fill: event.currentTarget.value })} />
								<span>Fill</span>
							</label>
							<button type="button" class="w-btn w-btn--quiet w-btn--sm" aria-pressed={chosen.fill === 'transparent'} disabled={!editable} onclick={() => patch({ fill: 'transparent' })}>No fill</button>
						{/if}
					</div>
					{#if chosen.kind === 'text' || chosen.kind === 'table' || chosen.kind === 'chart'}
						<Segmented
							label="Object text alignment"
							value={chosen.align}
							disabled={!editable}
							options={[
								{ value: 'left', label: 'Left', icon: 'alignLeft', iconOnly: true },
								{ value: 'center', label: 'Center', icon: 'alignCenter', iconOnly: true },
								{ value: 'right', label: 'Right', icon: 'alignRight', iconOnly: true }
							]}
							onchange={(value) => patch({ align: value as SceneObject['align'] })}
						/>
					{/if}
				</section>
			{/if}
			{#if CONTENT[chosen.kind]}
				{@const content = CONTENT[chosen.kind]!}
				<label class="present-field">
					<span class="w-label">{content.label}</span>
					<textarea class="w-field present-area" aria-label="Object text or data" value={chosen.text} maxlength="6000" disabled={!editable} oninput={(event) => patch({ text: event.currentTarget.value })}></textarea>
					{#if content.hint}<span class="present-hint">{content.hint}</span>{/if}
				</label>
			{/if}
			{#if chosen.kind === 'image'}
				<section class="present-inspector__group" aria-labelledby="present-image-kicker">
					<h3 class="w-kicker present-inspector__kicker" id="present-image-kicker">Image</h3>
					<button type="button" class="w-btn w-btn--sm present-inspector__wide" disabled={!editable || busy} onclick={() => imageInput?.click()}><Icon name="image" size={16} />{chosen.image ? 'Replace image…' : 'Choose image…'}</button>
					<Segmented
						label="Image fit or crop"
						value={chosen.fit}
						disabled={!editable}
						options={[{ value: 'contain', label: 'Fit' }, { value: 'cover', label: 'Crop' }]}
						onchange={(value) => patch({ fit: value as SceneObject['fit'] })}
					/>
					{#if chosen.fit === 'cover'}
						<label class="present-field present-field--range"><span class="present-num__name">Across</span><input class="w-range" type="range" aria-label="Image crop horizontal" min="0" max="1" step="0.01" value={chosen.cropX} style:--w-range-fill={`${chosen.cropX * 100}%`} disabled={!editable} oninput={(event) => number('cropX', Number(event.currentTarget.value))} /></label>
						<label class="present-field present-field--range"><span class="present-num__name">Down</span><input class="w-range" type="range" aria-label="Image crop vertical" min="0" max="1" step="0.01" value={chosen.cropY} style:--w-range-fill={`${chosen.cropY * 100}%`} disabled={!editable} oninput={(event) => number('cropY', Number(event.currentTarget.value))} /></label>
						{#if chosen.image}
							<button type="button" class="w-btn w-btn--sm present-inspector__wide" disabled={!editable || busy} onclick={() => void finishCrop()}>Finalize image crop</button>
							<p class="present-hint">Finalize before presenting: only the visible pixels enter the audience image. Undo restores the original.</p>
						{/if}
					{/if}
					{#if busy}<p class="present-hint" role="status">Preparing the image…</p>{/if}
				</section>
			{/if}
			<button type="button" class="w-btn w-btn--quiet w-btn--sm present-inspector__remove" disabled={!editable} onclick={() => { const object = chosen; if (object) run(() => removeSceneObject(session, slide.id, object.id)); }}><Icon name="trash" size={16} />Remove object</button>
		{:else}
			<div class="present-inspector__empty">
				<p class="present-inspector__empty-title">Nothing selected</p>
				<p class="present-hint">Select an object on the slide, or add one from the row above it.</p>
			</div>
		{/if}
	</div>
</aside>
<Menu label="Arrange" anchor={arrangeAnchor} bind:open={arrangeOpen} items={arrangeItems} heading={chosen ? KIND_NAME[chosen.kind] : null} />
<input class="workspace-file-input" bind:this={imageInput} type="file" accept="image/png,image/jpeg,image/webp" onchange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void image(file); }} />
