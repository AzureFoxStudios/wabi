<!--
	The office editor header (design contract §7.23, §8.8): StageBar row A while a document,
	spreadsheet or deck is open. ArtifactShell registers it with setStageHeader; the StageBar draws
	the actions (Share…, ⋯) after it.

	Left to right: the tool crumb back to the library, PREVIEW, a chevron, the title as a borderless
	serif input, the locality tag (or the seal chip "Server-readable" plus "Shared · Editor") and the
	save state (role=status). An optional mode segment (Documents: Write | Read) sits at the end,
	just before the actions. Below a 760px stage the crumb collapses to the tool glyph and the
	locality tag to its dot; the words stay in the tooltip and for assistive tech.
-->
<script module lang="ts">
	export interface OfficeHeaderModes {
		label: string;
		options: { value: string; label: string }[];
		value: string;
		onchange: (value: string) => void;
	}
</script>

<script lang="ts">
	import Icon from '$lib/components/ui/Icon.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import { _ } from '$lib/i18n';
	import { isMobile } from '$lib/layoutStoreStates';

	interface Props {
		tool: 'documents' | 'sheets' | 'present';
		title: string;
		editable: boolean;
		ontitle: (value: string) => void;
		onlibrary: () => void;
		/** Null while the file is private on this device. */
		shared: { role: string; mode: 'live' | 'snapshot' } | null;
		status: string;
		/** A short reference to the selected passage or cells, when there is one. */
		selection?: string | null;
		modes?: OfficeHeaderModes | null;
	}

	let { tool, title, editable, ontitle, onlibrary, shared, status, selection = null, modes = null }: Props = $props();

	const TOOL: Record<Props['tool'], { label: string; icon: IconName }> = {
		documents: { label: 'Documents', icon: 'file' },
		sheets: { label: 'Sheets', icon: 'sheet' },
		present: { label: 'Present', icon: 'present' }
	};
	const crumb = $derived(TOOL[tool]);
	const role = $derived(shared ? shared.role.charAt(0).toUpperCase() + shared.role.slice(1) : '');
	const sharedTitle = $derived(
		shared
			? `${shared.mode === 'live' ? 'Collaborative: edits sync for everyone with access.' : 'Snapshot: revisions publish when you choose.'} The server operator can read this file.`
			: ''
	);
</script>

<button type="button" class="oeh-crumb" onclick={onlibrary} aria-label={`${crumb.label} library`} title={`Back to the ${crumb.label} library`}>
	<Icon name={crumb.icon} size={16} class="oeh-crumb__glyph" />
	<span class="oeh-crumb__words">{crumb.label}</span>
</button>
<span class="w-tag w-tag--mat oeh-chip" title={$_('maturity.preview_title')}>{$_('maturity.preview')}</span>
<Icon name="chevRight" size={14} class="oeh-sep" />
<input
	class="oeh-title"
	aria-label="Document title"
	value={title}
	maxlength="200"
	disabled={!editable}
	oninput={(event) => {
		const value = event.currentTarget.value;
		if (value.trim()) ontitle(value);
	}}
/>
{#if shared}
	<span class="w-seal oeh-chip" title="The server operator can read this file."><Icon name="lockOpen" />Server-readable</span>
	<span class="w-tag oeh-chip oeh-scope" title={sharedTitle}><span class="w-dot oeh-scope__dot" aria-hidden="true"></span><span class="oeh-scope__words">Shared · {role}</span></span>
{:else}
	<span class="w-tag oeh-chip oeh-scope" title="Private on this device. Opening and editing do not upload this file."><span class="w-dot oeh-scope__dot" aria-hidden="true"></span><span class="oeh-scope__words">Private · this device</span></span>
{/if}
<span class="oeh-status" role="status">{status}{#if selection}<span class="oeh-selection">{` · ${selection}`}</span>{/if}</span>
<!-- On a phone the modes are rows in ⋯ (ArtifactShell), so the title keeps row A. -->
{#if modes && !$isMobile}
	<Segmented class="oeh-modes" label={modes.label} options={modes.options} value={modes.value} onchange={modes.onchange} />
{/if}

<style>
	.oeh-crumb {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		margin: 0;
		padding: 0 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--w-mute);
		font: var(--w-t-label);
		cursor: pointer;
		transition: color var(--w-dur-1) var(--w-ease);
	}
	.oeh-crumb:hover {
		color: var(--w-text);
	}
	.oeh-crumb:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}
	/* The glyph shows only once the words collapse (below a 760px stage). */
	.oeh-crumb :global(.oeh-crumb__glyph) {
		display: none;
	}
	.oeh-chip {
		flex: none;
		align-self: center;
	}
	:global(.oeh-sep) {
		flex: none;
		color: var(--w-faint);
	}
	/* The title is the document's name, not a field: borderless serif until hovered or focused. */
	/* As wide as the name (field-sizing), between 96px and 46ch; it shrinks before the actions. */
	.oeh-title {
		flex: 0 1 auto;
		box-sizing: border-box;
		min-width: 96px;
		max-width: 46ch;
		field-sizing: content;
		height: 34px;
		margin: 0;
		padding: 0 6px;
		border: var(--w-bw, 1px) solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--w-text);
		font: 400 calc(19px * var(--w-fs)) / 1.25 var(--w-serif);
		text-overflow: ellipsis;
		transition:
			border-color var(--w-dur-1) var(--w-ease),
			box-shadow var(--w-dur-1) var(--w-ease);
	}
	@supports not (field-sizing: content) {
		.oeh-title {
			width: 22ch;
		}
	}
	.oeh-title:hover:not(:disabled) {
		border-color: var(--w-line-strong);
	}
	.oeh-title:focus-visible {
		border-color: var(--w-accent);
		outline: 2px solid color-mix(in srgb, var(--w-accent) 35%, transparent);
		outline-offset: 0;
	}
	.oeh-title:disabled {
		opacity: 1;
		color: var(--w-text);
		cursor: default;
	}
	.oeh-scope__dot {
		display: none;
	}
	.oeh-status {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-micro);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The mode segment closes the lead, just before the actions. */
	:global(.oeh-modes) {
		flex: none;
		margin-inline-start: auto;
	}

	/* Phones: the title keeps the room. The chevron, the locality tag and the save state step out
	   of row A; ⋯ repeats the locality and the save state in its heading. */
	@container stage (max-width: 599.98px) {
		.oeh-crumb,
		:global(.oeh-sep),
		.oeh-scope,
		.oeh-status {
			display: none;
		}
		.oeh-title {
			flex: 1 1 auto;
			width: auto;
			min-width: 48px;
		}
	}

	@container stage (max-width: 759.98px) {
		.oeh-crumb__words,
		.oeh-scope__words {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
		.oeh-crumb :global(.oeh-crumb__glyph) {
			display: block;
		}
		.oeh-scope__dot {
			display: inline-block;
		}
		.oeh-title {
			max-width: 24ch;
		}
	}
	@container stage (max-width: 759.98px) {
		@supports not (field-sizing: content) {
			.oeh-title {
				width: 14ch;
			}
		}
	}
</style>
