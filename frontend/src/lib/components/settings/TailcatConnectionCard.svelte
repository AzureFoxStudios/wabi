<script lang="ts">
	import { _ } from '$lib/i18n';
	/**
	 * Private access (Tailcat), this device's choice under Settings › Privacy & security. Errors are
	 * said in plain words where the action happened; the raw cause is only logged.
	 * Desktop-only flow: register this device's key with the server, then
	 * dial the server's tc… address. The Tauri shell runs the SOCKS tunnel
	 * plus a local forwarder; the app's server URL is switched to the
	 * forwarder (existing setConfiguredServerUrl mechanism) so server-bound
	 * API, socket.io and upload requests use the encrypted tunnel. Disconnect
	 * restores the previous server URL.
	 */
	import { onMount } from 'svelte';
	import { clearAuthSession, clearStoredIdentity, getAuthToken } from '$lib/authSession';
	import { isTauriRuntime } from '$lib/tauri-platform';
	import { getServerUrl, setConfiguredServerUrl } from '$lib/serverUrl';
	import { clearTailcatConnection, rememberTailcatConnection, restoreTailcatConnection } from '$lib/tailcatConnection';
	import {
		getTailcatConnectInfo,
		registerTailcatKey,
		type TailcatConnectInfo
	} from '$lib/api/tailcat';

	let info: TailcatConnectInfo | null = $state(null);
	let tunnel: { connected: boolean; socksPort: number | null; proxyPort: number | null } | null =
		$state(null);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let label = $state('');

	const desktop = $derived(isTauriRuntime());
	const TUNNEL_CLOSED = 'Tunnel closed. Choose your server address from the sign-in screen.';

	async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		// Lazy import keeps browser bundles free of the Tauri API.
		const { invoke } = await import('@tauri-apps/api/core');
		return invoke<T>(cmd, args);
	}

	async function refresh(): Promise<void> {
		error = '';
		try {
			if (desktop) {
				tunnel = await invoke<{ connected: boolean; socksPort: number | null; proxyPort: number | null }>(
					'tailcat_status'
				);
			}
			info = await getTailcatConnectInfo(getAuthToken());
		} catch (e) {
			console.warn('[Private access] status check failed:', e);
			error = $_('tail.err_status');
		}
	}

	async function registerDevice(): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			const publicKey = await invoke<string>('tailcat_register_key');
			await registerTailcatKey(getAuthToken(), publicKey, label || undefined);
			notice = $_('tail.notice_registered');
			label = '';
			await refresh();
		} catch (e) {
			console.warn('[Private access] registration failed:', e);
			error = $_('tail.err_register');
		} finally {
			busy = false;
		}
	}

	async function connect(): Promise<void> {
		if (!info?.address) return;
		busy = true;
		error = '';
		notice = '';
		let tunnelStarted = false;
		try {
			const previousUrl = getServerUrl();
			const result = await invoke<{ socksPort: number; proxyPort: number }>('tailcat_connect', {
				address: info.address,
				pipePort: info.pipePort
			});
			tunnelStarted = true;
			const proxyUrl = `http://127.0.0.1:${result.proxyPort}`;
			// Probe without credentials. A running SOCKS process alone does not
			// prove that the local forwarder reaches a ready Wabi server.
			const ready = await fetch(`${proxyUrl}/readyz`, { signal: AbortSignal.timeout(5000) });
			if (!ready.ok) throw new Error('Private tunnel could not reach a ready server');
			rememberTailcatConnection(previousUrl, proxyUrl);
			// A random proxy port can coincide with one used by another tunnel.
			// Never inherit credentials or an account label from that old URL.
			clearAuthSession(proxyUrl);
			clearStoredIdentity(proxyUrl);
			setConfiguredServerUrl(proxyUrl, false);
			// Authentication is URL-scoped. Reconnect through the new address;
			// do not copy a bearer token to an unverified loopback proxy.
			window.location.reload();
		} catch (e) {
			if (tunnelStarted) {
				await invoke('tailcat_disconnect').catch(() => {});
				if (!restoreTailcatConnection()) clearTailcatConnection();
			}
			console.warn('[Private access] connect failed:', e);
			error = $_('tail.err_connect');
		} finally {
			busy = false;
		}
	}

	async function disconnect(): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			await invoke('tailcat_disconnect');
			if (!restoreTailcatConnection()) {
				throw new Error(TUNNEL_CLOSED);
			}
			window.location.reload();
		} catch (e) {
			console.warn('[Private access] disconnect failed:', e);
			error = e instanceof Error && e.message === TUNNEL_CLOSED ? TUNNEL_CLOSED : $_('tail.err_disconnect');
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		void refresh();
	});
</script>

<section class="settings-block tailcat" aria-labelledby="tailcat-title">
	<h3 class="settings-block__title" id="tailcat-title">{$_('tail.title')}</h3>
	<p class="settings-block__hint">{$_('tail.hint_intro')}</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label">
					{#if desktop && tunnel?.connected}{$_('tail.state_connected')}{:else if info === null}{$_('privacy.state.checking_short')}{:else if !info.enabled}{$_('tail.state_not_offered')}{:else if !desktop}{$_('tail.state_needs_app')}{:else if !info.registered}{$_('tail.state_not_registered')}{:else}{$_('tail.state_registered')}{/if}
				</p>
				<p class="w-srow__hint">
					{#if desktop && tunnel?.connected}
						{$_('tail.hint_disconnect')}
					{:else if info === null}
						{$_('tail.hint_asking')}
					{:else if !info.enabled}
						{$_('tail.hint_connect_usual')}
					{:else if !desktop}
						{$_('tail.hint_browser')}
					{:else if !info.registered}
						{$_('tail.hint_register')}
					{:else}
						{$_('tail.hint_connecting')}
					{/if}
				</p>
			</div>
			<div class="w-srow__control">
				{#if desktop && tunnel?.connected}
					<button type="button" class="w-btn w-btn--sm" disabled={busy} aria-busy={busy} onclick={disconnect}>{$_('tail.disconnect')}</button>
				{:else if info?.enabled && desktop && info.registered}
					<button type="button" class="w-btn w-btn--sm w-btn--primary" disabled={busy} aria-busy={busy} onclick={connect}>{busy ? $_('tail.connecting') : $_('tail.connect')}</button>
				{/if}
			</div>
		</div>
		{#if info?.enabled && desktop && !info.registered && !tunnel?.connected}
			<div class="w-srow">
				<div class="w-srow__text">
					<label class="w-srow__label" for="tailcat-label">{$_('tail.device_label')}</label>
					<p class="w-srow__hint">{$_('tail.label_hint')}</p>
				</div>
				<div class="w-srow__control tailcat__register">
					<input id="tailcat-label" class="w-field" type="text" bind:value={label} maxlength={64} />
					<button type="button" class="w-btn w-btn--sm w-btn--primary" disabled={busy} aria-busy={busy} onclick={registerDevice}>{$_('tail.register')}</button>
				</div>
			</div>
		{/if}
	</div>
	{#if error}<p class="tailcat__note is-error" role="alert">{error}</p>{/if}
	{#if notice}<p class="tailcat__note" role="status">{notice}</p>{/if}
</section>

<style>
	.tailcat__register .w-field {
		width: 200px;
	}
	.tailcat__note {
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.tailcat__note.is-error {
		color: var(--w-danger);
	}
	@media (max-width: 600px) {
		.tailcat__register {
			flex-wrap: wrap;
		}
		.tailcat__register .w-field {
			width: 100%;
		}
	}
</style>
