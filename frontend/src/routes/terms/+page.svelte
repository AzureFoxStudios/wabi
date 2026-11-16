<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount } from 'svelte';
	import { initializeTheme } from '$lib/theme/initTheme';
	import '../../styles/public-pages.css';

	// Reading pages are reachable signed out; apply the viewer's saved theme so they match the app.
	onMount(() => void initializeTheme(false));
</script>

<svelte:head>
	<title>{$_('error_page.terms')} · Wabi</title>
	<meta name="description" content={$_('terms.meta_desc')} />
	<link rel="canonical" href="https://wabi.chat/terms" />
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
			<a href="/terms" aria-current="page">{$_('error_page.terms')}</a>
			<a href="https://github.com/AzureFoxStudios/wabi">{$_('error_page.source_code')}</a>
		</nav>
	</header>
	<main class="public-reading" id="main-content" tabindex="-1" aria-labelledby="page-title">
		<article>
			<h1 id="page-title">{$_('error_page.terms')}</h1>
			<p class="public-effective">{$_('terms.effective')} <time datetime="2026-09-14">{$_('terms.effective_date')}</time></p>
			<p class="public-lede">{$_('terms.lede')}</p>

			<h2>{$_('terms.h_using')}</h2>
			<p>{$_('terms.p_using')}</p>

			<h2>{$_('terms.h_self_hosted')}</h2>
			<p>{$_('terms.p_self_hosted')}</p>

			<h2>{$_('terms.h_accounts')}</h2>
			<p>{$_('terms.p_accounts')}</p>

			<h2>{$_('terms.h_user_content')}</h2>
			<p>{$_('terms.p_user_content')}</p>

			<h2>{$_('terms.h_addons')}</h2>
			<p>{$_('terms.p_addons')}</p>

			<h2>{$_('terms.h_oss')}</h2>
			<p>{$_('terms.p_oss')}</p>

			<h2>{$_('terms.h_no_guarantee')}</h2>
			<p>{$_('terms.p_no_guarantee')}</p>

			<h2>{$_('terms.h_liability')}</h2>
			<p>{$_('terms.p_liability')}</p>

			<h2>{$_('lore_project.tab_changes')}</h2>
			<p>{$_('terms.p_changes')}</p>

		</article>
		<footer class="public-footer">
			<a href="/privacy">{$_('error_page.privacy')}</a>
			<a href="#page-top">{$_('terms.back_to_top')} <span aria-hidden="true">↑</span></a>
		</footer>
	</main>
</div>
