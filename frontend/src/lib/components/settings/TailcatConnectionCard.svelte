<script lang="ts">
	/**
	 * Member-facing private-access (Tailcat) connection card.
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
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function registerDevice(): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			const publicKey = await invoke<string>('tailcat_register_key');
			await registerTailcatKey(getAuthToken(), publicKey, label || undefined);
			notice = 'Device registered. You can connect once private access is on.';
			label = '';
			await refresh();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
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
			error = e instanceof Error ? e.message : String(e);
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
				throw new Error('Tunnel closed. Choose your server address from the login screen.');
			}
			window.location.reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		void refresh();
	});
</script>

<div class="tailcat-card">
	<h4>Private access</h4>
	{#if error}
		<p class="error">{error}</p>
	{/if}
	{#if notice}
		<p class="notice">{notice}</p>
	{/if}

	{#if desktop && tunnel?.connected}
		<p class="notice">
			Private tunnel connected. Local forwarder port {tunnel.proxyPort}.
		</p>
		<button disabled={busy} onclick={disconnect}>Disconnect</button>
	{:else if info === null}
		<p class="muted">Loading…</p>
	{:else if !info.enabled}
		<p class="muted">
			This server doesn't use private access tunnels. Connect the normal way (server address).
		</p>
	{:else if !desktop}
		<p class="muted">
			Private access tunnels need the desktop app. In the browser, keep using the normal server
			address.
		</p>
	{:else if !info.registered}
		<p class="muted">
			Register this device to connect through the server's private tunnel. Your key is tied to
			your account — an admin can revoke it at any time.
		</p>
		<div class="row">
			<input
				type="text"
				placeholder="Device label (e.g. “mom's laptop”)"
				bind:value={label}
				maxlength={64}
			/>
			<button class="primary" disabled={busy} onclick={registerDevice}>
				Register this device
			</button>
		</div>
	{:else}
		<p class="muted">
			This device is registered. Connect through the server's private tunnel without a domain.
			The app will switch to the tunnel address and ask you to sign in there. Disconnect to
			return to the previous address.
		</p>
		<button class="primary" disabled={busy} onclick={connect}>Connect</button>
	{/if}
</div>

<style>
	.tailcat-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--wabi-border, #2a2a35);
		border-radius: 10px;
	}
	h4 {
		margin: 0;
	}
	.muted {
		opacity: 0.7;
		font-size: 0.9em;
	}
	.error {
		color: #ff6b6b;
	}
	.notice {
		color: #6bcb77;
	}
	.row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	input {
		flex: 1;
		min-width: 200px;
	}
</style>
