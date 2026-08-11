<script lang="ts">
	interface Props { before: string; after: string; beforeLabel?: string; afterLabel?: string; }
	let { before, after, beforeLabel = 'Before', afterLabel = 'After' }: Props = $props();
	let mode = $state<'split' | 'overlay'>('split');
	let reveal = $state(50);
	let zoom = $state(1);
</script>

<div class="image-compare" aria-label="Artwork version comparison">
	<div class="compare-toolbar">
		<div class="mode-tabs"><button class:active={mode === 'split'} onclick={() => mode = 'split'}>Split</button><button class:active={mode === 'overlay'} onclick={() => mode = 'overlay'}>Overlay</button></div>
		<label>Reveal <input type="range" min="0" max="100" bind:value={reveal} /></label>
		<button onclick={() => zoom = Math.min(3, zoom + 0.25)}>+</button><span>{Math.round(zoom * 100)}%</span><button onclick={() => zoom = Math.max(0.5, zoom - 0.25)}>−</button>
	</div>
	<div class="compare-stage" style={`--reveal: ${reveal}%;`}>
		<div class="image-pane before"><span>{beforeLabel}</span><img src={before} alt={beforeLabel} style={`transform: scale(${zoom})`} /></div>
		<div class="image-pane after"><span>{afterLabel}</span><img src={after} alt={afterLabel} style={`transform: scale(${zoom})`} /></div>
		{#if mode === 'overlay'}<div class="overlay-image"><img src={before} alt="Previous version overlay" style={`transform: scale(${zoom})`} /></div>{/if}
	</div>
</div>

<style>
	.image-compare { display: flex; flex-direction: column; height: 100%; min-height: 280px; background: var(--surface-sunken); color: var(--text-heading); }
	.compare-toolbar { display: flex; align-items: center; justify-content: center; gap: var(--space-2); flex-wrap: wrap; padding: var(--space-2); background: var(--surface-raised); border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent); font-size: var(--font-size-xs); }
	.compare-toolbar button, .mode-tabs button { padding: var(--space-1) var(--space-2); border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; }
	.compare-toolbar button.active, .mode-tabs button.active { background: var(--accent-primary); color: var(--text-inverse, white); }
	.mode-tabs { display: flex; gap: var(--space-1); }
	.compare-stage { position: relative; flex: 1; min-height: 240px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: repeating-conic-gradient(var(--surface-base) 0 25%, var(--surface-raised) 0 50%) 50% / 20px 20px; }
	.image-pane { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
	.image-pane img, .overlay-image img { max-width: 100%; max-height: 100%; object-fit: contain; transition: transform var(--duration-fast) var(--ease-out); }
	.image-pane span { position: absolute; z-index: 2; top: var(--space-2); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--surface-sunken) 80%, transparent); color: var(--text-heading); font-size: var(--font-size-xs); }
	.before span { left: var(--space-2); }.after span { right: var(--space-2); }
	.after { clip-path: inset(0 0 0 var(--reveal)); }
	.overlay-image { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: calc(var(--reveal) / 100); pointer-events: none; overflow: hidden; }
</style>
