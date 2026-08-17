<script lang="ts">
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
	let { channelKey, repoId, repoName, onclose }: {
		channelKey: string;
		repoId: number | null;
		repoName: string | null;
		onclose: () => void;
	} = $props();

	let serverUrl = $state(getServerUrl());
	let repoIdText = $state('');
	let channelId = $state<number | null>(null);
	let token = $state('');
	let tokenScopes = $state<'read' | 'write'>('write');
	let tokenJustMinted = $state(false);
	let minting = $state(false);
	let mintError = $state<string | null>(null);
	let tokens = $state<LoreConnectTokenInfo[]>([]);
	let copied = $state('');
	let showToken = $state(false);

	onMount(() => {
		channelId = parseLoreChannelId(channelKey) ?? repoId;
		repoIdText = channelId != null ? String(channelId) : '';
		void refreshTokens();
	});

	async function refreshTokens() {
		const t = getAuthToken();
		if (!t || channelId == null) return;
		try {
			tokens = await listLoreConnectTokens(t, channelId);
		} catch {
			tokens = [];
		}
	}

	async function mintToken() {
		const t = getAuthToken();
		if (!t || channelId == null) {
			mintError = 'Sign in and open a connected channel first.';
			return;
		}
		minting = true;
		mintError = null;
		try {
			const result = await mintLoreConnectToken(t, channelId, tokenScopes);
			token = result.token;
			tokenJustMinted = true;
			showToken = true;
			void refreshTokens();
		} catch (e) {
			mintError = e instanceof Error ? e.message : 'Failed to mint token';
		} finally {
			minting = false;
		}
	}

	async function revokeToken(hashPrefix: string) {
		const t = getAuthToken();
		if (!t || channelId == null) return;
		try {
			await revokeLoreConnectToken(t, channelId, hashPrefix);
			void refreshTokens();
		} catch {
			// The list refresh will reflect reality.
		}
	}

	/** wabi-sync commands tailored to this channel + server. */
	let syncCommands = $derived.by(() => {
		const id = channelId != null ? `ch_${channelId.toString(16)}` : 'ch_…';
		return [
			{ label: '1. Save your token', code: `wabi-sync login ${serverUrl}` },
			{ label: '2. Link a folder', code: `wabi-sync link ${id} ~/code/${repoName || 'my-project'}` },
			{ label: '3. Keep it running', code: `wabi-sync watch` }
		];
	});

	async function copyText(text: string, label: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			copied = label;
			setTimeout(() => {
				if (copied === label) copied = '';
			}, 1500);
		} catch {
			// Fallback for non-secure contexts.
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
			copied = label;
			setTimeout(() => {
				if (copied === label) copied = '';
			}, 1500);
		}
	}

	function handleBackdropKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		}
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onclose();
	}

	onMount(() => {
		window.addEventListener('keydown', handleBackdropKeydown);
		return () => window.removeEventListener('keydown', handleBackdropKeydown);
	});
</script>

<div
	class="lore-connect-backdrop"
	role="presentation"
	onclick={handleBackdropClick}
