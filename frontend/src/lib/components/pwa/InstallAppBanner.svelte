<script lang="ts">
	import { canInstallPwa, dismissInstallBanner, isInstallBannerDismissed, promptInstall } from '$lib/pwa/installPrompt';
	import { isStandaloneDisplay } from '$lib/pwa/platform';
	import { isMobile } from '$lib/layoutStoreStates';

	let busy = false;
	let hidden = isInstallBannerDismissed() || isStandaloneDisplay();

	$: show = !hidden && $canInstallPwa && $isMobile;

	async function onInstall() {
		busy = true;
		try {
			const outcome = await promptInstall();
			if (outcome === 'accepted' || outcome === 'dismissed') hidden = true;
		} finally {
			busy = false;
		}
	}

	function onDismiss() {
		dismissInstallBanner();
		hidden = true;
	}
</script>

{#if show}
	<div class="pwa-install-banner" role="region" aria-label="Install app">
		<div class="pwa-install-banner__text">
			<strong>Install Wabi</strong>
			<span>Home screen icon + better phone notifications.</span>
		</div>
		<div class="pwa-install-banner__actions">
			<button type="button" class="pwa-install-banner__primary" disabled={busy} on:click={onInstall}>
				{busy ? '…' : 'Install'}
			</button>
			<button type="button" class="pwa-install-banner__ghost" on:click={onDismiss}>Not now</button>
		</div>
	</div>
{/if}

<style>
	.pwa-install-banner {
		position: fixed;
		left: 12px;
		right: 12px;
		bottom: calc(var(--mobile-nav-height, 56px) + 10px + env(safe-area-inset-bottom, 0px));
		z-index: calc(var(--z-toast, 2000) - 1);
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		padding: 0.85rem 0.95rem;
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, var(--border-subtle, #334155) 80%, transparent);
		background: color-mix(in srgb, var(--surface-raised, #302b63) 92%, black 8%);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
		backdrop-filter: blur(10px);
	}
	.pwa-install-banner__text {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		color: var(--text-heading, #e0e0ff);
		font-size: 0.86rem;
	}
	.pwa-install-banner__text span {
		color: var(--text-secondary, #b3b3ff);
		font-size: 0.78rem;
	}
	.pwa-install-banner__actions {
		display: flex;
		gap: 0.5rem;
	}
	.pwa-install-banner__primary,
	.pwa-install-banner__ghost {
		flex: 1;
		min-height: 40px;
		border-radius: 999px;
		border: 1px solid transparent;
		font: inherit;
		font-weight: 600;
		font-size: 0.82rem;
		cursor: pointer;
	}
	.pwa-install-banner__primary {
		background: var(--accent-primary, #6366f1);
		color: white;
	}
	.pwa-install-banner__ghost {
		background: transparent;
		border-color: var(--border-subtle, #475569);
		color: var(--text-secondary, #b3b3ff);
	}
</style>
