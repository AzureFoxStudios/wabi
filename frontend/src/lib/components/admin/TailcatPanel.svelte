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
	import {
		getTailcatStatus,
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

	async function refresh(): Promise<void> {
		loading = true;
		error = '';
		try {
			const token = getAuthToken();
			status = await getTailcatStatus(token);
			audit = (await getTailcatAudit(token, 20)).entries;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function doEnable(): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			status = await enableTailcat(getAuthToken());
			confirmOpen = false;
			notice = 'Private access is on. Members connect with their Wabi account.';
			audit = (await getTailcatAudit(getAuthToken(), 20)).entries;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function doDisable(): Promise<void> {
		busy = true;
		error = '';
		notice = '';
		try {
			status = await disableTailcat(getAuthToken());
			notice = 'Private access closed. All pipes are down.';
			audit = (await getTailcatAudit(getAuthToken(), 20)).entries;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function doRevoke(keyId: string): Promise<void> {
		busy = true;
		error = '';
		try {
			await revokeTailcatKey(getAuthToken(), keyId);
			status = await getTailcatStatus(getAuthToken());
			audit = (await getTailcatAudit(getAuthToken(), 20)).entries;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function shortKey(key: string): string {
		return key.length > 24 ? `${key.slice(0, 12)}…${key.slice(-8)}` : key;
	}

	onMount(() => {
		void refresh();
	});
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
					Running — members can connect.
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

		{#if status.enabled && status.address}
			<div class="address-box">
				<div class="muted">Connection code (share with members who have a registered key)</div>
				<code>{status.address}</code>
			</div>
		{/if}

		{#if status.keys.length > 0}
			<h4>Member keys ({status.keys.length})</h4>
			<table>
				<thead>
					<tr>
						<th>Member</th>
						<th>Key</th>
						<th>Label</th>
						<th>Added</th>
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
							{#if canManageAdmin}
								<td>
									<button disabled={busy} onclick={() => doRevoke(key.id)}>Revoke</button>
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
					<li>No ports are opened. Nothing is public. Your server stays invisible to the internet.</li>
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
