<script lang="ts">
	import { page } from '$app/stores';
	import '../styles/public-pages.css';

	$: status = $page.status;
	$: notFound = status === 404;
</script>

<svelte:head>
	<title>{notFound ? 'Page not found' : 'Something went wrong'} · Wabi</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="public-page">
	<a class="public-skip" href="#main-content">Skip to content</a>
	<header class="public-header" id="page-top">
		<a class="public-home" href="/" aria-label="Back to Wabi">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
			<span class="public-mark" aria-hidden="true"></span>
			<span>Wabi</span>
		</a>
		<nav class="public-nav" aria-label="Project information">
			<a href="/privacy">Privacy</a>
			<a href="/terms">Terms</a>
			<a href="https://github.com/AzureFoxStudios/wabi">Source code</a>
		</nav>
	</header>
	<main class="public-reading public-error" id="main-content" tabindex="-1" aria-labelledby="error-title">
		<p class="public-status">{status}</p>
		<h1 id="error-title">{notFound ? 'This page wandered off.' : 'Wabi hit a snag.'}</h1>
		<p class="public-lede">
			{notFound
				? 'The address may be old, mistyped, or no longer available.'
				: 'Your workspace is still yours. Try the page again, or return to Wabi.'}
		</p>
		<div class="public-actions">
			<a class="public-action public-action-primary" href="/">Back to Wabi</a>
			<button class="public-action" type="button" on:click={() => history.back()}>Go back</button>
		</div>
	</main>
</div>
