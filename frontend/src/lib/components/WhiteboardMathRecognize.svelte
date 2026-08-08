<script lang="ts">
	import { renderToString } from 'katex';
	import { formatConfidence } from '$lib/whiteboard/recognitionUi';

	interface Props {
		latex: string;
		confidence: number;
		partial: boolean;
		onAccept: (editedLatex: string) => void;
		onDismiss: () => void;
	}

	let { latex, confidence, partial, onAccept, onDismiss }: Props = $props();

	let edited = $state(latex);
	let inputEl: HTMLTextAreaElement | null = $state(null);

	$effect(() => {
		inputEl?.focus();
	});

	const previewHtml = $derived.by(() => {
		if (!edited.trim()) return '';
		try {
			return renderToString(edited, {
				displayMode: false,
				output: 'html',
				throwOnError: false,
				strict: 'ignore'
			});
		} catch {
			return '';
		}
	});

	const confidenceLabel = $derived(formatConfidence(confidence));
	const confidenceLevel = $derived(
		confidence >= 0.7 ? 'high' : confidence >= 0.4 ? 'medium' : 'low'
	);

	function handleKeydown(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			onAccept(edited.trim());
		} else if (event.key === 'Escape') {
			event.preventDefault();
			onDismiss();
		}
	}
</script>

<div
	class="wr-overlay"
	role="dialog"
	aria-modal="true"
	aria-label="Recognized math"
	on:keydown={handleKeydown}
>
	<div class="wr-panel">
		<header class="wr-header">
			<h2 class="wr-title">Recognized math</h2>
			<span class="wr-badge wr-badge-{confidenceLevel}" title="Recognition confidence">
				{confidenceLabel}
			</span>
		</header>

		{#if partial}
			<p class="wr-note" role="note">
				Some symbols were uncertain — check the LaTeX below before accepting.
			</p>
		{/if}

		<div class="wr-preview" aria-live="polite">{@html previewHtml}</div>

		<textarea
			bind:this={inputEl}
			class="wr-input"
			bind:value={edited}
			rows="2"
			spellcheck="false"
			autocomplete="off"
			placeholder="LaTeX"
		></textarea>

		<footer class="wr-footer">
			<button type="button" class="wr-btn wr-btn-ghost" on:click={onDismiss}>Dismiss</button>
			<button
				type="button"
				class="wr-btn wr-btn-primary"
				disabled={!edited.trim()}
				on:click={() => onAccept(edited.trim())}
			>
				Accept
			</button>
		</footer>
	</div>
</div>

<style>
	.wr-overlay {
		position: absolute;
		inset: 0;
		z-index: 40;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.25rem;
		background: color-mix(in srgb, var(--surface-sunken, #0f0c29) 55%, transparent);
		backdrop-filter: blur(4px);
	}

	.wr-panel {
		width: min(440px, 100%);
		max-height: 100%;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 1.25rem 1.3rem;
		border-radius: var(--radius-lg, 12px);
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 30%, transparent);
		background: color-mix(in srgb, var(--surface-raised, #302b63) 82%, transparent);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 44px rgba(var(--surface-app-rgb, 15, 23, 42), 0.35);
	}

	.wr-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
	}

	.wr-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-heading, #e0e0ff);
	}

	.wr-badge {
		flex-shrink: 0;
		padding: 0.18rem 0.6rem;
		border-radius: 999px;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
	}

	.wr-badge-high {
		background: color-mix(in srgb, var(--color-success, #22c55e) 16%, transparent);
		border-color: color-mix(in srgb, var(--color-success, #22c55e) 34%, transparent);
		color: var(--color-success, #22c55e);
	}

	.wr-badge-medium {
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 16%, transparent);
		border-color: color-mix(in srgb, var(--color-warning, #f59e0b) 34%, transparent);
		color: var(--color-warning, #f59e0b);
	}

	.wr-badge-low {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 16%, transparent);
		border-color: color-mix(in srgb, var(--color-danger, #ef4444) 34%, transparent);
		color: var(--color-danger, #ef4444);
	}

	.wr-note {
		margin: 0;
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--color-warning, #f59e0b);
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 24%, transparent);
		border-radius: var(--radius-sm, 4px);
		padding: 0.45rem 0.6rem;
	}

	.wr-preview {
		min-height: 4.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.9rem 1rem;
		border-radius: var(--radius-md, 8px);
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 18%, transparent);
		background: color-mix(in srgb, var(--surface-base, #24243e) 60%, transparent);
		color: var(--text-heading, #e0e0ff);
		overflow-x: auto;
	}

	.wr-preview :global(.katex) {
		font-size: 1.35rem;
	}

	.wr-input {
		width: 100%;
		resize: vertical;
		padding: 0.6rem 0.7rem;
		border-radius: var(--radius-md, 8px);
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 34%, transparent);
		background: color-mix(in srgb, var(--surface-sunken, #0f0c29) 60%, transparent);
		color: var(--text-heading, #e0e0ff);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
		font-size: 0.86rem;
		line-height: 1.45;
		box-sizing: border-box;
	}

	.wr-input:focus {
		outline: none;
		border-color: var(--accent-primary, #6366f1);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary, #6366f1) 26%, transparent);
	}

	.wr-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.wr-btn {
		padding: 0.42rem 0.95rem;
		border-radius: var(--radius-md, 8px);
		border: 1px solid transparent;
		font-size: 0.82rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		cursor: pointer;
		transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
	}

	.wr-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.wr-btn-primary {
		background: var(--accent-primary, #6366f1);
		border-color: var(--accent-primary, #6366f1);
		color: #ffffff;
	}

	.wr-btn-primary:hover:not(:disabled) {
		background: var(--accent-secondary, #818cf8);
	}

	.wr-btn-ghost {
		background: transparent;
		border-color: color-mix(in srgb, var(--text-muted, #9999ff) 26%, transparent);
		color: var(--text-secondary, #b3b3ff);
	}

	.wr-btn-ghost:hover {
		border-color: color-mix(in srgb, var(--text-muted, #9999ff) 44%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	@media (prefers-reduced-motion: reduce) {
		.wr-btn {
			transition: none;
		}
	}
</style>
