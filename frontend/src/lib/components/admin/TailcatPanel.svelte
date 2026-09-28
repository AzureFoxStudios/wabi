<script lang="ts">
	/**
	 * Tailcat private-access admin panel.
	 * Design contract (docs/plans/2026-09-01-tailcat-private-access.md):
	 * - ON is an informed decision: a plain-language confirm states exactly
	 *   what opening the door means, then applies live (no restart, ever).
	 * - OFF is an instant kill-switch with zero ceremony.
	 * - Every change is audited (who/what/when) and one-step reversible.
	 */
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { activeServerUrl } from '$lib/serverUrl';
	import {
		getTailcatStatus,
		setTailcatPort,
		setTailcatKeyAccess,
		enableTailcat,
		disableTailcat,
		revokeTailcatKey,
		getTailcatAudit,
		type TailcatStatus,
		type TailcatAuditEntry
	} from '$lib/api/tailcat';

	let { canManageAdmin = false } = $props();

	let status: TailcatStatus | null = $state(null);
	let audit: TailcatAuditEntry[] = $state([]);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let confirmOpen = $state(false);
	let port = $state(0);
	let loadedServer: string | undefined;
	let requestEpoch = 0;

	async function refresh(): Promise<boolean> {
		const server = $activeServerUrl;
		const epoch = ++requestEpoch;
		const current = () => epoch === requestEpoch && server === $activeServerUrl;
		loading = true;
		error = '';
		try {
			const token = getAuthToken(server);
			const snapshot = await getTailcatStatus(token);
			if (!current()) return false;
			status = snapshot;
			port = snapshot.pipePort;
			const entries = (await getTailcatAudit(token, 20)).entries;
			if (!current()) return false;
			audit = entries;
			return true;
		} catch (e) {
			if (current()) error = e instanceof Error ? e.message : String(e);
			return false;
		} finally {
			if (current()) loading = false;
		}
	}

	async function change(
		action: (token: string | null) => Promise<unknown>,
		message: string,
		errorHint = ''
	): Promise<void> {
		const server = $activeServerUrl;
		const current = () => server === $activeServerUrl;
		busy = true;
		error = '';
		notice = '';
		try {
			await action(getAuthToken(server));
			if (!current()) return;
			confirmOpen = false;
			if (await refresh()) notice = message;
		} catch (e) {
			if (current()) error = `${e instanceof Error ? e.message : String(e)}${errorHint}`;
		} finally {
			if (current()) busy = false;
		}
	}

	function doEnable() {
		return change(enableTailcat, 'Private access is enabled. An allowed device key and a running transport are required to connect.');
	}

	function doDisable() {
		return change(disableTailcat, 'Private access closed. All pipes are down.');
	}

	function doRevoke(keyId: string) {
		return change(token => revokeTailcatKey(token, keyId), 'Device key forgotten. Its owner can register it again.');
	}

	function savePort() {
		return change(
			token => setTailcatPort(token, port),
			'Private-access port saved. Existing tunnel connections need to reconnect; the Wabi server keeps running.',
			'. If this page uses private access, the port change may have disconnected it. Reconnect using the new port before checking status.'
		);
	}

	function setAccess(id: string, allowed: boolean) {
		return change(
			token => setTailcatKeyAccess(token, id, allowed),
			allowed ? 'Device allowed to reach Wabi.' : 'Device blocked from private access. Other allowed devices may need to reconnect.'
		);
	}

	function shortKey(key: string): string {
		return key.length > 24 ? `${key.slice(0, 12)}…${key.slice(-8)}` : key;
	}

    $effect(() => {
        if (loadedServer !== $activeServerUrl) {
            loadedServer = $activeServerUrl; requestEpoch++; status = null; audit = []; notice = ''; confirmOpen = false; busy = false;
            void refresh();
        }
    });
	onMount(() => () => { requestEpoch++; });
</script>

