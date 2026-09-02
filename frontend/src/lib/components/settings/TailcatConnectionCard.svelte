<script lang="ts">
	/**
	 * Member-facing private-access (Tailcat) connection card.
	 * Desktop-only flow: register this device's key with the server, then
	 * dial the server's tc… address. The Tauri shell runs the SOCKS tunnel
	 * plus a local forwarder; the app's server URL is switched to the
	 * forwarder (existing setConfiguredServerUrl mechanism) so ALL traffic —
	 * API, socket.io, uploads — rides the encrypted tunnel. Disconnect
	 * restores the previous server URL.
	 */
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { isTauriRuntime } from '$lib/tauri-platform';
	import { getServerUrl, setConfiguredServerUrl } from '$lib/serverUrl';
	import {
		getTailcatConnectInfo,
		registerTailcatKey,
		type TailcatConnectInfo
	} from '$lib/api/tailcat';

	const PREV_URL_KEY = 'wabi.tailcat.prevServerUrl';

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
			info = await getTailcatConnectInfo(getAuthToken());
			if (desktop) {
				tunnel = await invoke<{ connected: boolean; socksPort: number | null; proxyPort: number | null }>(
					'tailcat_status'
				);
			}
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
		try {
			const result = await invoke<{ socksPort: number; proxyPort: number }>('tailcat_connect', {
				address: info.address,
				pipePort: info.pipePort
			});
			// Remember the current server URL, then route everything through
			// the tunnel's local forwarder.
			try {
				localStorage.setItem(PREV_URL_KEY, getServerUrl());
			} catch {
				/* non-fatal: disconnect just won't restore */
			}
			setConfiguredServerUrl(`http://127.0.0.1:${result.proxyPort}`, false);
			notice =
				'Connected — your traffic now flows through the encrypted tunnel. ' +
				'If anything looks stale, reload the app (Ctrl/Cmd+R).';
			await refresh();
		} catch (e) {
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
			const prev = localStorage.getItem(PREV_URL_KEY);
			if (prev) {
				try {
					setConfiguredServerUrl(prev, false);
				} catch {
					/* restored URL no longer validates — leave as-is */
				}
				localStorage.removeItem(PREV_URL_KEY);
			}
			notice = 'Tunnel closed. Back on the normal server address.';
			await refresh();
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

	{#if info === null}
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
	{:else if tunnel?.connected}
		<p class="notice">
			Connected through the tunnel — all traffic (chat, voice relay, uploads) is encrypted
			end-to-end. Local forwarder port {tunnel.proxyPort}.
		</p>
		<button disabled={busy} onclick={disconnect}>Disconnect</button>
	{:else}
		<p class="muted">
			This device is registered. Connect through the server's private tunnel — no ports, no
			domain, encrypted the whole way. Your server address switches automatically and switches
			back when you disconnect.
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
