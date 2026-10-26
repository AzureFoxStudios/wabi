<!--
	PrivacyBadge (design contract §7.9, §7.20, §9.2, §9.5): the one way the app shows who can
	read a room. Every word comes from `lib/privacy/privacyState.ts`. Give it either the raw
	`input` ({ channelType, encryptSend, dmMode, policy }: state and "this conversation" are both
	derived), or a ready `state` plus `conversation` (required then: a state alone cannot tell an
	older DM from a community channel, both are Server-readable).

	Variants
	- `colophon`: the row under the composer field. A button (aria-haspopup="dialog") with the
	  14px privacy glyph in --w-seal and the state word in --w-t-caption --w-mute, then the plain
	  sentence in --w-faint 400, then the retention chip when messages are not kept until deleted.
	  It takes the width its row gives it and picks the words that fit there (`data-fit`): the
	  desktop sentence (`full`), else the short one (`short`), else the short one with the
	  retention chip under it (`wrap`), else the sentence and chip on their own line under the key
	  (`stack`). Nothing is cut to an ellipsis. The composer puts its "Shift Enter for a new line"
	  hint after it. The button opens `PrivacyPopover`.
	- `chip`: the static `.w-seal` chip for places the colophon is not visible and the row itself
	  is the control (thread lists, palette results, the Share sheet). The sentence is its title.
	  It never shrinks; the row's own text gives way.
	- `popover-trigger`: the same chip as a button that opens the popover (DM and group headers).

	Phones (`surface="phone"`, or "auto" under the 768px phone shell) always use the short
	sentence. The state word is never dropped, cut or reduced to a bare glyph.

	<PrivacyBadge variant="colophon" input={{ channelType: 'text', policy: summary }}
	              room="#general · Common Ground" />
	<PrivacyBadge variant="popover-trigger" input={{ channelType: 'dm', policy: e2eeStatus }}
	              retention={summary} room="Theo Park" showRetention />
	<PrivacyBadge variant="chip" state={rowState} conversation />
