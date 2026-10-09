<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';

	export let url: string;

	let preview: any = null;
	let loading = true;
	let error = false;
	let playing = false;

	// The preview endpoints require auth, so the card image is fetched with
	// headers and shown as an object URL — an <img> cannot carry them.
	let heroImage = '';
	const objectUrls: string[] = [];

	let disposed = false;
	const controller = new AbortController();
	onDestroy(() => {
		disposed = true;
		controller.abort();
		for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
	});

	function authHeaders(): Record<string, string> {
		const headers: Record<string, string> = {};
		const token = getAuthToken();
		if (token) headers['Authorization'] = `Bearer ${token}`;
		// Only needed when the backend is behind ngrok.
		if (getServerUrl().includes('ngrok')) headers['ngrok-skip-browser-warning'] = 'true';
		return headers;
	}

	onMount(async () => {
		try {
			const serverUrl = getServerUrl();

			// Add timeout to prevent infinite loading
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

			const response = await fetch(`${serverUrl}/api/url-preview?url=${encodeURIComponent(url)}`, {
				headers: authHeaders(),
				signal: controller.signal
			});

			clearTimeout(timeoutId);

			if (disposed || getServerUrl() !== serverUrl) return;
			if (response.ok) {
				preview = await response.json();
			} else {
				error = true;
			}
		} catch (err) {
			console.error('Link preview error:', err);
			error = true;
		} finally {
			if (!disposed) loading = false;
		}
	});

	$: void loadHeroImage(preview);

	async function loadHeroImage(current: any): Promise<void> {
		const candidate = !current
			? ''
			: current.image ||
				(current.youtubeId ? `https://i.ytimg.com/vi/${current.youtubeId}/maxresdefault.jpg` : '');
		if (!candidate) {
			heroImage = '';
			return;
		}
		try {
			const response = await fetch(
				`${getServerUrl()}/api/image-proxy?url=${encodeURIComponent(candidate)}`,
				{ headers: authHeaders(), signal: controller.signal }
			);
			if (!response.ok) return;
			const blob = await response.blob();
			if (disposed || !current || current !== preview) return;
			const objectUrl = URL.createObjectURL(blob);
			objectUrls.push(objectUrl);
			heroImage = objectUrl;
		} catch {
			// Text-only card is a fine fallback.
		}
	}

	function handleClick() {
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function hostOf(raw: string): string {
		try {
			return new URL(raw).hostname.replace(/^www\./, '');
		} catch {
			return raw;
		}
	}

	function pathOf(raw: string): string {
		try {
			const u = new URL(raw);
			const path = u.pathname === '/' ? '' : u.pathname;
			return decodeURIComponent(path + u.search).slice(0, 80);
		} catch {
			return '';
		}
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleClick();
		}
	}

	$: kind = preview?.youtubeId ? 'video' : (preview?.kind as string | undefined) ?? 'link';
	$: host = hostOf(url);
	// A response with neither title nor text has nothing to show beyond the address.
	$: empty = !!preview && !preview.title && !preview.description && !heroImage;
</script>

