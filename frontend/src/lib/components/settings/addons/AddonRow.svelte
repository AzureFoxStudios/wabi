<script lang="ts">
	/**
	 * One add-on in Settings › Add-ons (§7.25): a hairline settings row with the name, one line
	 * of what it does and a switch. Add-ons with options open them with a disclosure under the row.
	 * A compiled-in add-on that cannot change here says so in words instead of a disabled switch.
	 */
	import type { Snippet } from 'svelte';
	import { reportAddonEnabled } from '../addonEnabledRegistry.svelte';
	import Icon from '../../ui/Icon.svelte';

	interface Props {
		/** Stable control id — also the key used by the "On" filter. */
		id: string;
		label: string;
		/** What it does, in one line under the name. */
		description?: string;
		enabled?: boolean;
		/** Compiled in or always on: the state is a fact, not a control. */
		locked?: boolean;
		/** Where it comes from ("Chat", "On this server", "Comes with this app"). */
		badge?: string;
		/** A small fact shown with the options (version, server address). */
		meta?: string;
		onToggle?: () => void;
		/** Options, shown when the row is opened. */
		preferences?: Snippet;
	}

	let {
		id,
		label,
		description = '',
		enabled = false,
		locked = false,
		badge = '',
		meta = '',
		onToggle,
		preferences
	}: Props = $props();

	let expanded = $state(false);
	const hasBody = $derived(Boolean(meta || preferences));
	const fixed = $derived(Boolean(locked) || !onToggle);
	const domId = $derived(`addon-${id.replace(/[^a-z0-9_-]/gi, '-')}`);

	$effect(() => {
		reportAddonEnabled(id, enabled);
	});
</script>

<div class="w-addon" class:expanded>
	<div class="w-srow w-addon__head">
		<div class="w-srow__text">
			<p class="w-srow__label">
				<span id={`${domId}-label`}>{label}</span>
				{#if badge}<span class="w-addon__badge">{badge}</span>{/if}
			</p>
			{#if description}<p class="w-srow__hint" id={`${domId}-hint`}>{description}</p>{/if}
		</div>
		<div class="w-srow__control">
			{#if hasBody}
				<button
					type="button"
					class="w-btn w-btn--sm w-btn--quiet w-addon__more"
					aria-expanded={expanded}
					aria-controls={`${domId}-body`}
					aria-label={`${expanded ? 'Hide' : 'Show'} options for ${label}`}
					onclick={() => (expanded = !expanded)}
				>
					Options<Icon name="chevDown" size={14} />
				</button>
			{/if}
			{#if fixed}
				<span class="w-addon__fixed">{enabled ? 'Always on' : 'Off in this build'}</span>
			{:else}
				<button
					type="button"
					class="w-switch"
					role="switch"
					aria-checked={enabled}
					aria-labelledby={`${domId}-label`}
					aria-describedby={description ? `${domId}-hint` : undefined}
					onclick={() => onToggle?.()}
				></button>
			{/if}
		</div>
	</div>
	{#if expanded && hasBody}
		<div class="w-addon__body" id={`${domId}-body`}>
			{#if meta}<p class="w-addon__meta">{meta}</p>{/if}
			{#if preferences}{@render preferences()}{/if}
		</div>
	{/if}
</div>
