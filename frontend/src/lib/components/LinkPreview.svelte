<script lang="ts">
	import { onMount } from 'svelte';
	import { getServerUrl } from '$lib/serverUrl';

	export let url: string;

	let preview: any = null;
	let loading = true;
	let error = false;
	let playing = false;

	onMount(async () => {
		try {
			const serverUrl = getServerUrl();
			const headers: Record<string, string> = {};

			// Only needed when the backend is behind ngrok.
			if (serverUrl.includes('ngrok')) {
				headers['ngrok-skip-browser-warning'] = 'true';
			}

			// Add timeout to prevent infinite loading
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

			const response = await fetch(`${serverUrl}/api/url-preview?url=${encodeURIComponent(url)}`, {
				headers,
				signal: controller.signal
			});

			clearTimeout(timeoutId);

			if (response.ok) {
				preview = await response.json();
			} else {
				error = true;
			}
		} catch (err) {
			console.error('Link preview error:', err);
			error = true;
		} finally {
			loading = false;
		}
	});

	function proxyImage(imageUrl: string): string {
		const serverUrl = getServerUrl();
		return `${serverUrl}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
	}

	function handleClick() {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
</script>

{#if loading}
	<div class="preview-skeleton">
		<div class="skeleton-shimmer"></div>
	</div>
{:else if error}
	<a href={url} target="_blank" rel="noopener noreferrer" class="preview-link">
		{url}
	</a>
{:else if preview}
	{#if preview.youtubeId}
		<div class="youtube-preview">
			<div class="youtube-meta">
				{#if preview.channelName}
					<div class="youtube-channel">{preview.channelName}</div>
				{/if}
				{#if preview.title}
					<a href={url} target="_blank" rel="noopener noreferrer" class="youtube-title">
						{preview.title}
					</a>
				{/if}
				{#if preview.description}
					<div class="youtube-description">{preview.description}</div>
				{/if}
			</div>
			{#if playing}
				<div class="youtube-embed">
					<iframe
						src="https://www.youtube.com/embed/{preview.youtubeId}?autoplay=1"
						title={preview.title || 'YouTube video'}
						frameborder="0"
						allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
						allowfullscreen
					></iframe>
				</div>
			{:else}
				<button
					class="youtube-thumbnail"
					on:click={() => playing = true}
					aria-label="Play video"
				>
					<img
						src={proxyImage(preview.image || `https://i.ytimg.com/vi/${preview.youtubeId}/maxresdefault.jpg`)}
						alt={preview.title || 'YouTube video'}
						loading="lazy"
					/>
					<div class="play-button">
						<svg viewBox="0 0 68 48" width="68" height="48">
							<path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55C3.97 2.33 2.27 4.81 1.48 7.74.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#FF0000"/>
							<path d="M45 24L27 14v20" fill="#fff"/>
						</svg>
					</div>
				</button>
			{/if}
		</div>
	{:else}
		<div
			class="link-preview"
			role="button"
			tabindex="0"
			on:click={handleClick}
			on:keydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					handleClick();
				}
			}}
		>
			{#if preview.image}
				<div class="preview-image">
					<img src={proxyImage(preview.image)} alt={preview.title || 'Preview'} loading="lazy" />
				</div>
			{/if}
			<div class="preview-content">
				{#if preview.title}
					<div class="preview-title">{preview.title}</div>
				{/if}
				{#if preview.description}
					<div class="preview-description">{preview.description}</div>
				{/if}
				{#if preview.siteName}
					<div class="preview-site">{preview.siteName}</div>
				{/if}
			</div>
		</div>
	{/if}
{/if}

<style>
	.preview-skeleton {
		background: var(--bg-secondary);
		border-radius: 8px;
		height: 100px;
		margin: 0.5rem 0;
		position: relative;
		overflow: hidden;
	}

	.skeleton-shimmer {
		position: absolute;
		top: 0;
		left: -100%;
		height: 100%;
		width: 100%;
		background: linear-gradient(90deg, transparent, rgba(123, 104, 238, 0.1), transparent);
		animation: shimmer 1.5s infinite;
	}

	@keyframes shimmer {
		to {
			left: 100%;
		}
	}

	.preview-link {
		color: var(--color-info);
		text-decoration: underline;
		word-break: break-all;
	}

	/* YouTube preview */
	.youtube-preview {
		max-width: 430px;
		margin: 0.5rem 0;
		border-radius: 8px;
		overflow: hidden;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-left: 3px solid #FF0000;
	}

	.youtube-meta {
		padding: 0.75rem 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.youtube-channel {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.3px;
	}

	.youtube-title {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--color-info);
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.youtube-title:hover {
		text-decoration: underline;
	}

	.youtube-description {
		font-size: 0.8rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		margin-top: 0.15rem;
	}

	.youtube-thumbnail {
		position: relative;
		display: block;
		width: 100%;
		padding: 0;
		border: none;
		background: #000;
		cursor: pointer;
		aspect-ratio: 16 / 9;
	}

	.youtube-thumbnail img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		transition: opacity 0.2s;
	}

	.youtube-thumbnail:hover img {
		opacity: 0.85;
	}

	.play-button {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		opacity: 0.85;
		transition: opacity 0.2s, transform 0.2s;
	}

	.youtube-thumbnail:hover .play-button {
		opacity: 1;
		transform: translate(-50%, -50%) scale(1.1);
	}

	.youtube-embed {
		position: relative;
		padding-bottom: 56.25%; /* 16:9 */
		height: 0;
		overflow: hidden;
		background: #000;
	}

	.youtube-embed iframe {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
	}

	/* Generic link preview */
	.link-preview {
		display: flex;
		gap: 1rem;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		max-width: 600px;
		margin: 0.5rem 0;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.link-preview:hover {
		background: var(--bg-tertiary);
		border-color: var(--color-primary);
		box-shadow: 0 4px 12px rgba(123, 104, 238, 0.15);
	}

	.preview-image {
		flex-shrink: 0;
		width: 150px;
		height: 150px;
		background: var(--bg-primary);
	}

	.preview-image img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.preview-content {
		flex: 1;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.preview-title {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.preview-description {
		font-size: 0.85rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.preview-site {
		font-size: 0.75rem;
		color: var(--text-secondary);
		opacity: 0.7;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	@media (max-width: 768px) {
		.link-preview {
			flex-direction: column;
			max-width: 100%;
		}

		.preview-image {
			width: 100%;
			height: 200px;
		}

		.youtube-preview {
			max-width: 100%;
		}
	}
</style>
