<script lang="ts">
	import { _ } from '$lib/i18n';
	import { portal } from '$lib/actions/portal';
	import { onMount } from 'svelte';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import {
		parseLoreChannelId,
		mintLoreConnectToken,
		listLoreConnectTokens,
		revokeLoreConnectToken,
		type LoreConnectTokenInfo
	} from '$lib/api/lore';

	/** W6b: External-tool Connect — server-minted tokens + wabi-sync quick start. */
	let { channelKey, repoName, onclose }: {
		channelKey: string;
		repoId: number | null;
		repoName: string | null;
		onclose: () => void;
	} = $props();

	let serverUrl = $state(getServerUrl());
	let channelId = $derived(parseLoreChannelId(channelKey));
	let repoIdText = $derived(channelId != null ? `ch_${channelId.toString(16)}` : '');
	let token = $state('');
	let mintedTokenId = $state('');
	let tokenScopes = $state<'read' | 'write'>('write');
	let tokenJustMinted = $state(false);
	let minting = $state(false);
	let mintError = $state<string | null>(null);
	let tokens = $state<LoreConnectTokenInfo[]>([]);
	let listLoading = $state(false);
	let listError = $state<string | null>(null);
	let revokeError = $state<string | null>(null);
	let revokeNotice = $state('');
	let revoking = $state('');
	let copied = $state('');
	let showToken = $state(false);
	let panel: HTMLDivElement;
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	type RequestOwner = { channel: number; active: boolean; listSequence: number };
	let requestOwner: RequestOwner | null = null;

	$effect(() => {
		const id = channelId;
		token = ''; mintedTokenId = ''; tokenJustMinted = false; showToken = false;
		tokens = []; listError = null; mintError = null; revokeError = null; revokeNotice = '';
		minting = false; revoking = ''; copied = ''; listLoading = false;
		const owner = id == null ? null : { channel: id, active: true, listSequence: 0 };
		requestOwner = owner;
		if (owner) void refreshTokens(owner);
		else listError = $_('lpanel.err_open_channel');
		return () => {
			if (owner) owner.active = false;
			requestOwner = null;
			clearTimeout(copyTimer);
		};
	});

	async function refreshTokens(owner = requestOwner) {
		if (!owner?.active) return;
		const sequence = ++owner.listSequence;
		const t = getAuthToken();
		listError = null;
		if (!t) { listError = $_('lpanel.err_sign_in_list'); return; }
		listLoading = true;
		try {
			const result = await listLoreConnectTokens(t, owner.channel);
			if (owner.active && sequence === owner.listSequence) tokens = result;
		} catch (error) {
			if (owner.active && sequence === owner.listSequence) {
				listError = error instanceof Error ? error.message : $_('lpanel.err_load');
			}
		} finally {
			if (owner.active && sequence === owner.listSequence) listLoading = false;
		}
	}

	async function mintToken() {
		const owner = requestOwner;
		if (minting || revoking) return;
		const t = getAuthToken();
		if (!t || !owner?.active) {
			mintError = $_('lpanel.err_sign_in_open');
			return;
		}
		minting = true;
		mintError = null;
		try {
			const result = await mintLoreConnectToken(t, owner.channel, tokenScopes);
			if (!owner.active) return;
			token = result.token;
			mintedTokenId = result.tokenHash ?? result.tokenHashPrefix;
			tokenJustMinted = true;
			showToken = true;
			void refreshTokens(owner);
		} catch (e) {
			if (owner.active) mintError = e instanceof Error ? e.message : $_('lpanel.err_mint');
		} finally {
			if (owner.active) minting = false;
		}
	}

	function tokenId(t: LoreConnectTokenInfo) { return t.tokenHash ?? t.tokenHashPrefix; }

	async function revokeToken(id: string) {
		const owner = requestOwner;
		if (revoking || minting) return;
		const t = getAuthToken();
		revokeError = null; revokeNotice = '';
		if (!t || !owner?.active) { revokeError = $_('lpanel.err_sign_in_revoke'); return; }
		revoking = id;
		// Invalidate older list requests so a late response cannot resurrect
		// the revoked row while the authoritative refresh is still pending.
		++owner.listSequence;
		listLoading = false;
		try {
			await revokeLoreConnectToken(t, owner.channel, id);
			if (!owner.active) return;
			tokens = tokens.filter(t => tokenId(t) !== id);
			if (mintedTokenId === id) { token = ''; mintedTokenId = ''; tokenJustMinted = false; showToken = false; }
			revokeNotice = $_('lpanel.revoke_done');
			void refreshTokens(owner);
		} catch (error) {
			if (owner.active) revokeError = error instanceof Error ? error.message : $_('lpanel.err_revoke');
		} finally {
			if (owner.active) revoking = '';
		}
	}

	/** wabi-sync commands tailored to this channel + server. */
	function shellArg(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
	let syncCommands = $derived.by(() => {
		const id = channelId != null ? `ch_${channelId.toString(16)}` : 'ch_…';
		return [
			{ label: $_('lpanel.step_1'), code: `wabi-sync login ${shellArg(serverUrl)}` },
			{ label: $_('lpanel.step_2'), code: `wabi-sync link ${id} ~/code/${shellArg(repoName || 'my-project')}` },
			{ label: $_('lpanel.step_3'), code: `wabi-sync watch` }
		];
	});

	async function copyText(text: string, label: string): Promise<void> {
		const owner = requestOwner;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Fallback for non-secure contexts.
			if (!owner?.active) return;
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			const success = document.execCommand('copy');
			ta.remove();
			if (!success) return;
		}
		if (!owner?.active) return;
		copied = label;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => { copied = ''; }, 1500);
	}

	function handleBackdropKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		} else if (event.key === 'Tab') {
			const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
			const first = controls[0], last = controls.at(-1);
			if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
				event.preventDefault(); last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault(); first?.focus();
			}
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onclose();
	}

	onMount(() => {
		const previousFocus = document.activeElement as HTMLElement | null;
		panel.focus();
		window.addEventListener('keydown', handleBackdropKeydown);
		return () => {
			window.removeEventListener('keydown', handleBackdropKeydown);
			clearTimeout(copyTimer);
			previousFocus?.focus();
		};
	});
