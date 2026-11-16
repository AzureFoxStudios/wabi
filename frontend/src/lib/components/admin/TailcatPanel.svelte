<script lang="ts">
	import { _ } from '$lib/i18n';
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
		return change(enableTailcat, $_('tailcat.enabled_msg'));
	}

	function doDisable() {
		return change(disableTailcat, $_('tailcat.disabled_msg'));
	}

	function doRevoke(keyId: string) {
		return change(token => revokeTailcatKey(token, keyId), $_('tailcat.revoked_msg'));
	}

	function savePort() {
		return change(
			token => setTailcatPort(token, port),
			$_('tailcat.port_saved_msg'),
			$_('tailcat.port_saved_hint')
		);
	}

	function setAccess(id: string, allowed: boolean) {
		return change(
			token => setTailcatKeyAccess(token, id, allowed),
			allowed ? $_('tailcat.device_allowed') : $_('tailcat.device_blocked')
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
	<h3>{$_('tailcat.title')}</h3>
	<p class="muted">
		{$_('tailcat.intro')}
		
		
	</p>

	{#if loading && !status}
		<p class="muted">{$_('common.loading')}</p>
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
					{$_('tailcat.running')}
				{:else if status.enabled}
					{$_('tailcat.enabled_not_running')}{status.lastError ? $_('tailcat.last_error', { values: { error: status.lastError } }) : ''}.
				{:else}
					{$_('audio_settings.off')}.
				{/if}
			</span>
			{#if status.binaryVersion}
				<span class="muted">tailcat {status.binaryVersion}</span>
			{:else}
				<span class="muted">
					{$_('tailcat.binary_missing', { values: { path: status.binaryPath } })}
					
				</span>
			{/if}
		</div>

		{#if canManageAdmin}
			<div class="actions">
				{#if !status.enabled}
					<button class="primary" disabled={busy} onclick={() => (confirmOpen = true)}>
						{$_('tailcat.turn_on')}
					</button>
				{:else}
					<button class="danger" disabled={busy} onclick={doDisable}>
						{$_('tailcat.turn_off')}
					</button>
				{/if}
				<button disabled={busy || loading} onclick={refresh}>{$_('yt.refresh')}</button>
			</div>
		{/if}


        <section class="service-access" aria-label={$_('tailcat.service_label')}>
            <h4>{$_('tailcat.service_title')}</h4>
            <p class="muted">{$_('tailcat.pipe_label')} <code>{status.pipePort}</code> → {$_('tailcat.wabi_on')} <code>127.0.0.1:{status.serverPort}</code>. {$_('tailcat.service_desc')}</p>
            {#if canManageAdmin}
                <label for="tailcat-pipe-port">{$_('tailcat.port_label')}</label>
                <input id="tailcat-pipe-port" type="number" min="1024" max="65535" bind:value={port} disabled={busy} />
                <button disabled={busy || port === status.pipePort || port < 1024 || port > 65535 || port === status.serverPort} onclick={savePort}>{$_('tailcat.save_port')}</button>
                <p class="muted">{$_('tailcat.port_desc')}</p>
            {/if}
        </section>
		{#if status.enabled && status.address}
			<div class="address-box">
				<div class="muted">{$_('tailcat.code_label')}</div>
				<code>{status.address}</code>
			</div>
		{/if}

		{#if status.keys.length > 0}
			<h4>{$_('tailcat.member_keys', { values: { count: status.keys.length } })}</h4>
			<p class="muted">{$_('tailcat.keys_desc')}</p>
			<table>
				<thead>
					<tr>
						<th>{$_('upop.role_member')}</th>
						<th>{$_('tailcat.th_key')}</th>
						<th>{$_('map.label')}</th>
						<th>{$_('tailcat.th_added')}</th>
						<th>{$_('tailcat.th_access')}</th>
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
							<td>{key.allowed === false ? $_('tailcat.blocked') : $_('tailcat.allowed')}</td>
							{#if canManageAdmin}
								<td>
									<button disabled={busy} onclick={() => setAccess(key.id, key.allowed === false)}>{key.allowed === false ? $_('tailcat.allow') : $_('tailcat.block')}</button>
									<button disabled={busy} onclick={() => doRevoke(key.id)}>{$_('tailcat.forget_key')}</button>
								</td>
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		{:else if status.enabled}
			<p class="muted">
				{$_('tailcat.no_keys')}
				
			</p>
		{/if}

		{#if audit.length > 0}
			<h4>{$_('tailcat.recent_changes')}</h4>
			<ul class="audit">
				{#each audit as entry}
					<li>
						<span class="muted">{new Date(entry.ts).toLocaleString()}</span>
						<strong>{entry.action}</strong>
						{$_('tailcat.by_member', { values: { actor: entry.actor } })}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#if confirmOpen}
		<div class="modal-backdrop" role="presentation">
			<div class="modal" role="dialog" aria-modal="true" aria-label={$_('tailcat.enable_label')}>
				<h4>{$_('tailcat.enable_heading')}</h4>
				<ul>
					<li>{$_('tailcat.enable_1')}</li>
					<li>{$_('tailcat.enable_2')}</li>
					<li>{$_('tailcat.enable_3')}</li>
				</ul>
				<div class="actions">
					<button class="primary" disabled={busy} onclick={doEnable}>{$_('tailcat.yes_enable')}</button>
					<button disabled={busy} onclick={() => (confirmOpen = false)}>{$_('common.cancel')}</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
    .service-access { display: grid; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); }
    .service-access input { max-width: 12rem; padding: var(--space-2); background: var(--w-bg2); color: var(--w-text); border: 1px solid var(--w-line-strong); border-radius: calc(10px * var(--w-rs, 1)); }
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
