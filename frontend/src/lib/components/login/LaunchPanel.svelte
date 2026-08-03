<script lang="ts">
	import type { LaunchPageConfig } from '$lib/api';

	let { config }: { config: LaunchPageConfig } = $props();
</script>

<section class="launch-panel">
	{#if config.heroImageUrl}
		<img class="launch-hero-image" src={config.heroImageUrl} alt={config.brandName} />
	{/if}
	<div class="launch-brand">{config.brandName}</div>
	<h1>{config.heroTitle || config.headline}</h1>
	{#if config.heroBody || config.subheadline}
		<p>{config.heroBody || config.subheadline}</p>
	{/if}
	{#if config.heroPrimaryCtaLabel && config.heroPrimaryCtaUrl}
		<a class="launch-primary-cta" href={config.heroPrimaryCtaUrl} target="_blank" rel="noreferrer">
			{config.heroPrimaryCtaLabel}
		</a>
	{/if}
	{#if config.highlights.length > 0}
		<ul class="launch-highlights">
			{#each config.highlights as highlight, i (i)}
				<li>
					<strong>{highlight.title}</strong>
					<span>{highlight.description}</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.launch-panel {
		background: linear-gradient(180deg, var(--surface-modal-overlay, rgba(5, 8, 18, 0.7)) 0%, var(--surface-modal-overlay, rgba(5, 8, 18, 0.4)) 100%);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		border: 1px solid var(--surface-hover, rgba(255, 255, 255, 0.12));
		border-radius: var(--radius-xl, 16px);
		padding: clamp(1.5rem, 3vw, 2.25rem);
		color: var(--launch-text, var(--text-heading));
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.launch-hero-image {
		width: 100%;
		max-height: 220px;
		object-fit: cover;
		border-radius: var(--radius-lg, 12px);
		border: 1px solid var(--surface-hover, rgba(255, 255, 255, 0.15));
	}

	.launch-brand {
		font-size: var(--text-xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--launch-text, #ffffff) 72%, transparent);
		font-weight: var(--font-weight-semibold);
	}

	.launch-panel h1 {
		margin: 0;
		font-size: clamp(1.55rem, 2.4vw, 2.35rem);
		line-height: var(--line-height-tight);
		letter-spacing: -0.02em;
		font-weight: var(--font-weight-bold);
	}

	.launch-panel p {
		margin: 0;
		color: color-mix(in srgb, var(--launch-text, #ffffff) 82%, transparent);
		line-height: var(--line-height-relaxed);
		font-size: var(--text-base);
	}

	.launch-primary-cta {
		align-self: flex-start;
		text-decoration: none;
		color: var(--neutral-surface-sunken, #101012);
		background: var(--launch-accent, var(--accent-primary-color));
		padding: 0.72rem 1.25rem;
		border-radius: var(--radius-lg, 12px);
		font-weight: var(--font-weight-bold);
		font-size: var(--text-sm);
		letter-spacing: 0.01em;
		box-shadow: 0 8px 24px color-mix(in srgb, var(--launch-accent, var(--accent-primary-color)) 26%, transparent);
		transition: transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out), filter var(--duration-fast) var(--ease-out);
	}

	.launch-primary-cta:hover {
		transform: translateY(-1px);
		filter: brightness(1.06);
		box-shadow: 0 12px 30px color-mix(in srgb, var(--launch-accent, var(--accent-primary-color)) 34%, transparent);
	}

	.launch-highlights {
		list-style: none;
		padding: 0;
		margin: 0.35rem 0 0 0;
		display: grid;
		gap: 0.6rem;
	}

	.launch-highlights li {
		display: grid;
		gap: 0.2rem;
		padding-left: 0.9rem;
		border-left: 2px solid color-mix(in srgb, var(--launch-text, #ffffff) 26%, transparent);
	}

	.launch-highlights strong {
		font-size: var(--text-sm);
		font-weight: var(--font-weight-semibold);
	}

	.launch-highlights span {
		font-size: var(--text-xs);
		color: color-mix(in srgb, var(--launch-text, #ffffff) 72%, transparent);
		line-height: 1.5;
	}

	@media (max-width: 768px) {
		.launch-panel {
			padding: 1.2rem;
			gap: 0.65rem;
		}
	}
</style>