</script>

<div
	use:portal class="lore-connect-backdrop"
	role="presentation"
	onclick={handleBackdropClick}
>
	<div
		bind:this={panel}
		class="lore-connect-panel"
		role="dialog"
		aria-modal="true"
		aria-label={$_('lpanel.dialog_label')}
		tabindex="-1"
	>
		<header class="lore-connect-header">
			<div class="lore-connect-title">
				<h3>{$_('lpanel.title')}</h3>
				<p class="lore-connect-subtitle">{$_('lpanel.subtitle')}</p>
			</div>
			<button class="lore-connect-close" aria-label={$_('lpanel.close_aria')} onclick={onclose}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</header>

		<div class="lore-connect-body">
			<section class="lore-connect-section">
				<div class="lore-connect-field">
					<label for="lore-connect-server" class="lore-connect-label">{$_('lpanel.server_url')}</label>
					<div class="lore-connect-input-row">
						<input
							id="lore-connect-server"
							class="lore-input lore-connect-input"
							type="url"
							placeholder="https://example.com"
							bind:value={serverUrl}
						/>
						<button class="lore-btn lore-btn-sm" onclick={() => copyText(serverUrl, 'server')}>
							{copied === 'server' ? $_('lpanel.copied') : $_('lore_viewer.copy')}
						</button>
					</div>
				</div>

				<div class="lore-connect-field">
					<label for="lore-connect-repo" class="lore-connect-label">{$_('server_policy.channel_id')}</label>
					<div class="lore-connect-input-row">
						<input
							id="lore-connect-repo"
							class="lore-input lore-connect-input"
							type="text"
							placeholder={repoName ? $_('lpanel.repo_prefix', { values: { name: repoName } }) : $_('lpanel.repo_id_ph')}
							value={repoIdText}
							readonly
						/>
						<button class="lore-btn lore-btn-sm" onclick={() => copyText(repoIdText, 'repo')}>
							{copied === 'repo' ? $_('lpanel.copied') : $_('lore_viewer.copy')}
						</button>
					</div>
				</div>

				<div class="lore-connect-field">
					<label for="lore-connect-token" class="lore-connect-label">{$_('lpanel.token_label')}</label>
					<div class="lore-connect-input-row">
						<input
							id="lore-connect-token"
							class="lore-input lore-connect-input lore-connect-token"
							type={showToken ? 'text' : 'password'}
							value={token}
							placeholder={$_('lpanel.token_ph')}
							readonly
						/>
						<select class="lore-input" bind:value={tokenScopes} aria-label={$_('lpanel.scope_aria')} disabled={minting}>
							<option value="write">{$_('lpanel.scope_rw')}</option>
							<option value="read">{$_('lpanel.scope_ro')}</option>
						</select>
						<button class="lore-btn lore-btn-sm" onclick={mintToken} disabled={minting || !!revoking || channelId == null}>
							{minting ? $_('lpanel.minting') : $_('lpanel.mint')}
						</button>
						<button class="lore-btn lore-btn-sm" onclick={() => copyText(token, 'token')} disabled={!token}>
							{copied === 'token' ? $_('lpanel.copied') : $_('lore_viewer.copy')}
						</button>
						<button class="lore-btn lore-btn-sm lore-connect-reveal" onclick={() => (showToken = !showToken)}>
							{showToken ? 'Hide' : 'Show'}
						</button>
					</div>
					<p class="lore-connect-hint">
						{$_('lpanel.hint_tokens')}
						{#if tokenJustMinted}<strong>{$_('lpanel.hint_copy_now')}</strong>{/if}
						{$_('lpanel.hint_scopes')}
					</p>
					{#if mintError}
						<p role="alert" class="lore-connect-hint lore-connect-error">{mintError}</p>
					{/if}
				</div>

					<div class="lore-connect-field">
						<span class="lore-connect-label">{$_('lpanel.tokens_heading', { values: { count: tokens.length } })}</span>
						{#if listLoading}<p role="status" class="lore-connect-hint">{$_('lpanel.loading')}</p>{/if}
						{#if listError}
							<p role="alert" class="lore-connect-hint lore-connect-error">{listError}</p>
							<button class="lore-btn lore-btn-sm" disabled={listLoading || !!revoking || minting || channelId == null} onclick={() => refreshTokens()}>{$_('lpanel.retry')}</button>
						{:else if !listLoading && tokens.length === 0}
							<p class="lore-connect-hint">{$_('lpanel.none')}</p>
						{/if}
						{#if revokeError}<p role="alert" class="lore-connect-hint lore-connect-error">{revokeError}</p>{/if}
						{#if revokeNotice}<p role="status" class="lore-connect-hint">{revokeNotice}</p>{/if}
						<div class="lore-connect-token-list">
							{#each tokens as t (tokenId(t))}
								<div class="lore-connect-token-row">
									<code>{t.tokenHashPrefix}…</code>
									<span class="lore-connect-token-scope">{t.scopes}</span>
									<span class="lore-connect-token-scope">{$_('lpanel.user_id', { values: { id: t.userId } })}</span>
									<button class="lore-btn lore-btn-sm lore-btn-danger" disabled={!!revoking || minting} aria-label={$_('lpanel.revoke_aria', { values: { id: t.tokenHashPrefix } })} onclick={() => revokeToken(tokenId(t))}>
										{revoking === tokenId(t) ? $_('lpanel.revoking') : $_('storage_center.revoke')}
									</button>
								</div>
							{/each}
						</div>
					</div>
			</section>

			<section class="lore-connect-section">
				<div class="lore-connect-snippets-head">
					<h4>{$_('lpanel.sync_title')}</h4>
				</div>
				<p class="lore-connect-hint">
					<code>wabi-sync</code> {$_('lpanel.sync_desc_1')}
					{$_('lpanel.sync_desc_2')}
				</p>
				{#each syncCommands as cmd (cmd.label)}
					<div class="lore-connect-cmd">
						<span class="lore-connect-cmd-label">{cmd.label}</span>
						<div class="lore-connect-input-row">
							<pre class="lore-connect-code lore-connect-cmd-code"><code>{cmd.code}</code></pre>
							<button class="lore-btn lore-btn-sm" onclick={() => copyText(cmd.code, cmd.label)}>
								{copied === cmd.label ? $_('lpanel.copied') : $_('lore_viewer.copy')}
							</button>
						</div>
					</div>
				{/each}
			</section>
		</div>
	</div>
</div>

<style>
	.lore-connect-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal, 1500);
		background: color-mix(in srgb, #000 60%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}

	.lore-connect-panel {
		width: min(720px, 100%);
		color: var(--text-heading, #e0e0ff);
		max-height: 85vh;
		display: flex;
		flex-direction: column;
		background: var(--background-primary-color, #1a1a2e);
		border: 1px solid var(--border-color, #2a2a3e);
		border-radius: 12px;
		overflow: hidden;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
	}

	.lore-connect-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 18px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
		flex-shrink: 0;
	}

	.lore-connect-title h3 {
		margin: 0;
		font-size: 16px;
	}

	.lore-connect-subtitle {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--text-muted-color, #888);
	}

	.lore-connect-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted-color, #888);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.lore-connect-close:hover {
		background: color-mix(in srgb, var(--text-heading) 8%, transparent);
		color: var(--text-primary-color, #eee);
	}

	.lore-connect-body {
		flex: 1;
		overflow-y: auto;
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.lore-connect-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.lore-connect-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.lore-connect-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted-color, #888);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.lore-connect-input-row {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.lore-connect-input {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
	}

	.lore-connect-token {
		letter-spacing: 0.5px;
	}

	.lore-connect-reveal {
		background: color-mix(in srgb, var(--text-heading) 12%, transparent);
		color: var(--text-primary-color, #eee);
	}

	.lore-connect-hint {
		margin: 0;
		font-size: 12px;
		color: var(--text-muted-color, #888);
		line-height: 1.4;
	}

	.lore-connect-error {
		color: var(--color-danger, #ef4444);
	}

	.lore-connect-token-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.lore-connect-token-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		border: 1px solid var(--border-color, #2a2a3e);
		border-radius: 6px;
		font-size: 12px;
	}

	.lore-connect-token-row code {
		font-family: var(--font-mono, monospace);
		color: var(--text-primary-color, #eee);
	}

	.lore-connect-token-scope {
		color: var(--text-muted-color, #888);
	}

	.lore-btn-danger {
		background: color-mix(in srgb, var(--color-danger, #ef4444) 80%, transparent);
	}

	.lore-connect-cmd {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.lore-connect-cmd-label {
		font-size: 12px;
		color: var(--text-muted-color, #888);
	}

	.lore-connect-cmd-code {
		flex: 1;
		padding: 10px 12px;
	}

	.lore-connect-snippets-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.lore-connect-snippets-head h4 {
		margin: 0;
		font-size: 13px;
	}

	.lore-connect-code {
		margin: 0;
		padding: 14px;
		border-radius: 8px;
		background: var(--background-secondary-color, #16162a);
		border: 1px solid var(--border-color, #2a2a3e);
		font-family: var(--font-mono, monospace);
		font-size: 12px;
		line-height: 1.5;
		white-space: pre;
		overflow-x: auto;
		color: var(--text-primary-color, #eee);
	}

	.lore-btn {
		padding: 6px 12px;
		border: none;
		border-radius: 4px;
		background: var(--accent-primary-color);
		color: var(--text-on-danger);
		font-size: 13px;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.lore-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.lore-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.lore-btn-sm {
		font-size: 12px;
		padding: 4px 8px;
		white-space: nowrap;
	}

	.lore-input {
		padding: 6px 10px;
		border-radius: 4px;
		border: 1px solid var(--border-color, #2a2a3e);
		background: var(--background-secondary-color, #16162a);
		color: var(--text-primary-color, #eee);
		font-size: 13px;
		outline: none;
	}

	.lore-input:focus {
		border-color: var(--accent-primary-color);
	}

	@media (max-width: 600px) {
		.lore-connect-input-row, .lore-connect-token-row { flex-wrap: wrap; }
		.lore-connect-input, .lore-connect-cmd-code { flex-basis: 100%; }
		.lore-connect-cmd-code { min-width: 0; }
	}
</style>
