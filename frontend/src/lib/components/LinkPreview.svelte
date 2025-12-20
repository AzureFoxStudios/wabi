<script lang="ts">
	import { onMount } from 'svelte';

	export let url: string;

	let preview: any = null;
	let loading = true;
	let error = false;

	onMount(async () => {
		try {
			// Use current server origin instead of hardcoded ngrok URL
			const serverUrl = window.location.origin;

			// Add timeout to prevent infinite loading
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

			const response = await fetch(`${serverUrl}/api/url-preview?url=${encodeURIComponent(url)}`, {
				headers: {
					'ngrok-skip-browser-warning': 'true'
				},
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
	{#if preview.type === 'video.youtube' && preview.youtubeId}
		<div class="youtube-embed">
			<iframe
				src="https://www.youtube.com/embed/{preview.youtubeId}"
				title={preview.title || 'YouTube video'}
				frameborder="0"
				allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
				allowfullscreen
			></iframe>
		</div>
	{:else}
		<div class="link-preview" on:click={handleClick}>
			{#if preview.image}
				<div class="preview-image">
					<img src={preview.image} alt={preview.title || 'Preview'} loading="lazy" />
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

	.youtube-embed {
		position: relative;
		padding-bottom: 56.25%; /* 16:9 aspect ratio */
		height: 0;
		overflow: hidden;
		max-width: 380px;
		margin: 0.5rem 0;
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.youtube-embed iframe {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		border-radius: 8px;
	}

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
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.preview-description {
		font-size: 0.85rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
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

		.youtube-embed {
			max-width: 100%;
		}
	}
</style>
