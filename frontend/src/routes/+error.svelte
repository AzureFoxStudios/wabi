<script lang="ts">
	import { page } from '$app/stores';

	$: status = $page.status;
	$: notFound = status === 404;
</script>

<svelte:head>
	<title>{notFound ? 'Page not found' : 'Something went wrong'} · Wabi</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="error-page">
	<section class="error-card" aria-labelledby="error-title">
		<a class="brand" href="/" aria-label="Wabi home">
			<img src="/wabi-logo-small.webp" alt="" width="48" height="48" />
			<span>Wabi</span>
		</a>
		<p class="eyebrow">{status}</p>
		<h1 id="error-title">{notFound ? 'This page wandered off.' : 'Wabi hit a snag.'}</h1>
		<p class="body-copy">
			{notFound
				? 'The address may be old, mistyped, or no longer available.'
				: 'Your workspace is still yours. Try the page again, or return to Wabi.'}
		</p>
		<div class="actions">
			<a class="primary" href="/">Back to Wabi</a>
			<button class="secondary" type="button" on:click={() => history.back()}>Go back</button>
		</div>
	</section>
</main>

<style>
	.error-page { min-height: 100dvh; display: grid; place-items: center; padding: 24px; color: #eef2ff; }
	.error-card { width: min(560px, 100%); padding: clamp(28px, 6vw, 52px); border: 1px solid rgba(148,163,184,.2); border-radius: 28px; background: rgba(10,15,28,.78); box-shadow: 0 28px 80px rgba(0,0,0,.35); backdrop-filter: blur(22px); }
	.brand { display: inline-flex; align-items: center; gap: 12px; color: inherit; text-decoration: none; font-weight: 750; letter-spacing: -.02em; }
	.brand img { object-fit: contain; }
	.eyebrow { margin: 40px 0 10px; color: #a5b4fc; font-size: .8rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
	h1 { margin: 0; font-size: clamp(2rem, 7vw, 4rem); line-height: .98; letter-spacing: -.045em; }
	.body-copy { margin: 20px 0 0; max-width: 46ch; color: #cbd5e1; font-size: 1.05rem; line-height: 1.65; }
	.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
	.primary, .secondary { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 0 18px; border-radius: 12px; font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; }
	.primary { border: 1px solid #818cf8; background: #818cf8; color: #0b1020; }
	.secondary { border: 1px solid rgba(148,163,184,.3); background: rgba(255,255,255,.04); color: #e2e8f0; }
	.primary:focus-visible, .secondary:focus-visible, .brand:focus-visible { outline: 3px solid rgba(165,180,252,.72); outline-offset: 3px; }
	@media (max-width: 520px) { .actions > * { flex: 1 1 100%; } }
</style>