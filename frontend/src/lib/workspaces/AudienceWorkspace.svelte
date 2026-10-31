<!--
	The presentation room (design contract §8.8; Present is an integration candidate, PREVIEW).

	Row A (setStageHeader): "Presentation", PREVIEW, the room's state in words ("Presenting",
	"Following the presenter", "Browsing on your own", "Paused", "Presenter disconnected · paused",
	"Ended") and "Slide 2 of 3", then Browse independently / Back to presenter, Questions,
	Fullscreen, End presentation (presenter) and ⋯ (copy link, pass control).

	The stage gives the slide the room: at least 60% of the width, centred on --w-sink, with a
	transport pill under it (‹ 2 / 3 ›; the presenter adds Blank, Pause and the laser pointer).
	The presenter's one 320 column holds Notes | Questions as tabs: notes are "Private notes ·
	this device" with the next slide and the elapsed time; viewers open Questions in the same
	column. The slide is real content for assistive tech (no role=img), and slide changes are
	announced politely. Failures are one notice above the stage that says what still holds.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { captureScope, request, targets, presentationLink, WorkspaceError, OFFICE_TOOL_VIEW, type AudienceState, type AudienceSlide, type Scope } from './bridge';
	import AudienceSlideView from './AudienceSlide.svelte';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import { clearStageHeader, setStageHeader, type StageHeaderAction, type StageHeaderTag } from '$lib/stageHeader';
	import { serverMembers, currentUser } from '$lib/presenceIdentity';
	import { toast } from '$lib/toast';
	import { _ } from '$lib/i18n';
	import './workspace.css';
	import './present/present.css';
	interface Question { id: string; slideId: string; authorUserId: number; authorName: string; body: string; createdAt: number; resolved: boolean; }
	type State = AudienceState & { artifactId?: string | null; controllerLost?: boolean; questions?: Question[] };
	const HEADER_OWNER = 'presentation-room';
	let scope = $state<Scope | null>(null), sessionId = $state(''), presentationState = $state<State | null>(null), slides = $state<AudienceSlide[]>([]);
	let follow = $state(true), independentId = $state(''), error = $state(''), errorDetail = $state<unknown>(null), busy = $state(false), address = $state('');
	let panel = $state<HTMLDivElement>(), root = $state<HTMLElement>(), slideFrame = $state<HTMLDivElement>();
	let timer: ReturnType<typeof setTimeout> | undefined, beatTimer: ReturnType<typeof setInterval> | undefined, clock: ReturnType<typeof setInterval> | undefined;
	let abort = new AbortController(), disposed = false, loading = false, epoch = 0, previous: unknown, unsubscribe = () => {}, beatBusy = false, lastBeat = 0;
	let pointer = $state<{ x: number; y: number; slideId: string } | null>(null), pointerChanged = false, laser = $state(false);
	let elapsed = $state(0), started = Date.now(), notes = $state<Record<string, string>>({}), notesFor = '';
	let columnOpen = $state(false), columnTab = $state<'notes' | 'questions'>('notes');
	let questionDraft = $state(''), questionSlide = $state('');
	let questionId: string = crypto.randomUUID();
	let draftWrites: Promise<void> = Promise.resolve(), privateError = $state('');
	let moreAnchor = $state<HTMLElement | null>(null), moreOpen = $state(false), jumpAnchor = $state<HTMLElement | null>(null), jumpOpen = $state(false);
	let handoffOpen = $state(false), handoff = $state('');
	let isFullscreen = $state(false);

	const selected = $derived(slides.find((slide) => slide.id === (follow ? presentationState?.slideId : independentId)) || slides[0] || null);
	const selectedIndex = $derived(slides.findIndex((slide) => slide.id === selected?.id));
	const ratio = $derived(Math.max(0.5, Math.min(3, presentationState?.aspect || 16 / 9)));
	const presenter = $derived(Boolean(presentationState?.canControl && !presentationState.ended));
	const nextSlide = $derived(slides[selectedIndex + 1]);
	const displayPointer = $derived(presenter && laser ? pointer : presentationState?.pointer);
	const openQuestions = $derived(presentationState?.questions?.filter((question) => !question.resolved).length || 0);
	const people = $derived($serverMembers.filter((user) => user.dbUserId && user.dbUserId !== $currentUser?.dbUserId));
	/** The presenter always has the column; a viewer opens it for Questions. */
	const column = $derived(presenter || columnOpen);
	const tab = $derived(presenter ? columnTab : 'questions');
	const stateWord = $derived.by(() => {
		const state = presentationState;
		if (!state) return sessionId ? 'Connecting' : '';
		if (state.ended) return 'Ended';
		if (state.controllerLost) return 'Presenter disconnected · paused';
		if (state.paused) return 'Paused';
		if (presenter) return follow ? 'Presenting' : 'Presenting · you are browsing';
		return follow ? 'Following the presenter' : 'Browsing on your own';
	});
	const announcement = $derived(selected ? (follow && presentationState?.blank ? 'The presenter blanked the screen' : `Slide ${selectedIndex + 1} of ${slides.length}${selected.title ? `: ${selected.title}` : ''}`) : '');

	function current(own: number, owner: Scope, id: string) { return own === epoch && !disposed && owner.isCurrent() && sessionId === id; }
	/** Our own sentences show; a network or browser failure is logged and the cause stands in. */
	function fail(e: unknown, cause: string) {
		errorDetail = e;
		error = e instanceof WorkspaceError || (e instanceof Error && e.constructor === Error) ? e.message : cause;
	}
	function apply(next: State) {
		if (next.id !== sessionId) throw new Error('Server returned a different presentation.');
		if (presentationState && next.sequence < presentationState.sequence) return;
		if (presentationState && next.edition !== presentationState.edition && !next.slides) throw new Error('The presented revision changed; reload its approved slides.');
		if (next.slides) slides = next.slides;
		presentationState = next;
		if (!slides.some((slide) => slide.id === independentId)) independentId = next.slideId;
		if (next.ended) { slides = []; pointer = null; }
		if (next.canControl && next.artifactId && notesFor !== next.artifactId) void loadNotes(next.artifactId);
		if (!next.canControl) { notes = {}; notesFor = ''; pointer = null; }
	}
	async function loadNotes(id: string) {
		const owner = scope, own = epoch, room = sessionId;
		if (!owner) return;
		notesFor = id;
		try {
			const storage = await import('./privateNotes');
			const result = await storage.readPrivateNotes(owner, id);
			if (current(own, owner, room) && presentationState?.artifactId === id && presentationState.canControl) notes = result;
		} catch (e) { if (current(own, owner, room)) privateError = e instanceof Error ? e.message : String(e); }
	}
	async function refresh() {
		const owner = scope, id = sessionId, own = epoch;
		if (!owner || !id || loading || disposed) return;
		loading = true;
		try {
			const suffix = presentationState ? `?edition=${encodeURIComponent(presentationState.edition)}` : '';
			const next = await request<State>(owner, `/presentations/${id}${suffix}`, undefined, undefined, abort.signal);
			if (!current(own, owner, id)) return;
			apply(next);
			error = '';
		} catch (e) { if (current(own, owner, id)) fail(e, "Couldn't reach the presentation"); }
		finally {
			if (current(own, owner, id)) {
				loading = false;
				if (timer) clearTimeout(timer);
				if (!presentationState?.ended) timer = setTimeout(() => void refresh(), document.hidden ? 4000 : 1200);
			}
		}
	}
	function open(id: string) {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { fail(new Error("That isn't a presentation link or ID. Paste the whole link the presenter shared."), ''); return; }
		epoch++;
		if (timer) clearTimeout(timer);
		abort.abort();
		abort = new AbortController();
		loading = false; busy = false; beatBusy = false; lastBeat = 0;
		presentationState = null; slides = []; follow = true; sessionId = id; notes = {}; notesFor = ''; pointer = null; questionDraft = ''; questionId = crypto.randomUUID(); started = Date.now(); elapsed = 0; error = '';
		void refresh();
		const owner = scope, own = epoch;
		if (owner) void import('./privateNotes')
			.then((storage) => storage.readPrivateNotes(owner, `session:${id}`))
			.then((saved) => { if (current(own, owner, id)) { questionDraft = saved.question || ''; questionSlide = saved.slide || ''; questionId = saved.id || crypto.randomUUID(); } })
			.catch((e) => { if (current(own, owner, id)) privateError = e.message; });
	}
	function fromAddress() {
		try {
			let id = address.trim();
			if (id.includes('://')) {
				const url = new URL(id);
				if (!scope || new URL(scope.server).origin !== url.origin) throw new Error('This link is for another server. Switch to that server first.');
				id = url.searchParams.get('workspaceSession') || '';
			}
			open(id);
		} catch (e) { fail(e, "That isn't a presentation link or ID."); }
	}
	async function command(action: string, extra: Record<string, unknown> = {}) {
		const owner = scope, state = presentationState, id = sessionId, own = epoch;
		if (!owner || !state || busy) return;
		busy = true;
		try {
			const result = await request<State>(owner, `/presentations/${id}`, { action, generation: state.generation, sequence: state.sequence, ...extra }, undefined, abort.signal);
			if (current(own, owner, id)) { apply(result); error = ''; lastBeat = 0; }
		} catch (e) {
			if (current(own, owner, id)) { fail(e, "That didn't reach the room. The audience still sees the last approved state."); if (timer) clearTimeout(timer); void refresh(); }
		} finally { if (current(own, owner, id)) busy = false; }
	}
	async function heartbeat() {
		const owner = scope, state = presentationState, id = sessionId, own = epoch;
		if (!owner || !state?.canControl || state.ended || state.controllerLost || beatBusy || disposed) return;
		if (!pointerChanged && Date.now() - lastBeat < 3000) return;
		beatBusy = true; pointerChanged = false; lastBeat = Date.now();
		try { await request(owner, `/presentations/${id}/heartbeat`, { generation: state.generation, pointer: laser && follow ? pointer : null }, undefined, abort.signal); }
		catch (e) { if (current(own, owner, id)) { fail(e, 'The room lost contact with this device.'); if (e instanceof WorkspaceError && e.status === 409) void refresh(); } }
		finally { if (current(own, owner, id)) beatBusy = false; }
	}
	function point(event: PointerEvent) {
		if (!presenter || !laser || !follow || !selected || !slideFrame) return;
		const bounds = slideFrame.getBoundingClientRect();
		if (!bounds.width || !bounds.height) return;
		pointer = { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)), slideId: selected.id };
		pointerChanged = true;
	}
	function move(direction: number) {
		const index = Math.max(0, Math.min(slides.length - 1, selectedIndex + direction)), slide = slides[index];
		if (!slide) return;
		goTo(slide.id);
	}
	function goTo(id: string) {
		if (presenter && follow) void command('slide', { slideId: id });
		else { follow = false; independentId = id; }
	}
	function key(event: KeyboardEvent) {
		if (!root?.contains(document.activeElement) && !document.fullscreenElement) return;
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
		if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); move(1); }
		else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); move(-1); }
	}
	async function fullscreen() {
		try { if (document.fullscreenElement) await document.exitFullscreen(); else await panel?.requestFullscreen(); }
		catch { fail(new Error('Fullscreen was not allowed. The presentation stays here in the stage.'), ''); }
	}
	function stageQuestion(text: string) {
		if (!scope || !selected) return;
		if (!questionDraft) questionSlide = selected.id;
		questionDraft = text;
		const owner = scope, id = sessionId, own = epoch, slide = questionSlide, draftId = questionId;
		draftWrites = draftWrites.catch(() => {}).then(async () => {
			const storage = await import('./privateNotes');
			await storage.savePrivateNote(owner, `session:${id}`, 'question', text);
			await storage.savePrivateNote(owner, `session:${id}`, 'slide', slide);
			await storage.savePrivateNote(owner, `session:${id}`, 'id', draftId);
		}).catch((e) => { if (current(own, owner, id)) privateError = e.message; });
	}
	async function ask() {
		const owner = scope, id = sessionId, own = epoch;
		if (!owner || busy || !questionDraft.trim()) return;
		busy = true;
		try {
			await draftWrites;
			const next = await request<State>(owner, `/presentations/${id}/questions`, { action: 'add', id: questionId, slideId: questionSlide || selected?.id, body: questionDraft }, undefined, abort.signal);
			if (current(own, owner, id)) { apply(next); stageQuestion(''); questionId = crypto.randomUUID(); error = ''; }
		} catch (e) { if (current(own, owner, id)) fail(e, "Couldn't post your question. It is still in the box."); }
		finally { if (current(own, owner, id)) busy = false; }
	}
	async function resolveQuestion(question: Question) {
		const owner = scope, id = sessionId, own = epoch;
		if (!owner || busy) return;
		busy = true;
		try {
			const next = await request<State>(owner, `/presentations/${id}/questions`, { action: question.resolved ? 'reopen' : 'resolve', id: question.id }, undefined, abort.signal);
			if (current(own, owner, id)) apply(next);
		} catch (e) { if (current(own, owner, id)) fail(e, "Couldn't update that question"); }
		finally { if (current(own, owner, id)) busy = false; }
	}
	async function copyLink() {
		if (!scope) return;
		try {
			await navigator.clipboard.writeText(presentationLink(scope.server, sessionId));
			toast('Presentation link copied. It opens only for people who can see the deck.', { tone: 'info', timeout: 6000 });
		} catch (e) { fail(e, 'Clipboard access was denied.'); }
	}
	function passControl() {
		if (!/^[1-9]\d*$/.test(handoff)) return;
		const target = Number(handoff);
		handoffOpen = false;
		void command('handoff', { targetUserId: target });
	}

	const moreItems = $derived.by((): MenuEntry[] => [
		{ id: 'link', label: 'Copy presentation link', icon: 'link', onSelect: () => void copyLink() },
		...(presenter
			? [{ id: 'handoff', label: 'Pass control…', icon: 'users', hint: 'Your private notes stay here', disabled: busy, onSelect: () => { handoff = ''; handoffOpen = true; } } satisfies MenuEntry]
			: [])
	]);
	const jumpItems = $derived<MenuEntry[]>(slides.map((slide, index) => ({ id: slide.id, label: `${index + 1}. ${slide.title || 'Untitled slide'}`, keepCase: true, role: 'menuitemradio', checked: slide.id === selected?.id, onSelect: () => goTo(slide.id) })));
	const headerActions = $derived.by((): StageHeaderAction[] => {
		const state = presentationState;
		if (!state) return [];
		const list: StageHeaderAction[] = [];
		if (!state.ended) {
			list.push(follow
				? { id: 'browse', label: 'Browse independently', icon: 'columns', variant: 'quiet', onSelect: () => { follow = false; independentId = state.slideId; } }
				: { id: 'follow', label: 'Back to presenter', icon: 'present', variant: 'primary', onSelect: () => { follow = true; independentId = state.slideId; } });
		}
		if (!presenter) list.push({ id: 'questions', label: openQuestions ? `Questions, ${openQuestions} open` : 'Questions', icon: 'chat', iconOnly: true, pressed: columnOpen, onSelect: () => { columnOpen = !columnOpen; } });
		list.push({ id: 'fullscreen', label: isFullscreen ? 'Exit fullscreen' : 'Fullscreen', icon: isFullscreen ? 'collapse' : 'expand', iconOnly: true, disabled: !selected, onSelect: () => void fullscreen() });
		if (presenter) list.push({ id: 'end', label: 'End presentation', variant: 'danger', disabled: busy, onSelect: () => void command('end') });
		list.push({ id: 'more', label: 'Presentation options', icon: 'more', iconOnly: true, onSelect: (anchor) => { moreAnchor = anchor; moreOpen = !moreOpen; } });
		return list;
	});
	$effect(() => {
		const tags: StageHeaderTag[] = [{ label: $_('maturity.preview'), kind: 'maturity' }];
		if (stateWord) tags.push({ label: stateWord });
		setStageHeader(HEADER_OWNER, {
			view: OFFICE_TOOL_VIEW.audience,
			title: 'Presentation',
			scope: tags,
			status: slides.length && selected ? `Slide ${selectedIndex + 1} of ${slides.length}` : undefined,
			actions: headerActions
		});
	});

	onMount(() => {
		const onFullscreen = () => { isFullscreen = !!document.fullscreenElement && document.fullscreenElement === panel; };
		document.addEventListener('fullscreenchange', onFullscreen);
		void captureScope().then((owner) => {
			if (disposed || !owner.isCurrent()) return;
			scope = owner;
			unsubscribe = targets.subscribe((value) => { if (value.audience && value.audience !== previous) { previous = value.audience; if (value.audience.sessionId) open(value.audience.sessionId); } });
		}).catch((e) => { if (!disposed) fail(e, "Couldn't open the presentation room"); });
		beatTimer = setInterval(() => void heartbeat(), 250);
		clock = setInterval(() => (elapsed = Math.floor((Date.now() - started) / 1000)), 1000);
		return () => document.removeEventListener('fullscreenchange', onFullscreen);
	});
	onDestroy(() => { disposed = true; epoch++; unsubscribe(); abort.abort(); if (timer) clearTimeout(timer); if (beatTimer) clearInterval(beatTimer); if (clock) clearInterval(clock); clearStageHeader(HEADER_OWNER); });