-->
<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import PrivacyPopover from '$lib/components/PrivacyPopover.svelte';
	import {
		privacyWords,
		resolvePrivacySubject,
		retentionChipVisible,
		retentionLabel,
		retentionTitle,
		type PrivacyPolicy,
		type PrivacyState,
		type PrivacySubject
	} from '$lib/privacy/privacyState';

	type Variant = 'colophon' | 'chip' | 'popover-trigger';
	/** Colophon words for the width it has (see the header comment). */
	type Fit = 'full' | 'short' | 'wrap' | 'stack';

	type Props = PrivacySubject & {
		variant?: Variant;
		/** 'auto' follows the phone shell (≤768px); 'phone' always uses the short sentence. */
		surface?: 'desktop' | 'phone' | 'auto';
		/** Popover Room fact: "#general · Common Ground", "Theo Park". */
		room?: string | null;
		/** Retention for the chip and the Kept fact: a policy or a label ('24h', 'live',
		 *  'forever'). Defaults to `input.policy`. Never part of the privacy state. */
		retention?: PrivacyPolicy | string | null;
		/** Show the retention chip (when not kept until deleted). Colophon: on; chips: off. */
		showRetention?: boolean;
		/** Side the popover prefers. Colophon: above; header chip: below. */
		placement?: 'top' | 'bottom';
		class?: string;
	};

	let {
		variant = 'colophon',
		// Renamed locally: a binding called `state` would turn the `$state` rune into a store read.
		state: givenState = null,
		input = null,
		surface = 'auto',
		conversation,
		room = null,
		retention,
		showRetention,
		placement,
		class: className = ''
	}: Props = $props();

	const uid = $props.id();
	const popId = `privacy-badge-pop-${uid}`;
	const sentenceId = `privacy-badge-sentence-${uid}`;

	const subject = $derived(resolvePrivacySubject({ state: givenState, input, conversation }));
	const current = $derived<PrivacyState>(subject.state);
	const inConversation = $derived(subject.conversation);
	const desktop = $derived(privacyWords(current, { surface: 'desktop', conversation: inConversation }));
	const phone = $derived(privacyWords(current, { surface: 'phone', conversation: inConversation }));

	const phoneShell = new MediaQuery('max-width: 768px', false);
	const shortOnly = $derived(surface === 'phone' || (surface === 'auto' && phoneShell.current));
	const word = $derived(shortOnly ? phone.word : desktop.word);

	const keptSource = $derived(retention === undefined ? (input?.policy ?? null) : retention);
	const keptShown = $derived((showRetention ?? variant === 'colophon') && retentionChipVisible(keptSource));
	const kept = $derived(keptShown ? retentionLabel(keptSource) : null);
	const keptTitle = $derived(keptShown ? retentionTitle(keptSource) : null);

	// ---- colophon fit: measured on the width the row gives it, never on the viewport.
	let rest = $state<HTMLElement | null>(null);
	let measureFull = $state<HTMLElement | null>(null);
	let measureShort = $state<HTMLElement | null>(null);
	let measured = $state<Fit | null>(null);
	const fit = $derived<Fit>(measured ?? (shortOnly ? 'short' : 'full'));
	const sentence = $derived(fit === 'full' ? desktop.sentence : phone.sentence);
	const hasRest = $derived(Boolean(desktop.sentence || phone.sentence || kept));

	$effect(() => {
		const box = rest;
		const full = shortOnly ? null : measureFull;
		const short = measureShort;
		if (!box || !short) {
			measured = null;
			return;
		}
		// The measures are invisible one-line copies of "sentence + chip" in each wording. They sit
		// in the cell beside the key whatever is shown, so that cell's width never depends on the
		// wording chosen and the choice cannot flip back and forth.
		const width = (element: Element | null) => (element ? element.getBoundingClientRect().width : 0);
		const decide = () => {
			const room = width(box) + 0.5;
			if (full && width(full) <= room) measured = 'full';
			else if (width(short) <= room) measured = 'short';
			else {
				const sentenceFits = width(short.querySelector('.privacy-badge__sentence')) <= room;
				const chipFits = width(short.querySelector('.privacy-badge__kept')) <= room;
				measured = sentenceFits && chipFits ? 'wrap' : 'stack';
			}
		};
		decide();
		const observer = new ResizeObserver(decide);
		observer.observe(box);
		observer.observe(short);
		if (full) observer.observe(full);
		return () => observer.disconnect();
	});

	// Screen readers hear a change of state once, not every re-fit of the words.
	let announcement = $state('');
	let announced: PrivacyState | null = null;
	$effect(() => {
		const now = current;
		const title = desktop.title;
		if (announced !== null && announced !== now) announcement = title;
		announced = now;
	});

	let trigger = $state<HTMLButtonElement | null>(null);
	let open = $state(false);

	function toggle() {
		open = !open;
	}
</script>

