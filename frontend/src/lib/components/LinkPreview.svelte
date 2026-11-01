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

	function onKey(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleClick();
		}
	}

	$: kind = preview?.youtubeId ? 'video' : (preview?.kind as string | undefined) ?? 'link';
	$: host = hostOf(url);
	$: largeMedia = preview?.twitterCard === 'summary_large_image' || Boolean(preview?.video);
	// A response with neither title nor text has nothing to show beyond the address.
	$: empty = !!preview && !preview.title && !preview.description && !heroImage;
</script>

<!-- Nothing renders until a readable preview exists: the link is already in the message text,
     so a loading shimmer or a "preview unavailable" card would only repeat it (§7.19). -->
{#if !loading && !error && !empty && preview}
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
				<button type="button" class="lc-poster" on:click={() => (playing = true)} aria-label="Play video">
					{#if heroImage}<img src={heroImage} alt="" loading="lazy" />{/if}
					<span class="lc-play" aria-hidden="true"><span class="lc-play__tri"></span></span>
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
				<span class="lc-site">{(preview.siteName || host).replace(/\s*\(formerly twitter\)/i, '')}</span>
				{#if preview.published}<span class="lc-sep">·</span><span>{preview.published}</span>{/if}
			</div>
			<div class="lc-author">
				<!-- A text post's Open Graph image is the author's portrait: show it as an avatar, not as media. -->
				{#if heroImage && !largeMedia}<img class="lc-avatar" src={heroImage} alt="" loading="lazy" />{/if}
				<span class="lc-who">
					<span class="lc-name">{preview.author || preview.title}</span>
					{#if preview.authorHandle}<span class="lc-handle">{preview.authorHandle}</span>{/if}
				</span>
			</div>
			{#if preview.description}<p class="lc-text">{preview.description}</p>{/if}
			{#if heroImage && largeMedia}<div class="lc-media"><img src={heroImage} alt="" loading="lazy" /></div>{/if}
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
	/* Link cards (§7.19): an object in flow — lift, hairline, md corners. Host in mono, title as a
	   label, at most two lines of description, an optional 80px thumbnail on the right. */
	.lc {
		display: block;
		box-sizing: border-box;
		max-width: 440px;
		margin: 6px 0 0;
		padding: 10px 12px;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
		background: var(--w-lift);
		box-shadow: var(--w-shadow-1);
		color: var(--w-text);
		text-align: left;
		text-decoration: none;
		overflow: hidden;
		transition: border-color var(--w-dur-1) var(--w-ease);
	}
	.lc[role='link'] { cursor: pointer; }
	.lc:hover { border-color: var(--w-line-strong); }
	.lc:focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }

	.lc-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font: var(--w-t-mono); color: var(--w-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.lc-site { color: var(--w-faint); text-transform: lowercase; }
	.lc-sep { color: var(--w-faint); }
	.lc-title { display: block; margin-top: 4px; font: var(--w-t-label); color: var(--w-text); text-decoration: none; overflow-wrap: anywhere; }
	a.lc-title:hover { text-decoration: underline; text-decoration-thickness: var(--w-bw); text-underline-offset: 3px; }
	.lc-mono { font: 500 calc(13px * var(--w-fs)) / calc(18px * var(--w-fs)) var(--w-mono); }
	.lc-text { margin: 4px 0 0; font: var(--w-t-small); color: var(--w-mute); overflow-wrap: anywhere; white-space: pre-line; }
	.lc-clamp-2, .lc-clamp-3 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; -webkit-line-clamp: 2; line-clamp: 2; }

	/* post */
	.lc-author { display: flex; align-items: center; gap: 10px; margin-top: 8px; min-width: 0; }
	.lc-avatar { flex: none; width: 36px; height: 36px; object-fit: cover; border-radius: var(--w-avr); border: var(--w-bw) solid var(--w-line); }
	.lc-who { display: flex; flex-direction: column; min-width: 0; }
	.lc-name { font: var(--w-t-label); }
	.lc-handle { font: var(--w-t-mono); color: var(--w-faint); }
	.lc-post .lc-text { margin-top: 6px; font: var(--w-t-chat); color: var(--w-text); }
	.lc-media { margin-top: 8px; border-radius: var(--radius-inner); overflow: hidden; border: var(--w-bw) solid var(--w-line); background: var(--w-sink); }
	.lc-media img { display: block; width: 100%; max-height: 280px; object-fit: cover; }

	/* article / link: text left, 80px thumbnail right */
	.lc-article { display: flex; gap: 12px; align-items: flex-start; }
	.lc-article .lc-body { flex: 1; min-width: 0; }
	.lc-thumb { flex: none; width: 80px; height: 80px; object-fit: cover; border-radius: var(--radius-inner); border: var(--w-bw) solid var(--w-line); background: var(--w-sink); }

	/* audio */
	.lc-audio { display: flex; gap: 12px; align-items: center; }
	.lc-audio .lc-body { flex: 1; min-width: 0; }
	.lc-cover { flex: none; width: 56px; height: 56px; object-fit: cover; border-radius: var(--radius-inner); }

	/* video */
	.lc-video { padding: 0; }
	.lc-video .lc-body { padding: 10px 12px; }
	.lc-poster, .lc-embed { position: relative; display: block; width: 100%; aspect-ratio: 16 / 9; padding: 0; border: 0; background: var(--w-sink); cursor: pointer; }
	.lc-poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
	.lc-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
	.lc-play { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px; display: grid; place-items: center; border-radius: var(--w-pill); background: var(--w-bg); border: var(--w-bw) solid var(--w-line-strong); color: var(--w-text); transition: background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease); }
	.lc-play__tri { width: 0; height: 0; margin-left: 3px; border-style: solid; border-width: 7px 0 7px 12px; border-color: transparent transparent transparent currentColor; }
	.lc-poster:hover .lc-play { background: var(--w-text); color: var(--w-bg); border-color: var(--w-text); }
	.lc-poster:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px; }
</style>