{#if loading}
	<div class="lc lc-skeleton" aria-hidden="true"><span class="lc-bar"></span><span class="lc-bar short"></span></div>
{:else if error || empty}
	<!-- Nothing readable came back: say so, instead of printing the link a second time. -->
	<a class="lc lc-plain" href={url} target="_blank" rel="noopener noreferrer">
		<span class="lc-meta"><span class="lc-site">{host}</span><span class="lc-sep">·</span><span>preview unavailable</span></span>
		{#if pathOf(url)}<span class="lc-path">{pathOf(url)}</span>{/if}
	</a>
{:else if preview}
	{#if kind === 'video' && preview.youtubeId}
		<div class="lc lc-video">
			{#if playing}
				<div class="lc-embed">
					<iframe
						src="https://www.youtube.com/embed/{preview.youtubeId}?autoplay=1"
						title={preview.title || 'YouTube video'}
						frameborder="0"
						allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
						allowfullscreen
					></iframe>
				</div>
			{:else}
				<button class="lc-poster" on:click={() => (playing = true)} aria-label="Play video">
					{#if heroImage}<img src={heroImage} alt="" loading="lazy" />{/if}
					<span class="lc-play" aria-hidden="true">
						<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" /></svg>
					</span>
				</button>
			{/if}
			<div class="lc-body">
				<div class="lc-meta"><span class="lc-site">YouTube</span>{#if preview.channelName}<span class="lc-sep">·</span><span>{preview.channelName}</span>{/if}</div>
				{#if preview.title}<a class="lc-title" href={url} target="_blank" rel="noopener noreferrer">{preview.title}</a>{/if}
			</div>
		</div>
	{:else if kind === 'post'}
		<div class="lc lc-post" role="link" tabindex="0" on:click={handleClick} on:keydown={onKey}>
			<div class="lc-meta">
				<span class="lc-site">{preview.siteName || host}</span>
				{#if preview.published}<span class="lc-sep">·</span><span>{preview.published}</span>{/if}
			</div>
			<div class="lc-author">
				<span class="lc-name">{preview.author || preview.title}</span>
				{#if preview.authorHandle}<span class="lc-handle">{preview.authorHandle}</span>{/if}
			</div>
			{#if preview.description}<p class="lc-text">{preview.description}</p>{/if}
			{#if heroImage}<div class="lc-media"><img src={heroImage} alt="" loading="lazy" /></div>{/if}
		</div>
	{:else if kind === 'repo'}
		<div class="lc lc-repo" role="link" tabindex="0" on:click={handleClick} on:keydown={onKey}>
			<div class="lc-meta"><span class="lc-site">{preview.siteName || host}</span><span class="lc-sep">·</span><span>repository</span></div>
			<div class="lc-title lc-mono">{(preview.title || '').replace(/^GitHub - /, '').split(':')[0]}</div>
			{#if preview.description}<p class="lc-text">{preview.description.replace(/ - [^ ]+\/[^ ]+$/, '')}</p>{/if}
		</div>
	{:else if kind === 'audio'}
		<div class="lc lc-audio" role="link" tabindex="0" on:click={handleClick} on:keydown={onKey}>
			{#if heroImage}<img class="lc-cover" src={heroImage} alt="" loading="lazy" />{/if}
			<div class="lc-body">
				<div class="lc-meta"><span class="lc-site">{preview.siteName || host}</span><span class="lc-sep">·</span><span>audio</span></div>
				{#if preview.title}<div class="lc-title">{preview.title}</div>{/if}
				{#if preview.description}<p class="lc-text lc-clamp-2">{preview.description}</p>{/if}
			</div>
		</div>
	{:else}
		<div class="lc lc-article" role="link" tabindex="0" on:click={handleClick} on:keydown={onKey}>
			<div class="lc-body">
				<div class="lc-meta"><span class="lc-site">{preview.siteName || host}</span>{#if kind === 'article'}<span class="lc-sep">·</span><span>article</span>{/if}</div>
				{#if preview.title}<div class="lc-title">{preview.title}</div>{/if}
				{#if preview.description}<p class="lc-text lc-clamp-3">{preview.description}</p>{/if}
			</div>
			{#if heroImage}<img class="lc-thumb" src={heroImage} alt="" loading="lazy" />{/if}
		</div>
	{/if}
{/if}

<style>
	/* Link cards: flat, tight, information first. Colors and corners come from the theme roles. */
	.lc {
		display: block;
		box-sizing: border-box;
		max-width: 520px;
		margin: 6px 0;
		padding: 10px 12px 11px;
		border: var(--w-bw, 1px) solid var(--w-line);
		border-radius: calc(10px * var(--w-rs, 1));
		background: var(--w-bg2);
		color: var(--w-text);
		text-decoration: none;
		font-family: var(--w-sans);
		overflow: hidden;
		transition: border-color 0.15s;
	}
	.lc[role='link'] { cursor: pointer; }
	.lc:hover { border-color: var(--w-line-strong); }
	.lc:focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }

	.lc-meta { display: flex; align-items: center; gap: 6px; font: 500 11.5px/1.3 var(--w-mono); color: var(--w-faint); min-width: 0; }
	.lc-site { color: var(--w-mute); text-transform: lowercase; }
	.lc-sep { color: var(--w-line-strong); }
	.lc-title { display: block; margin-top: 5px; font: 600 15px/1.35 var(--w-sans); color: var(--w-text); text-decoration: none; overflow-wrap: anywhere; }
	a.lc-title:hover { color: var(--w-accent); }
	.lc-mono { font-family: var(--w-mono); font-weight: 500; font-size: 14px; }
	.lc-text { margin: 4px 0 0; font: 400 13.5px/1.55 var(--w-sans); color: var(--w-mute); overflow-wrap: anywhere; white-space: pre-line; }
	.lc-clamp-2, .lc-clamp-3 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
	.lc-clamp-2 { -webkit-line-clamp: 2; line-clamp: 2; }
	.lc-clamp-3 { -webkit-line-clamp: 3; line-clamp: 3; }

	/* skeleton + plain */
	.lc-skeleton { height: 62px; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
	.lc-bar { display: block; height: 8px; width: 70%; border-radius: 2px; background: var(--w-line); }
	.lc-bar.short { width: 40%; }
	.lc-plain { display: flex; flex-direction: column; gap: 3px; padding: 8px 12px; }
	.lc-plain .lc-path { font: 400 12.5px/1.4 var(--w-mono); color: var(--w-mute); overflow-wrap: anywhere; }
	.lc-plain:hover .lc-path { color: var(--w-accent); }

	/* post */
	.lc-author { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; min-width: 0; }
	.lc-name { font: 600 14.5px/1.3 var(--w-sans); }
	.lc-handle { font: 500 12px/1.3 var(--w-mono); color: var(--w-faint); }
	.lc-post .lc-text { margin-top: 6px; font-size: 14.5px; line-height: 1.6; color: var(--w-text); }
	.lc-media { margin-top: 8px; border-radius: calc(8px * var(--w-rs, 1)); overflow: hidden; border: var(--w-bw, 1px) solid var(--w-line); }
	.lc-media img { display: block; width: 100%; max-height: 280px; object-fit: cover; }

	/* article / link: text left, small thumbnail right */
	.lc-article { display: flex; gap: 14px; align-items: flex-start; }
	.lc-article .lc-body { flex: 1; min-width: 0; }
	.lc-thumb { flex: none; width: 84px; height: 84px; object-fit: cover; border-radius: calc(7px * var(--w-rs, 1)); border: var(--w-bw, 1px) solid var(--w-line); }

	/* audio */
	.lc-audio { display: flex; gap: 12px; align-items: center; }
	.lc-audio .lc-body { flex: 1; min-width: 0; }
	.lc-cover { flex: none; width: 56px; height: 56px; object-fit: cover; border-radius: calc(6px * var(--w-rs, 1)); }

	/* video */
	.lc-video { padding: 0; max-width: 460px; }
	.lc-video .lc-body { padding: 9px 12px 11px; }
	.lc-poster, .lc-embed { position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; padding: 0; border: 0; background: var(--w-sink); cursor: pointer; }
	.lc-poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
	.lc-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
	.lc-play { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px; display: grid; place-items: center; border-radius: var(--w-pill, 999px); background: color-mix(in srgb, var(--w-bg) 78%, transparent); border: var(--w-bw, 1px) solid var(--w-line-strong); color: var(--w-text); transition: background 0.15s, color 0.15s; }
	.lc-play svg { width: 22px; height: 22px; fill: currentColor; margin-left: 2px; }
	.lc-poster:hover .lc-play { background: var(--w-accent); color: var(--w-on-accent); border-color: transparent; }
	.lc-poster:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px; }
</style>
