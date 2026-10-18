<!--
	Empty state (design contract §7.16), kit `.w-empty`. Left-aligned in the content column and
	never a box inside a box: a glyph, a 20px serif title, one sentence that says what is missing
	and what happens next, and one primary action.

	  variant="list" (default)  a 28px registry glyph in --w-faint, for a list or region
	  variant="top"             the ensō at 48px in --w-deco, a third of the way down, for a whole
	                            surface with nothing in it yet (no channels, no documents)

	  <EmptyState icon="forum" title="No threads in conversations yet"
	              text="Longer conversations live here, so they don't scroll away."
	              action="New thread" onaction={newThread} />

	A failed load is not empty: render a Notice instead, never "No shared documents".
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	interface Props {
		title: string;
		/** The one sentence: what is missing + what happens next. */
		text?: string;
		variant?: 'list' | 'top';
		/** The list variant's glyph; omit for no glyph. */
		icon?: IconName;
		/** Label of the one primary action. */
		action?: string;
		onaction?: () => void;
		/** Heading level of the title; use 'p' when the region already has a heading. */
		as?: 'h2' | 'h3' | 'h4' | 'p';
		/** Rich sentence instead of `text`. */
		children?: Snippet;
		/** Custom actions instead of the primary button. */
		actions?: Snippet;
		id?: string;
		class?: string;
	}

	let {
		title,
		text,
		variant = 'list',
		icon,
		action,
		onaction,
		as = 'h2',
		children,
		actions,
		id,
		class: className = ''
	}: Props = $props();
</script>

<div {id} class={['w-empty', variant === 'top' && 'w-empty--enso', className]}>
	{#if variant === 'top'}
		<span class="w-empty__enso" aria-hidden="true"></span>
	{:else if icon}
		<Icon name={icon} size={28} />
	{/if}
	<svelte:element this={as} class="w-empty__title">{title}</svelte:element>
	{#if children}
		<p class="w-empty__text">{@render children()}</p>
	{:else if text}
		<p class="w-empty__text">{text}</p>
	{/if}
	{#if actions}
		<div class="w-empty__actions">{@render actions()}</div>
	{:else if action && onaction}
		<div class="w-empty__actions">
			<button type="button" class="w-btn w-btn--primary" onclick={() => onaction?.()}>{action}</button>
		</div>
	{/if}
</div>
