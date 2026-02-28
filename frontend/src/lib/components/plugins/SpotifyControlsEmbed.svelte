<script lang="ts">
	import { buildSpotifyEmbedUrl, buildSpotifyOpenUrl } from '$lib/spotifyControls';

	export let url: string;

	$: embedUrl = buildSpotifyEmbedUrl(url);
	$: openUrl = buildSpotifyOpenUrl(url);
</script>

{#if embedUrl}
	<div class="spotify-controls-card">
		<iframe
			src={embedUrl}
			title="Spotify player"
			loading="lazy"
			allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
			allowfullscreen
		></iframe>
		{#if openUrl}
			<div class="spotify-controls-actions">
				<a href={openUrl} target="_blank" rel="noopener noreferrer">Open in Spotify</a>
			</div>
		{/if}
	</div>
{/if}

<style>
	.spotify-controls-card {
		margin-top: 0.45rem;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
		background: color-mix(in srgb, var(--bg-tertiary) 88%, transparent);
		padding: 0.42rem;
	}

	.spotify-controls-card iframe {
		width: 100%;
		height: 152px;
		border: 0;
		border-radius: 10px;
		display: block;
		background: #121212;
	}

	.spotify-controls-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.32rem;
	}

	.spotify-controls-actions a {
		font-size: 0.72rem;
		color: var(--accent);
		text-decoration: none;
	}

	.spotify-controls-actions a:hover {
		text-decoration: underline;
	}

	@media (max-width: 768px) {
		.spotify-controls-card iframe {
			height: 132px;
		}
	}
</style>