</script>

<svelte:window onkeydown={key} />

<section class="wabi-workspace room" bind:this={root} aria-label="Presentation room">
	{#if error}
		<Notice class="present-notice" title={error} text={slides.length ? 'The slides on screen stay; they may not match the presenter until the room is reached again.' : 'Check the link, then try again.'} error={errorDetail}>
			{#snippet actions()}{#if sessionId}<button type="button" class="w-btn w-btn--sm" onclick={() => void refresh()}>Reconnect</button>{/if}{/snippet}
		</Notice>
	{/if}
	{#if privateError}<Notice class="present-notice" title="Your unsent question couldn't be saved on this device" text="Keep a copy of it before you leave." error={privateError} />{/if}

	{#if !sessionId}
		<div class="room-join">
			<Icon name="present" size={28} class="room-join__glyph" />
			<h2 class="room-join__title">Join a presentation</h2>
			<p class="room-join__text">Paste the link the presenter shared. Viewing slides doesn't join or end a voice call.</p>
			<form class="room-join__form" onsubmit={(event) => { event.preventDefault(); fromAddress(); }}>
				<input class="w-field" aria-label="Presentation link or ID" placeholder="Presentation link or ID" bind:value={address} />
				<button type="submit" class="w-btn w-btn--primary" disabled={!scope || !address.trim()}>Join presentation</button>
			</form>
		</div>
	{:else}
		<div class="room-body" class:room-body--column={column}>
			<div class="room-stage" bind:this={panel}>
				<div class="room-fit">
					{#if selected}
						<!-- The presented slide is real text for assistive tech; it is not an image. -->
						<div class="room-frame" bind:this={slideFrame} style:--present-ratio={ratio} onpointermove={point} onpointerleave={() => { pointer = null; pointerChanged = true; }}>
							<AudienceSlideView slide={selected} aspect={ratio} blank={follow && presentationState?.blank} />
							{#if displayPointer && follow && displayPointer.slideId === selected.id && !presentationState?.blank}<span class="laser-dot" style:left={`${displayPointer.x * 100}%`} style:top={`${displayPointer.y * 100}%`} aria-hidden="true"></span>{/if}
						</div>
					{:else if presentationState?.ended}
						<div class="room-empty" role="status"><p class="room-empty__title">This presentation has ended</p><p class="room-empty__text">Your call, if you are in one, stays connected.</p></div>
					{:else}
						<div class="room-empty" role="status"><p class="room-empty__title">Loading the approved slides…</p><p class="room-empty__text">The room shows only the slides the presenter approved.</p></div>
					{/if}
				</div>
				{#if presentationState && !presentationState.ended && slides.length}
					<div class="w-tool present-transport room-transport" role="toolbar" aria-label="Slide controls">
						<Tooltip text="Previous slide" shortcut="←" placement="top"><button type="button" class="w-ibtn" aria-label="Previous slide" disabled={busy || selectedIndex <= 0} onclick={() => move(-1)}><Icon name="chevLeft" /></button></Tooltip>
						<button type="button" class="w-btn w-btn--quiet w-btn--sm present-transport__count" aria-haspopup="menu" aria-expanded={jumpOpen} aria-label={`Slide ${selectedIndex + 1} of ${slides.length}. Go to a slide`} onclick={(event) => { jumpAnchor = event.currentTarget; jumpOpen = !jumpOpen; }}>{selectedIndex + 1} / {slides.length}</button>
						<Tooltip text="Next slide" shortcut="→" placement="top"><button type="button" class="w-ibtn" aria-label="Next slide" disabled={busy || selectedIndex >= slides.length - 1} onclick={() => move(1)}><Icon name="chevRight" /></button></Tooltip>
						{#if presenter}
							<span class="w-tool__sep" aria-hidden="true"></span>
							<Tooltip text={presentationState.blank ? 'Show slides' : 'Blank the audience screen'} placement="top"><button type="button" class="w-ibtn" aria-label="Blank screen" aria-pressed={presentationState.blank} disabled={busy || presentationState.controllerLost} onclick={() => void command('blank')}><Icon name="eyeOff" /></button></Tooltip>
							<button type="button" class="w-btn w-btn--quiet w-btn--sm" aria-pressed={presentationState.paused} disabled={busy} onclick={() => void command(presentationState!.paused ? 'resume' : 'pause')}>{presentationState.paused ? 'Resume' : 'Pause'}</button>
							<Tooltip text={laser ? 'Laser pointer on: move over the slide' : 'Laser pointer'} placement="top"><button type="button" class="w-ibtn" aria-label="Laser pointer" aria-pressed={laser} onclick={() => { laser = !laser; pointer = null; pointerChanged = true; }}><Icon name="pointer" /></button></Tooltip>
						{/if}
					</div>
				{/if}
			</div>
			{#if column && presentationState}
				<aside class="room-column" aria-label={presenter ? 'Presenter' : 'Slide questions'}>
					{#if presenter}
						<div class="room-column__head">
							<Segmented label="Presenter column" class="room-column__seg" value={columnTab} options={[{ value: 'notes', label: 'Notes' }, { value: 'questions', label: openQuestions ? `Questions ${openQuestions}` : 'Questions' }]} onchange={(value) => (columnTab = value as 'notes' | 'questions')} />
							<span class="room-column__clock" title="Elapsed since you opened the room">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
						</div>
					{:else}
						<div class="room-column__head">
							<h2 class="room-column__title">Slide questions</h2>
							<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close questions" onclick={() => (columnOpen = false)}><Icon name="x" /></button>
						</div>
					{/if}
					<div class="room-column__body">
						{#if tab === 'notes'}
							<div class="present-notes__head room-column__kicker"><h3 class="w-kicker present-notes__title">Notes</h3><span class="w-tag present-notes__scope" title="Handing off control does not share them">Private notes · this device</span></div>
							<p class="present-show__note" class:present-show__note--empty={!selected || !notes[selected.id]}>{selected && notes[selected.id] ? notes[selected.id] : 'No private notes for this slide on this device.'}</p>
							{#if nextSlide}
								<h3 class="w-kicker present-notes__title">Next</h3>
								<div class="present-show__next" aria-hidden="true"><AudienceSlideView slide={nextSlide} aspect={ratio} /></div>
								<p class="present-show__next-title">{nextSlide.title || 'Untitled slide'}</p>
							{:else}
								<p class="present-show__note present-show__note--empty">This is the last slide.</p>
							{/if}
						{:else}
							{#if !presentationState.ended && !presenter}
								<div class="room-ask">
									<textarea class="w-field present-area present-area--short" aria-label="Question about this slide" value={questionDraft} maxlength="2000" oninput={(event) => stageQuestion(event.currentTarget.value)} placeholder="Ask about the slide on screen…"></textarea>
									<div class="room-ask__foot">
										<span class="present-hint">{questionDraft ? 'Kept on this device until you post it.' : 'The presenter and the room see questions.'}</span>
										<button type="button" class="w-btn w-btn--primary w-btn--sm" disabled={busy || !questionDraft.trim()} onclick={() => void ask()}>Post question</button>
									</div>
								</div>
							{/if}
							{#each presentationState.questions || [] as question (question.id)}
								<article class="room-question" class:room-question--resolved={question.resolved}>
									<p class="room-question__by"><strong>{question.authorName}</strong><span class="room-question__state">{question.resolved ? 'Resolved' : 'Open'}</span></p>
									<p class="room-question__body">{question.body}</p>
									<div class="room-question__foot">
										<button type="button" class="w-btn w-btn--quiet w-btn--sm room-question__slide" onclick={() => { follow = false; independentId = question.slideId; }}>{slides.find((slide) => slide.id === question.slideId)?.title || 'Earlier slide revision'}</button>
										{#if presenter}<button type="button" class="w-btn w-btn--sm" disabled={busy} onclick={() => void resolveQuestion(question)}>{question.resolved ? 'Reopen' : 'Resolve'}</button>{/if}
									</div>
								</article>
							{:else}
								<p class="present-show__note present-show__note--empty">No questions yet.</p>
							{/each}
						{/if}
					</div>
				</aside>
			{/if}
		</div>
		<p class="sr-only" aria-live="polite">{announcement}</p>
	{/if}
</section>

<Menu label="Presentation options" anchor={moreAnchor} bind:open={moreOpen} items={moreItems} align="end" heading="Presentation" subheading="Viewing slides doesn't join or end a voice call. Control never includes private notes." />
<Menu label="Go to a slide" anchor={jumpAnchor} bind:open={jumpOpen} items={jumpItems} heading="Slides" />

<BaseModal isOpen={handoffOpen} onClose={() => (handoffOpen = false)} size="sm" padded title="Pass control">
	<div class="present-dialog">
		<p class="present-dialog__truth">They can change slides, blank the screen and end the presentation. Your private notes stay on this device; they are never handed over.</p>
		<label class="present-field">
			<span class="w-label">New presenter</span>
			<span class="w-field">
				<select aria-label="New presenter" bind:value={handoff}>
					<option value="" disabled>Choose a person</option>
					{#each people as person (person.dbUserId)}<option value={String(person.dbUserId)}>{person.username}</option>{/each}
				</select>
			</span>
		</label>
	</div>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" onclick={() => (handoffOpen = false)}>Cancel</button>
		<button type="button" class="w-btn w-btn--primary" disabled={busy || !/^[1-9]\d*$/.test(handoff)} onclick={passControl}>Pass control</button>
	</div>
</BaseModal>

<style>
	/* The laser is drawn over slide content, so it uses slide-content colours, not theme roles. */
	.laser-dot {
		--slide-laser: #e5484d;
		--slide-laser-core: #fff3c4;
		position: absolute;
		width: 13px;
		height: 13px;
		border-radius: 50%;
		background: var(--slide-laser-core);
		box-shadow: 0 0 4px 2px var(--slide-laser);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}
</style>
