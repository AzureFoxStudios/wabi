<script lang="ts">
	import type { Snippet } from 'svelte';
	import { reportAddonEnabled } from '../addonEnabledRegistry.svelte';

	interface Props {
		/** Stable control id — also the key used by the Enabled Only filter. */
		id: string;
		label: string;
		/** Shown in the expanded body (Blender keeps collapsed rows to the name). */
		description?: string;
		enabled?: boolean;
		/** Server/bundled add-ons are compiled in; their checkbox is a read-only state. */
		locked?: boolean;
		/** Right-aligned label — category, or Server/Bundled (Blender shows "Built-in" here). */
		badge?: string;
		/** Small detail line (id, version, source) shown when expanded. */
		meta?: string;
		onToggle?: () => void;
		/** Extra settings rendered under the Preferences heading when expanded. */
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
	let hasBody = $derived(Boolean(description || meta || preferences));
	let checkDisabled = $derived(Boolean(locked) || !onToggle);

	$effect(() => {
		reportAddonEnabled(id, enabled);
	});

	function toggleExpanded(): void {
		if (!hasBody) return;
		expanded = !expanded;
	}
</script>

<div class="addon-prefs-row" class:expanded class:locked>
	<div class="addon-prefs-row-head">
		<button
			type="button"
			class="addon-prefs-check"
			class:checked={enabled}
			role="checkbox"
			aria-checked={enabled}
			aria-label={`${enabled ? 'Disable' : 'Enable'} ${label}`}
			title={checkDisabled ? 'Fixed by this build' : enabled ? 'Disable' : 'Enable'}
			disabled={checkDisabled}
			onclick={() => onToggle?.()}
		>
			{#if enabled}
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>
			{/if}
		</button>
		<button
			type="button"
			class="addon-prefs-row-toggle"
			aria-expanded={expanded}
			title={description}
			onclick={toggleExpanded}
		>
			<span class="addon-prefs-row-label">{label}</span>
			{#if badge}<span class="addon-prefs-row-badge">{badge}</span>{/if}
			<span class="addon-prefs-row-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
			</span>
		</button>
	</div>
	{#if expanded && hasBody}
		<div class="addon-prefs-row-body">
			{#if description}<p class="addon-prefs-row-desc">{description}</p>{/if}
			{#if meta}<div class="addon-prefs-row-meta">{meta}</div>{/if}
			{#if preferences}
				<div class="addon-prefs-prefs">
					<div class="addon-prefs-prefs-title">Preferences</div>
					{@render preferences()}
				</div>
			{/if}
		</div>
	{/if}
</div>