>
	<div
		class="lore-connect-panel"
		role="dialog"
		aria-modal="true"
		aria-label="Connect external tools"
		tabindex="-1"
	>
		<header class="lore-connect-header">
			<div class="lore-connect-title">
				<h3>Connect</h3>
				<p class="lore-connect-subtitle">External tools — Lore repo connection</p>
			</div>
			<button class="lore-connect-close" aria-label="Close connect panel" onclick={onclose}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
					<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
				</svg>
			</button>
		</header>

		<div class="lore-connect-body">
			<section class="lore-connect-section">
				<div class="lore-connect-field">
					<label for="lore-connect-server" class="lore-connect-label">Server URL</label>
					<div class="lore-connect-input-row">
						<input
							id="lore-connect-server"
							class="lore-input lore-connect-input"
							type="url"
							placeholder="https://example.com"
							bind:value={serverUrl}
						/>
						<button class="lore-btn lore-btn-sm" onclick={() => copyText(serverUrl, 'server')}>
							{copied === 'server' ? 'Copied' : 'Copy'}
						</button>
					</div>
				</div>

				<div class="lore-connect-field">
					<label for="lore-connect-repo" class="lore-connect-label">Repo ID</label>
					<div class="lore-connect-input-row">
						<input
							id="lore-connect-repo"
							class="lore-input lore-connect-input"
							type="text"
							placeholder={repoName ? `Repo: ${repoName}` : 'repo id'}
							bind:value={repoIdText}
						/>
						<button class="lore-btn lore-btn-sm" onclick={() => copyText(repoIdText, 'repo')}>
							{copied === 'repo' ? 'Copied' : 'Copy'}
						</button>
					</div>
				</div>

				<div class="lore-connect-field">
					<span class="lore-connect-label">Connect token (server-minted)</span>
					<div class="lore-connect-input-row">
						<input
							class="lore-input lore-connect-input lore-connect-token"
							type={showToken ? 'text' : 'password'}
							value={token}
							placeholder="Mint a token to connect external tools"
							readonly
						/>
						<select class="lore-input" bind:value={tokenScopes} title="Token scope">
							<option value="write">read+write</option>
							<option value="read">read-only</option>
						</select>
						<button class="lore-btn lore-btn-sm" onclick={mintToken} disabled={minting}>
							{minting ? '…' : 'Mint'}
						</button>
						<button class="lore-btn lore-btn-sm" onclick={() => copyText(token, 'token')} disabled={!token}>
							{copied === 'token' ? 'Copied' : 'Copy'}
						</button>
						<button class="lore-btn lore-btn-sm lore-connect-reveal" onclick={() => (showToken = !showToken)}>
							{showToken ? 'Hide' : 'Show'}
						</button>
					</div>
					<p class="lore-connect-hint">
						Tokens are minted by the server and stored hashed — the plaintext is shown once, right here.
						{#if tokenJustMinted}<strong>Copy it now; it will not be shown again.</strong>{/if}
						Scopes apply to the Lore API only and inherit your channel access.
					</p>
					{#if mintError}
						<p class="lore-connect-hint lore-connect-error">{mintError}</p>
					{/if}
				</div>

				{#if tokens.length > 0}
					<div class="lore-connect-field">
						<span class="lore-connect-label">Active tokens ({tokens.length})</span>
						<div class="lore-connect-token-list">
							{#each tokens as t (t.tokenHashPrefix)}
								<div class="lore-connect-token-row">
									<code>{t.tokenHashPrefix}…</code>
									<span class="lore-connect-token-scope">{t.scopes}</span>
									<span class="lore-connect-token-scope">user {t.userId}</span>
									<button class="lore-btn lore-btn-sm lore-btn-danger" onclick={() => revokeToken(t.tokenHashPrefix)}>
										Revoke
									</button>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</section>

			<section class="lore-connect-section">
				<div class="lore-connect-snippets-head">
					<h4>Sync your editor (VS Code, Sublime, vim, …)</h4>
				</div>
				<p class="lore-connect-hint">
					<code>wabi-sync</code> is a folder-level two-way sync daemon — any editor works, because it
					syncs a plain folder. Run the three commands below (paste your minted token when asked).
				</p>
				{#each syncCommands as cmd (cmd.label)}
					<div class="lore-connect-cmd">
						<span class="lore-connect-cmd-label">{cmd.label}</span>
						<div class="lore-connect-input-row">
							<pre class="lore-connect-code lore-connect-cmd-code"><code>{cmd.code}</code></pre>
							<button class="lore-btn lore-btn-sm" onclick={() => copyText(cmd.code, cmd.label)}>
								{copied === cmd.label ? 'Copied' : 'Copy'}
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

	.lore-connect-lang-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.lore-connect-lang-tab {
		padding: 4px 10px;
		border: 1px solid var(--border-color, #2a2a3e);
		border-radius: 6px;
		background: var(--background-secondary-color, #16162a);
		color: var(--text-muted-color, #888);
		font-size: 12px;
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s, background 0.15s;
	}

	.lore-connect-lang-tab:hover {
		color: var(--text-primary-color, #eee);
		border-color: var(--accent-primary-color);
	}

	.lore-connect-lang-tab.active {
		background: var(--accent-primary-color);
		color: var(--text-on-danger);
		border-color: var(--accent-primary-color);
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
</style>
