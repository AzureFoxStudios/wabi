<!--
	PrivacyBadge (design contract §7.9, §7.20, §9.2, §9.5): the one way the app shows who can
	read a room. Every word comes from `lib/privacy/privacyState.ts`; pass the derived `state`
	or the raw `input` ({ channelType, encryptSend, dmMode, policy }) and let it derive it.

	Variants
	- `colophon`: the row under the composer field. A button (aria-haspopup="dialog") with the
	  14px privacy glyph in --w-seal and the state word in --w-t-caption --w-mute, then the plain
	  sentence in --w-faint 400, then the retention chip when messages are not kept until deleted.
	  The composer adds its own "Shift Enter for a new line" hint after it. The button opens
	  `PrivacyPopover`.
	- `chip`: the static `.w-seal` chip for places the colophon is not visible and the row itself
	  is the control (thread lists, palette results, the Share sheet). The sentence is its title.
	- `popover-trigger`: the same chip as a button that opens the popover (DM and group headers).

	Phones (`surface="phone"`, or "auto" under the 768px phone shell) use the short sentences.
	The state word is never dropped and never shrinks to a bare glyph.

	<PrivacyBadge variant="colophon" input={{ channelType: 'text' }} room="#general · Common Ground"
	              retention={summary} />
	<PrivacyBadge variant="popover-trigger" state={privacyStateFor({ channelType: 'dm', policy })}
	              conversation room="Theo Park" />
-->
<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import PrivacyPopover from '$lib/components/PrivacyPopover.svelte';
	import {
		isPrivateConversationType,
		privacyStateFor,
		privacyWords,
		retentionChipVisible,
		retentionLabel,
		retentionTitle,
		type PrivacyInput,
		type PrivacyPolicy,
		type PrivacyState
	} from '$lib/privacy/privacyState';

	type Variant = 'colophon' | 'chip' | 'popover-trigger';

	interface Props {
		variant?: Variant;
		/** The derived state. When omitted it is derived from `input`. */
		state?: PrivacyState | null;
		/** Raw facts to derive the state from (`privacyStateFor`). */
		input?: PrivacyInput | null;
		/** 'auto' follows the phone shell (≤768px) with CSS, so server and client render the same. */
		surface?: 'desktop' | 'phone' | 'auto';
		/** DMs and groups ("this conversation"). Defaults from the input's channel type. */
		conversation?: boolean;
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
	}

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

	const current = $derived<PrivacyState>(givenState ?? privacyStateFor(input ?? {}));
	const channelType = $derived(input?.channelType ?? input?.channel?.type ?? null);
	// Only DMs and groups can be pending, encrypted or server-readable by choice.
	const inConversation = $derived(
		conversation ??
			(isPrivateConversationType(channelType) ||
				current === 'encryption-pending' ||
				current === 'experimental-encryption' ||
				current === 'server-readable-by-choice')
	);
	const desktop = $derived(privacyWords(current, { surface: 'desktop', conversation: inConversation }));
	const phone = $derived(privacyWords(current, { surface: 'phone', conversation: inConversation }));
	const showDesktop = $derived(surface !== 'phone');
	const showPhone = $derived(surface !== 'desktop');

	const keptSource = $derived(retention === undefined ? (input?.policy ?? null) : retention);
	const keptShown = $derived((showRetention ?? variant === 'colophon') && retentionChipVisible(keptSource));
	const kept = $derived(keptShown ? retentionLabel(keptSource) : null);
	const keptTitle = $derived(keptShown ? retentionTitle(keptSource) : null);

	let trigger = $state<HTMLButtonElement | null>(null);
	let open = $state(false);

	function toggle() {
		open = !open;
	}
</script>

{#snippet word()}
	{#if showDesktop && showPhone && desktop.word !== phone.word}
		<span class="privacy-badge__word pb-desktop">{desktop.word}</span><span class="privacy-badge__word pb-phone"
			>{phone.word}</span
		>
	{:else}
		<span class="privacy-badge__word">{showDesktop ? desktop.word : phone.word}</span>
	{/if}
{/snippet}

{#snippet keptChip()}
	{#if kept}
		<span class="w-tag privacy-badge__kept" title={keptTitle}>
			<Icon name="clock" size={12} />
			<span>{kept}</span>
		</span>
	{/if}
{/snippet}

{#if variant === 'colophon'}
	<div class="privacy-badge privacy-badge--colophon {className}" data-state={current} aria-live="polite" aria-atomic="true">
		<button
			bind:this={trigger}
			type="button"
			class="privacy-badge__key"
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-controls={open ? popId : undefined}
			aria-describedby={desktop.sentence || phone.sentence ? sentenceId : undefined}
			onclick={toggle}
		>
			<Icon name={desktop.glyph} size={14} class="privacy-badge__glyph" />
			{@render word()}
		</button>
		{#if desktop.sentence || phone.sentence}
			<span class="privacy-badge__sentence" id={sentenceId}>
				{#if showDesktop && showPhone && desktop.sentence !== phone.sentence}
					<span class="pb-desktop">{desktop.sentence}</span><span class="pb-phone">{phone.sentence}</span>
				{:else}
					{showDesktop ? desktop.sentence : phone.sentence}
				{/if}
			</span>
		{/if}
		{@render keptChip()}
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
			{@render word()}
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
			{@render word()}
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
	.privacy-badge--colophon {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		min-height: 24px;
		color: var(--w-mute);
		font: var(--w-t-caption);
	}
	.privacy-badge__key {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		flex: none;
		box-sizing: border-box;
		height: 22px;
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
		color: var(--w-seal);
	}
	.privacy-badge__sentence {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-caption);
		font-weight: 400;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ---------- chips (§7.9 seal chip, retention chip) ---------- */
	.privacy-badge--group {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		vertical-align: middle;
	}
	.privacy-badge__chip {
		max-width: 100%;
	}
	.privacy-badge__chip > .privacy-badge__word {
		overflow: hidden;
		text-overflow: ellipsis;
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
	.privacy-badge__kept {
		flex: none;
	}

	/* Focus (§4.6): one accent outline, never a stacked ring. */
	.privacy-badge__key:focus-visible,
	.privacy-badge__chip--button:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}

	/* High Contrast: hover and open carry a ring, not just a fill (§5.2). */
	:global(:root[data-char='contrast']) .privacy-badge__key:hover,
	:global(:root[data-char='contrast']) .privacy-badge__key[aria-expanded='true'] {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	:global(:root[data-char='contrast']) .privacy-badge__chip--button:hover,
	:global(:root[data-char='contrast']) .privacy-badge__chip--button[aria-expanded='true'] {
		box-shadow: 0 0 0 1px var(--w-line-strong);
	}

	/* Touch: 44px targets without changing the 22px row (§10). */
	@media (pointer: coarse) {
		.privacy-badge__key::after,
		.privacy-badge__chip--button::after {
			content: '';
			position: absolute;
			inset: -11px -4px;
		}
	}

	/* "auto": the phone shell (≤768px) shows the short words; desktop shows the full ones. */
	.pb-phone {
		display: none;
	}
	@media (max-width: 768px) {
		.pb-desktop {
			display: none;
		}
		.pb-phone {
			display: inline;
		}
	}
</style>
