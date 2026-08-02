<script lang="ts">
	import { onMount } from 'svelte';
	import { getServerUrl } from '$lib/serverUrl';
	import {
		loadLoreConnectConfig,
		saveLoreConnectConfig,
		generateLoreAccessToken,
		buildLoreConnectSnippets,
		type LoreConnectSnippet
	} from '$lib/api/lore';

	/** W6b: External-tool Connect — per-channel server URL, repo id, access token + SDK setup snippets. */
	let { channelKey, repoId, repoName, onclose }: {
		channelKey: string;
		repoId: number | null;
		repoName: string | null;
		onclose: () => void;
	} = $props();

	let serverUrl = $state(getServerUrl());
	let repoIdText = $state('');
	let token = $state('');
	let activeLang = $state('js');
	let copied = $state('');
	let showToken = $state(false);

	onMount(() => {
		const cfg = loadLoreConnectConfig(channelKey);
		if (cfg) {
			if (cfg.serverUrl) serverUrl = cfg.serverUrl;
			if (cfg.repoId) repoIdText = cfg.repoId;
			if (cfg.token) token = cfg.token;
		} else {
			repoIdText = repoId != null ? String(repoId) : '';
			saveLoreConnectConfig(channelKey, { serverUrl, repoId: repoIdText, token });
		}
	});

	$effect(() => {
		saveLoreConnectConfig(channelKey, { serverUrl, repoId: repoIdText, token });
	});

	const snippets = $derived.by(() => buildLoreConnectSnippets(serverUrl, repoIdText, token));
	const activeSnippet = $derived(snippets.find((s) => s.lang === activeLang) || snippets[0]);

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

	function generateToken() {
		token = generateLoreAccessToken();
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
					<span class="lore-connect-label">Access token</span>
					<div class="lore-connect-input-row">
						<input
							class="lore-input lore-connect-input lore-connect-token"
							type={showToken ? 'text' : 'password'}
							value={token}
							placeholder="Generate an access token"
							oninput={(e) => (token = (e.currentTarget as HTMLInputElement).value)}
						/>
						<button class="lore-btn lore-btn-sm" onclick={generateToken}>Generate</button>
						<button class="lore-btn lore-btn-sm" onclick={() => copyText(token, 'token')} disabled={!token}>
							{copied === 'token' ? 'Copied' : 'Copy'}
						</button>
						<button class="lore-btn lore-btn-sm lore-connect-reveal" onclick={() => (showToken = !showToken)}>
							{showToken ? 'Hide' : 'Show'}
						</button>
					</div>
					<p class="lore-connect-hint">The token is stored in this browser for this channel. Paste it into your external tool along with the server URL and repo id.</p>
				</div>
			</section>

			<section class="lore-connect-section">
				<div class="lore-connect-snippets-head">
					<h4>Setup snippets</h4>
					<button class="lore-btn lore-btn-sm" onclick={() => activeSnippet && copyText(activeSnippet.code, activeSnippet.lang)}>
						{copied === activeSnippet?.lang ? 'Copied' : 'Copy code'}
					</button>
				</div>
				<div class="lore-connect-lang-tabs" role="tablist" aria-label="Setup snippet language">
					{#each snippets as s}
						<button
							class="lore-connect-lang-tab"
							class:active={s.lang === activeLang}
							role="tab"
							aria-selected={s.lang === activeLang}
							onclick={() => (activeLang = s.lang)}
						>
							{s.label.split(' (')[0]}
						</button>
					{/each}
				</div>
				{#if activeSnippet}
					<pre class="lore-connect-code"><code>{activeSnippet.code}</code></pre>
				{/if}
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
