<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { setConfiguredServerUrl } from '$lib/serverUrl';
	import { brandConfig, brandName } from '$lib/branding';

	export let serverDomain = '';
	export let rememberServer = true;
	export let loading = false;

	const dispatch = createEventDispatcher<{ applied: { serverDomain: string } }>();
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
			connectionError = 'Enter a domain like example.org or a full https:// address.';
		}
	}
</script>

<form class="connection-box" on:submit|preventDefault={apply}>
	<p class="w-kicker connection-kicker">Server connection</p>
	<h3>Connect to a {brandName} domain</h3>
	<p class="connection-copy">Point this client at your self-hosted server. You can change it later from the sign-in screen.</p>
	<label class="w-label" for="login-connection-domain">Domain or URL</label>
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
		disabled={loading}
	/>
	{#if connectionError}
		<p class="w-field-error connection-error" id="login-connection-error" role="alert">{connectionError}</p>
	{/if}
	<label class="w-choice connection-remember">
		<input type="checkbox" class="w-check" bind:checked={rememberServer} />
		<span>Remember this server on this device</span>
	</label>
	<button type="submit" class="w-btn w-btn--primary w-btn--lg connection-submit" disabled={loading}>Continue</button>
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
	.connection-input {
		height: 44px;
	}
	.connection-error {
		margin-top: 6px;
	}
	.connection-remember {
		margin: 12px 0 16px;
		color: var(--w-mute);
	}
	.connection-submit {
		width: 100%;
	}
</style>
