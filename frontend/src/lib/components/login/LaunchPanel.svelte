<script lang="ts">
	import type { LaunchPageConfig } from '$lib/api';
	export let config: LaunchPageConfig;
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
		border-radius: 16px;
		padding: 2rem;
		color: var(--launch-text);
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.launch-hero-image {
		width: 100%;
		max-height: 220px;
		object-fit: cover;
		border-radius: 12px;
		border: 1px solid var(--surface-hover, rgba(255, 255, 255, 0.15));
	}

	.launch-brand {
		font-size: 0.82rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.78);
		font-weight: 700;
	}

	.launch-panel h1 {
		margin: 0;
		font-size: clamp(1.5rem, 2.3vw, 2.2rem);
		line-height: 1.2;
	}

	.launch-panel p {
		margin: 0;
		color: rgba(255, 255, 255, 0.84);
		line-height: 1.55;
	}

	.launch-primary-cta {
		align-self: flex-start;
		text-decoration: none;
		color: var(--color-border);
		background: var(--launch-accent);
		padding: 0.7rem 1rem;
		border-radius: 10px;
		font-weight: 700;
		transition: transform 0.2s ease;
	}

	.launch-primary-cta:hover {
		transform: translateY(-1px);
	}

	.launch-highlights {
		list-style: none;
		padding: 0;
		margin: 0.25rem 0 0 0;
		display: grid;
		gap: 0.65rem;
	}

	.launch-highlights li {
		display: grid;
		gap: 0.2rem;
		padding-left: 0.9rem;
		border-left: 2px solid rgba(255, 255, 255, 0.26);
	}

	.launch-highlights strong {
		font-size: 0.94rem;
	}

	.launch-highlights span {
		font-size: 0.84rem;
		color: rgba(255, 255, 255, 0.75);
	}

	@media (max-width: 768px) {
		.launch-panel {
			padding: 1.2rem;
			gap: 0.65rem;
		}
	}
</style>
