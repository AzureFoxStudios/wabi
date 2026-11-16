<script lang="ts">
	import { _ } from '$lib/i18n';
	import { createEventDispatcher } from 'svelte';
	import { setConfiguredServerUrl } from '$lib/serverUrl';
	import { brandConfig, brandName } from '$lib/branding';
	import Icon from '$lib/components/ui/Icon.svelte';

	export let serverDomain = '';
	export let rememberServer = true;
	export let loading = false;
	/** Opened from "Change server": offer a way back to the sign-in form. */
	export let cancellable = false;

	const dispatch = createEventDispatcher<{ applied: { serverDomain: string }; cancel: void }>();
	let connectionError = '';

	function focusOnMount(node: HTMLInputElement) { node.focus(); return {}; }

	function apply() {
		connectionError = '';
		try {
			const normalized = setConfiguredServerUrl(serverDomain, rememberServer);
			serverDomain = normalized;
			dispatch('applied', { serverDomain: normalized });
		} catch (err) {
			console.warn('[login] server address rejected', err);
			connectionError = $_('login_connection.invalid');
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && cancellable && !loading) {
			event.preventDefault();
			dispatch('cancel');
		}
	}
</script>

<form class="connection-box" on:submit|preventDefault={apply}>
	<p class="w-kicker connection-kicker">{$_('login_connection.server_connection')}</p>
	<h3>{$_('login_connection.title', { values: { brand: brandName } })}</h3>
	<p class="connection-copy">{$_('login_connection.copy')}</p>
	<label class="w-label" for="login-connection-domain">{$_('login_connection.domain_or_url')}</label>
	<input
		id="login-connection-domain"
		class="w-field connection-input"
		type="text"
		bind:value={serverDomain}
		placeholder="{brandConfig.domain}"
		autocomplete="url"
		spellcheck="false"
		aria-invalid={connectionError ? 'true' : undefined}
		aria-describedby={connectionError ? 'login-connection-error' : undefined}
		use:focusOnMount
		on:keydown={handleKeydown}
		disabled={loading}
	/>
	{#if connectionError}
		<p class="w-field-error connection-error" id="login-connection-error" role="alert"><Icon name="alert" size={14} />{connectionError}</p>
	{/if}
	<label class="w-choice connection-remember">
		<input type="checkbox" class="w-check" bind:checked={rememberServer} />
		<span>{$_('login_connection.remember')}</span>
	</label>
	<div class="connection-actions">
		{#if cancellable}
			<button type="button" class="w-btn w-btn--quiet w-btn--lg" on:click={() => dispatch('cancel')} disabled={loading}>{$_('login_connection.back')}</button>
		{/if}
		<button type="submit" class="w-btn w-btn--primary w-btn--lg connection-submit" disabled={loading}>{$_('login_connection.continue')}</button>
	</div>
</form>

<style>
	.connection-box {
		margin: 0;
		text-align: left;
	}
	.connection-kicker {
		margin: 0 0 8px;
	}
	.connection-box h3 {
		margin: 0 0 6px;
		color: var(--w-text);
		font: var(--w-t-title);
	}
	.connection-copy {
		margin: 0 0 20px;
		color: var(--w-mute);
		font: var(--w-t-small);
		text-wrap: pretty;
	}
	.connection-error {
		margin-top: 6px;
	}
	.connection-remember {
		margin: 12px 0 16px;
		color: var(--w-mute);
	}
	/* A quiet way back, then the primary (§7.13 order). */
	.connection-actions {
		display: flex;
		gap: 8px;
	}
	.connection-submit {
		flex: 1;
	}
</style>
