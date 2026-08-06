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
		position: relative;
		background: linear-gradient(
			180deg,
			var(--surface-modal-overlay, rgba(5, 8, 18, 0.72)) 0%,
			var(--surface-modal-overlay, rgba(5, 8, 18, 0.45)) 100%
		);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		border: 1px solid color-mix(in srgb, var(--launch-text, #ffffff) 14%, transparent);
		border-radius: var(--radius-2xl);
		padding: clamp(1.75rem, 3vw, 2.5rem);
		color: var(--launch-text, var(--text-heading));
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		box-shadow:
			0 32px 90px rgba(0, 0, 0, 0.42),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
		animation: launchPanelIn 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
		overflow: hidden;
	}

	.launch-panel::before {
		content: '';
		position: absolute;
		inset: 0;
		background: radial-gradient(
			ellipse 28rem 18rem at 20% 0%,
			color-mix(in srgb, var(--launch-accent, var(--accent-primary-color)) 14%, transparent),
			transparent 70%
		);
		pointer-events: none;
	}

	.launch-panel > * {
		position: relative;
	}

	@keyframes launchPanelIn {
		from { opacity: 0; transform: translateY(14px) scale(0.985); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}

	.launch-hero-image {
		width: 100%;
		max-height: 240px;
		object-fit: cover;
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--launch-text, #ffffff) 16%, transparent);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
	}

	.launch-brand {
		font-size: var(--text-xs);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--launch-text, #ffffff) 72%, transparent);
		font-weight: var(--font-weight-semibold);
	}

	.launch-panel h1 {
		margin: 0;
		font-size: clamp(1.9rem, 3vw, 2.6rem);
		line-height: 1.08;
		letter-spacing: -0.025em;
		font-weight: var(--font-weight-bold);
	}

	.launch-panel p {
		margin: 0;
		color: color-mix(in srgb, var(--launch-text, #ffffff) 84%, transparent);
		line-height: var(--line-height-relaxed);
		font-size: var(--text-base);
		max-width: 46ch;
	}

	.launch-primary-cta {
		align-self: flex-start;
		text-decoration: none;
		color: var(--neutral-surface-sunken, #101012);
		background: var(--launch-accent, var(--accent-primary-color));
		padding: 0.78rem 1.35rem;
		border-radius: var(--radius-lg);
		font-weight: var(--font-weight-bold);
		font-size: var(--text-sm);
		letter-spacing: 0.01em;
		box-shadow:
			0 10px 28px color-mix(in srgb, var(--launch-accent, var(--accent-primary-color)) 30%, transparent),
			inset 0 1px 0 rgba(255, 255, 255, 0.25);
		transition:
			transform var(--duration-fast) var(--ease-out),
			box-shadow var(--duration-fast) var(--ease-out),
			filter var(--duration-fast) var(--ease-out);
	}

	.launch-primary-cta:hover {
		transform: translateY(-1px);
		filter: brightness(1.07);
		box-shadow:
			0 14px 34px color-mix(in srgb, var(--launch-accent, var(--accent-primary-color)) 38%, transparent),
			inset 0 1px 0 rgba(255, 255, 255, 0.32);
	}

	.launch-primary-cta:active {
		transform: translateY(1px) scale(0.99);
	}

	.launch-highlights {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0 0;
		display: grid;
		gap: 0.75rem;
	}

	.launch-highlights li {
		display: grid;
		gap: 0.22rem;
		padding-left: 1rem;
		position: relative;
	}

	.launch-highlights li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.4rem;
		width: 3px;
		height: calc(100% - 0.6rem);
		border-radius: var(--radius-full);
		background: linear-gradient(
			180deg,
			var(--launch-accent, var(--accent-primary-color)),
			color-mix(in srgb, var(--launch-accent, var(--accent-primary-color)) 30%, transparent)
		);
	}

	.launch-highlights strong {
		font-size: var(--text-sm);
		font-weight: var(--font-weight-semibold);
	}

	.launch-highlights span {
		font-size: var(--text-xs);
		color: color-mix(in srgb, var(--launch-text, #ffffff) 74%, transparent);
		line-height: 1.55;
	}

	@media (max-width: 768px) {
		.launch-panel {
			padding: 1.35rem;
			gap: 0.7rem;
		}

		.launch-panel h1 {
			font-size: clamp(1.6rem, 7vw, 2rem);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.launch-panel {
			animation: none;
		}

		.launch-primary-cta {
			transition: none;
		}
	}
</style>