{#snippet keptChip()}
	{#if kept}
		<span class="w-tag privacy-badge__kept" title={keptTitle}>
			<Icon name="clock" size={12} />
			<span>{kept}</span>
		</span>
	{/if}
{/snippet}

{#snippet measure(text: string)}
	{#if text}<span class="privacy-badge__sentence">{text}</span>{/if}
	{@render keptChip()}
{/snippet}

{#if variant === 'colophon'}
	<div
		class="privacy-badge privacy-badge--colophon {className}"
		class:privacy-badge--key-only={!hasRest}
		data-state={current}
		data-fit={fit}
	>
		<button
			bind:this={trigger}
			type="button"
			class="privacy-badge__key"
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-controls={open ? popId : undefined}
			aria-describedby={sentence ? sentenceId : undefined}
			onclick={toggle}
		>
			<Icon name={desktop.glyph} size={14} class="privacy-badge__glyph" />
			<span class="privacy-badge__word">{word}</span>
		</button>
		{#if hasRest}
			<span class="privacy-badge__line">
				{#if sentence}
					<span class="privacy-badge__sentence" id={sentenceId}>{sentence}</span>
				{/if}
				{@render keptChip()}
			</span>
			<span class="privacy-badge__rest" aria-hidden="true" bind:this={rest}>
				{#if !shortOnly}
					<span class="privacy-badge__measure" bind:this={measureFull}>
						{@render measure(desktop.sentence)}
					</span>
				{/if}
				<span class="privacy-badge__measure" bind:this={measureShort}>
					{@render measure(phone.sentence)}
				</span>
			</span>
		{/if}
		<span class="sr-only" aria-live="polite">{announcement}</span>
	</div>
{:else if variant === 'popover-trigger'}
	<span class="privacy-badge privacy-badge--group {className}" data-state={current}>
		<button
			bind:this={trigger}
			type="button"
			class="w-seal privacy-badge__chip privacy-badge__chip--button"
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-controls={open ? popId : undefined}
			onclick={toggle}
		>
			<Icon name={desktop.glyph} size={13} />
			<span class="privacy-badge__word">{word}</span>
		</button>
		{@render keptChip()}
	</span>
	{#if desktop.sentence}
		<Tooltip anchor={trigger} text={desktop.sentence} placement="bottom" disabled={open} />
	{/if}
{:else}
	<span class="privacy-badge privacy-badge--group {className}" data-state={current}>
		<span class="w-seal privacy-badge__chip" title={desktop.title}>
			<Icon name={desktop.glyph} size={13} />
			<span class="privacy-badge__word">{word}</span>
		</span>
		{@render keptChip()}
	</span>
{/if}

{#if variant !== 'chip'}
	<PrivacyPopover
		bind:open
		anchor={trigger}
		id={popId}
		state={current}
		conversation={inConversation}
		{room}
		retention={keptSource}
		placement={placement ?? (variant === 'colophon' ? 'top' : 'bottom')}
	/>
{/if}

<style>
	/* ---------- colophon (§7.20) ---------- */
	/* Key, then the line (sentence + retention chip). The second column has a zero minimum, so in
	   any parent the badge is never wider than its row; the words are chosen to fit that column
	   (`data-fit`), so nothing overflows into the composer hint and nothing is cut. */
	.privacy-badge--colophon {
		position: relative;
		display: grid;
		grid-template-columns: max-content minmax(0, max-content);
		justify-content: start;
		align-items: start;
		align-content: center;
		gap: 2px 10px;
		flex: 0 1 auto;
		box-sizing: border-box;
		min-width: 0;
		max-width: 100%;
		min-height: calc(24px * var(--w-fs));
		color: var(--w-mute);
		font: var(--w-t-caption);
	}
	.privacy-badge--key-only {
		grid-template-columns: max-content;
	}
	.privacy-badge__key {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		box-sizing: border-box;
		min-height: calc(22px * var(--w-fs));
		/* The glyph stays on the field's text inset; the hover fill reaches 6px past it. */
		margin: 0 0 0 -6px;
		padding: 0 6px;
		border: 0;
		border-radius: var(--radius-inner);
		background: transparent;
		color: var(--w-mute);
		font: var(--w-t-caption);
		letter-spacing: 0;
		white-space: nowrap;
		cursor: pointer;
		transition:
			color var(--w-dur-1) var(--w-ease),
			background-color var(--w-dur-1) var(--w-ease),
			box-shadow var(--w-dur-1) var(--w-ease);
	}
	.privacy-badge__key:hover,
	.privacy-badge__key[aria-expanded='true'] {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
		color: var(--w-text);
	}
	.privacy-badge__key :global(.privacy-badge__glyph) {
		flex: none;
		color: var(--w-seal);
	}
	/* The invisible measures, always in the cell beside the key: they give that column its
	   natural width in any parent, and are clipped so a measure wider than the row never becomes
	   page overflow. */
	.privacy-badge__rest {
		grid-area: 1 / 2;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-self: start;
		min-width: 0;
		height: 0;
		overflow: clip;
	}
	.privacy-badge__line,
	.privacy-badge__measure {
		display: flex;
		align-items: center;
		column-gap: 10px;
		row-gap: 2px;
		min-height: calc(22px * var(--w-fs));
		white-space: nowrap;
	}
	.privacy-badge__line {
		grid-area: 1 / 2;
		justify-self: start;
		min-width: 0;
		max-width: 100%;
	}
	.privacy-badge__measure {
		grid-area: 1 / 1;
		justify-self: start;
		width: max-content;
		height: 0;
		min-height: 0;
		overflow: hidden;
		visibility: hidden;
		pointer-events: none;
	}
	.privacy-badge__sentence {
		/* Centres a one-line sentence on the key; a wrapped one keeps its first line there. */
		padding-block: calc(3px * var(--w-fs));
		color: var(--w-faint);
		font: var(--w-t-caption);
		font-weight: 400;
	}
	/* The short sentence and the chip do not fit on one line: the chip goes under the sentence;
	   when even that is too narrow, sentence and chip take their own line under the key and wrap
	   there (never an ellipsis). */
	[data-fit='wrap'] .privacy-badge__line,
	[data-fit='stack'] .privacy-badge__line {
		flex-wrap: wrap;
		white-space: normal;
	}
	/* Spans the row under the key without sizing the columns (zero contribution, then the full
	   area), so the key column and the measured column keep the widths every fit is chosen on. */
	[data-fit='stack'] .privacy-badge__line {
		grid-area: 2 / 1 / 3 / -1;
		width: 0;
		min-width: 100%;
		max-width: none;
	}
	[data-fit='stack'] .privacy-badge__line > .privacy-badge__sentence {
		flex: 0 1 auto;
		min-width: 0;
		text-wrap: pretty;
	}

	/* ---------- chips (§7.9 seal chip, retention chip) ---------- */
	/* A truth label never shrinks (Principle 8): the group keeps its full width and the row's
	   own text gives way. Only when the row is narrower than seal chip + retention chip (large
	   text on a phone) does the retention chip move under the seal chip. */
	.privacy-badge--group {
		display: inline-flex;
		flex: none;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
		max-width: 100%;
		vertical-align: middle;
		white-space: nowrap;
	}
	.privacy-badge__chip,
	.privacy-badge__kept {
		flex: none;
		/* The kit chips are 22px; at larger text sizes they grow with the words. */
		height: auto;
		min-height: calc(22px * var(--w-fs));
	}
	.privacy-badge__chip--button {
		position: relative;
		margin: 0;
		cursor: pointer;
		transition:
			background-color var(--w-dur-1) var(--w-ease),
			border-color var(--w-dur-1) var(--w-ease),
			box-shadow var(--w-dur-1) var(--w-ease);
	}
	.privacy-badge__chip--button:hover,
	.privacy-badge__chip--button[aria-expanded='true'] {
		border-color: var(--w-seal);
		background: color-mix(in srgb, var(--w-seal) 22%, transparent);
	}

	/* Focus (§4.6): one accent outline, never a stacked ring. */
	.privacy-badge__key:focus-visible,
	.privacy-badge__chip--button:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}

	/* High Contrast: hover and open are an inset ring instead of a fill (§5.2). The chip keeps
	   its own seal fill and edge. */
	:global(:root[data-char='contrast']) .privacy-badge__key:hover,
	:global(:root[data-char='contrast']) .privacy-badge__key[aria-expanded='true'] {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	:global(:root[data-char='contrast']) .privacy-badge__chip--button:hover,
	:global(:root[data-char='contrast']) .privacy-badge__chip--button[aria-expanded='true'] {
		border-color: color-mix(in srgb, var(--w-seal) 60%, transparent);
		background: var(--w-seal-soft);
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}

	/* Touch: 44px targets without changing the row (§10). */
	@media (pointer: coarse) {
		.privacy-badge__key::after,
		.privacy-badge__chip--button::after {
			content: '';
			position: absolute;
			inset: -11px -4px;
		}
	}
</style>
