<!--
	Notice (design contract §7.16), kit `.w-notice`. Rendered where the action happened, inside
	the visible area: a 16px glyph, a bold one-line cause, one consequence line and at most one
	small action (Retry, Export recovery).

	  tone="danger" (default)  45% danger edge, faint danger wash, alert glyph, role=alert
	  tone="info"              line-strong edge, info glyph, role=status
	  tone="warn"              line-strong edge, warning glyph, role=status

	  <Notice title="Couldn't load documents" text="Your drafts on this device are unchanged."
	          error={err} onretry={reload} />

	Never show a raw Error.message: pass the error as `error` and it is logged, not rendered.
	`actions` replaces the default Retry button with your own `.w-btn.w-btn--sm` controls.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	type Tone = 'danger' | 'info' | 'warn';

	interface Props {
		/** The cause, one line: "Couldn't save the document". */
		title: string;
		/** The consequence, one line: "Your draft and settings are unchanged." */
		text?: string;
		tone?: Tone;
		/** Glyph override; defaults to alert / info / warn by tone. */
		icon?: IconName;
		/** Shows a small "Retry" button (label via retryLabel). */
		onretry?: () => void;
		retryLabel?: string;
		/** Shows a quiet close button. */
		ondismiss?: () => void;
		dismissLabel?: string;
		/** The underlying error, logged to the console once, never displayed. */
		error?: unknown;
		/** Rich consequence line instead of `text`. */
		children?: Snippet;
		/** Custom actions instead of Retry. */
		actions?: Snippet;
		id?: string;
		class?: string;
	}

	let {
		title,
		text,
		tone = 'danger',
		icon,
		onretry,
		retryLabel = 'Retry',
		ondismiss,
		dismissLabel = 'Dismiss',
		error,
		children,
		actions,
		id,
		class: className = ''
	}: Props = $props();

	const GLYPHS: Record<Tone, IconName> = { danger: 'alert', info: 'info', warn: 'warn' };
	const glyph = $derived(icon ?? GLYPHS[tone]);
	const hasText = $derived(Boolean(children || text));
	const hasActions = $derived(Boolean(actions || onretry || ondismiss));

	let logged: unknown = undefined;
	$effect(() => {
		if (error === undefined || error === null || error === logged) return;
		logged = error;
		console.error(`[notice] ${title}`, error);
	});
</script>

<div
	{id}
	class={['w-notice', tone !== 'danger' && `w-notice--${tone}`, !hasText && 'w-notice--single', className]}
	role={tone === 'danger' ? 'alert' : 'status'}
>
	<Icon name={glyph} size={16} />
	<p class="w-notice__title">{title}</p>
	{#if children}
		<p class="w-notice__text">{@render children()}</p>
	{:else if text}
		<p class="w-notice__text">{text}</p>
	{/if}
	{#if hasActions}
		<div class="w-notice__actions">
			{#if actions}
				{@render actions()}
			{:else if onretry}
				<button type="button" class="w-btn w-btn--sm" onclick={() => onretry?.()}>{retryLabel}</button>
			{/if}
			{#if ondismiss}
				<button type="button" class="w-ibtn w-ibtn--sm" aria-label={dismissLabel} onclick={() => ondismiss?.()}>
					<Icon name="x" size={16} />
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* A notice without a consequence line is one row: the glyph and actions centre on the title. */
	.w-notice--single {
		align-items: center;
	}
	.w-notice--single > :global(svg:first-child),
	.w-notice--single > .w-notice__actions {
		grid-row: 1;
		margin-top: 0;
	}
</style>