<div class="tailcat-panel">
	<h3>Private access (Tailcat)</h3>
	<p class="muted">
		Let family and friends reach this server through an encrypted tunnel — no port forwarding, no
		domain, nothing public. Members still sign in with their Wabi account; the tunnel is a door,
		not a key.
	</p>

	{#if loading && !status}
		<p class="muted">Loading…</p>
	{/if}
	{#if error}
		<p class="error">{error}</p>
	{/if}
	{#if notice}
		<p class="notice">{notice}</p>
	{/if}

	{#if status}
		<div class="status-row">
			<span class={`dot ${status.running ? 'on' : status.enabled ? 'warn' : 'off'}`}></span>
			<span>
				{#if status.running}
					Process running — remote reachability has not been verified.
				{:else if status.enabled}
					Enabled but not running{status.lastError ? ` — ${status.lastError}` : ''}.
				{:else}
					Off.
				{/if}
			</span>
			{#if status.binaryVersion}
				<span class="muted">tailcat {status.binaryVersion}</span>
			{:else}
				<span class="muted">
					tailcat binary not found at “{status.binaryPath}” (install it or set
					WABI_TAILCAT_BINARY)
				</span>
			{/if}
		</div>

		{#if canManageAdmin}
			<div class="actions">
				{#if !status.enabled}
					<button class="primary" disabled={busy} onclick={() => (confirmOpen = true)}>
						Turn on private access…
					</button>
				{:else}
					<button class="danger" disabled={busy} onclick={doDisable}>
						Turn off now (kill-switch)
					</button>
				{/if}
				<button disabled={busy || loading} onclick={refresh}>Refresh</button>
			</div>
		{/if}


        <section class="service-access" aria-label="Private service access">
            <h4>Wabi service access</h4>
            <p class="muted">Private pipe <code>{status.pipePort}</code> → Wabi on <code>127.0.0.1:{status.serverPort}</code>. This connection exposes this Wabi instance; it does not grant access to other computer services. Wabi sign-in and permissions still apply.</p>
            {#if canManageAdmin}
                <label for="tailcat-pipe-port">Private-access port</label>
                <input id="tailcat-pipe-port" type="number" min="1024" max="65535" bind:value={port} disabled={busy} />
                <button disabled={busy || port === status.pipePort || port < 1024 || port > 65535 || port === status.serverPort} onclick={savePort}>Save port and reconnect private access</button>
                <p class="muted">Choose an unused local port. Changing it closes current private-access connections; clients must obtain the updated port. Other services’ port rules are not managed here.</p>
            {/if}
        </section>
		{#if status.enabled && status.address}
			<div class="address-box">
				<div class="muted">Connection code (share with members who have a registered key)</div>
				<code>{status.address}</code>
			</div>
		{/if}

		{#if status.keys.length > 0}
			<h4>Member keys ({status.keys.length})</h4>
			<p class="muted">Block keeps the device denied even if it registers again. Forget removes the record; members can register a forgotten key again.</p>
			<table>
				<thead>
					<tr>
						<th>Member</th>
						<th>Key</th>
						<th>Label</th>
						<th>Added</th>
						<th>Wabi access</th>
						{#if canManageAdmin}<th></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each status.keys as key (key.id)}
						<tr>
							<td>{key.userId}</td>
							<td><code title={key.publicKey}>{shortKey(key.publicKey)}</code></td>
							<td>{key.label ?? '—'}</td>
							<td>{new Date(key.createdAt).toLocaleString()}</td>
							<td>{key.allowed === false ? 'Blocked' : 'Allowed'}</td>
							{#if canManageAdmin}
								<td>
									<button disabled={busy} onclick={() => setAccess(key.id, key.allowed === false)}>{key.allowed === false ? 'Allow' : 'Block'}</button>
									<button disabled={busy} onclick={() => doRevoke(key.id)}>Forget key</button>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		{:else if status.enabled}
			<p class="muted">
				No member keys yet. Members add their key from the desktop app's connection settings
				(“register this device”).
			</p>
		{/if}

		{#if audit.length > 0}
			<h4>Recent changes</h4>
			<ul class="audit">
				{#each audit as entry}
					<li>
						<span class="muted">{new Date(entry.ts).toLocaleString()}</span>
						<strong>{entry.action}</strong>
						by member {entry.actor}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#if confirmOpen}
		<div class="modal-backdrop" role="presentation">
			<div class="modal" role="dialog" aria-modal="true" aria-label="Turn on private access">
				<h4>Turn on private access?</h4>
				<ul>
					<li>Members with a Wabi account can reach this server through an encrypted tunnel.</li>
					<li>This enables private access to Wabi. Existing public access, if configured separately, stays unchanged.</li>
					<li>Turning it off later is instant — one click, no restart.</li>
				</ul>
				<div class="actions">
					<button class="primary" disabled={busy} onclick={doEnable}>Yes, turn it on</button>
					<button disabled={busy} onclick={() => (confirmOpen = false)}>Cancel</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
    .service-access { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border-default); border-radius: var(--radius-md); }
    .service-access input { max-width: 12rem; padding: var(--space-2); background: var(--surface-base); color: var(--text-heading); border: 1px solid var(--border-default); border-radius: var(--radius-md); }
	.tailcat-panel {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--wabi-border, #2a2a35);
		border-radius: 10px;
	}
	h3,
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
	.status-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		display: inline-block;
	}
	.dot.on {
		background: #6bcb77;
	}
	.dot.warn {
		background: #e8b93e;
	}
	.dot.off {
		background: #666;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.address-box {
		padding: 10px;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.04);
		display: flex;
		flex-direction: column;
		gap: 6px;
		word-break: break-all;
	}
	table {
		border-collapse: collapse;
		font-size: 0.9em;
	}
	th,
	td {
		text-align: left;
		padding: 6px 10px;
		border-bottom: 1px solid var(--wabi-border, #2a2a35);
	}
	.audit {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.85em;
	}
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}
	.modal {
		background: var(--wabi-panel-bg, #1c1c24);
		border: 1px solid var(--wabi-border, #2a2a35);
		border-radius: 12px;
		padding: 20px;
		max-width: 460px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.modal ul {
		margin: 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
</style>
