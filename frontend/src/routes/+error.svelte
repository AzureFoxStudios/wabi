<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { initializeTheme } from '$lib/theme/initTheme';
	import '../styles/public-pages.css';

	// Like /privacy and /terms (885b3712): the public pages' colours come from the theme tokens,
	// so without this the error page painted the default black text on the dark ground.
	onMount(() => void initializeTheme(false));

	$: status = $page.status;
	$: notFound = status === 404;
</script>

<svelte:head>
	<title>{notFound ? $_('error_page.page_not_found') : $_('error_page.something_went_wrong')} · Wabi</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="public-page">
	<a class="public-skip" href="#main-content">{$_('error_page.skip')}</a>
	<header class="public-header" id="page-top">
		<a class="public-home" href="/" aria-label={$_('error_page.back_to_wabi')}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>
			<span class="public-mark" aria-hidden="true"></span>
			<span>Wabi</span>
		</a>
		<nav class="public-nav" aria-label={$_('error_page.project_info')}>
			<a href="/privacy">{$_('error_page.privacy')}</a>
			<a href="/terms">{$_('error_page.terms')}</a>
			<a href="https://github.com/AzureFoxStudios/wabi">{$_('error_page.source_code')}</a>
		</nav>
	</header>
	<main class="public-reading public-error" id="main-content" tabindex="-1" aria-labelledby="error-title">
		<p class="public-status">{status}</p>
		<h1 id="error-title">{notFound ? $_('error_page.wandered_off') : $_('error_page.hit_snag')}</h1>
		<p class="public-lede">
			{notFound
				? $_('error_page.address_old')
				: $_('error_page.workspace_yours')}
		</p>
		<div class="public-actions">
			<a class="public-action public-action-primary" href="/">{$_('error_page.back_to_wabi')}</a>
			<button class="public-action" type="button" on:click={() => history.back()}>{$_('error_page.go_back')}</button>
		</div>
	</main>
</div>
