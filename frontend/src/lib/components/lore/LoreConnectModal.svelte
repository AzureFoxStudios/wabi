<script lang="ts">
	import { getAuthToken } from '$lib/authSession';
	import { parseLoreChannelId } from '$lib/api/lore';
	import { createLoreRepo, checkLoreHealth } from '$lib/api/lore';
	import { loadLoreRepo, loadLoreHealth, loreHealth } from '$lib/loreStore';
	import { get } from 'svelte/store';

	interface Props {
		channelId: string;
		onConnected: () => void;
		onClose: () => void;
	}

	let { channelId, onConnected, onClose }: Props = $props();

	let repoName = $state('');
	let loreServerUrl = $state('lore://127.0.0.1:41337');
	let mode = $state<'create' | 'link'>('create');
	let creating = $state(false);
	let error = $state<string | null>(null);
	let health = $state<string | null>(null);
	let step = $state<'connect' | 'confirm'>('connect');

	async function checkHealth() {
		try {
			const token = getAuthToken();
			if (!token) return;
			const result = await checkLoreHealth(token);
			health = result.status;
			loreHealth.set(result.status);
		} catch {
			health = 'error';
			loreHealth.set('error');
		}
	}

	async function handleConnect() {
		if (!repoName.trim()) {
			error = 'Please enter a repository name';
			return;
		}

		creating = true;
		error = null;

		const token = getAuthToken();
		const numericChannelId = parseLoreChannelId(channelId);

		if (!token || !numericChannelId) {
			error = 'Unable to identify channel';
			creating = false;
			return;
		}

		try {
			const url = `/api/addons/lore/repos/${numericChannelId}${mode === 'link' ? '/link' : ''}`;
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ repoName: repoName.trim() })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || `Failed to ${mode === 'link' ? 'link' : 'create'} repository`);
			}
			await loadLoreRepo();
			await loadLoreHealth();
			onConnected();
		} catch (e: any) {
			error = e.message || `Failed to ${mode === 'link' ? 'link' : 'create'} repository`;
		} finally {
			creating = false;
		}
	}

	$effect(() => {
		checkHealth();
	});
</script>

<div class="lore-connect-modal" role="dialog" aria-modal="true" aria-label="Connect Lore repository">
	<div class="connect-card" onclick={(e) => e.stopPropagation()}>
		<div class="connect-header">
			<div class="header-icon">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
				</svg>
			</div>
			<div class="header-text">
				<h2>Connect Lore Repository</h2>
				<p>Version control for this channel</p>
			</div>
			<button class="close-btn" onclick={onClose} aria-label="Close">×</button>
		</div>

		<!-- Health check -->
		<div class="health-section">
			<div class="health-row">
				<span class="health-label">Lore Server</span>
				<span class="health-status" class:healthy={health === 'ok'} class:error={health === 'error'}>
					<span class="health-dot"></span>
					{health === 'ok' ? 'Connected' : health === 'error' ? 'Unavailable' : 'Checking...'}
				</span>
			</div>
			{#if health === 'error'}
				<div class="health-warning">
					⚠️ Lore server is not running. Make sure <code>loreserver</code> is started on this machine.
				</div>
			{/if}
		</div>

		<!-- Connection form -->
		{#if step === 'connect'}
			<form class="connect-form" onsubmit={(e) => { e.preventDefault(); handleConnect(); }}>
				<div class="form-group">
					<span class="form-label-row">
						<label for="repo-name">Repository Name</label>
						<span class="mode-toggle" role="tablist" aria-label="Repository mode">
							<button
								type="button"
								class="mode-btn {mode === 'create' ? 'active' : ''}"
								class:active={mode === 'create'}
								onclick={() => mode = 'create'}
								role="tab"
								aria-selected={mode === 'create'}
							>New</button>
							<button
								type="button"
								class="mode-btn {mode === 'link' ? 'active' : ''}"
								class:active={mode === 'link'}
								onclick={() => mode = 'link'}
								role="tab"
								aria-selected={mode === 'link'}
							>Link existing</button>
						</span>
					</span>
					<input
						id="repo-name"
						type="text"
						bind:value={repoName}
						placeholder={mode === 'create' ? 'my-project' : 'my-existing-repo'}
						class="input-field"
						autofocus
					/>
					<span class="input-hint">
						{#if mode === 'create'}
							Creates a brand-new empty repository for this channel
						{:else}
							Clones an existing repository from the Lore server — history included
						{/if}
					</span>
				</div>

				<div class="form-group">
					<label for="server-url">Lore Server URL</label>
					<input
						id="server-url"
						type="text"
						bind:value={loreServerUrl}
						class="input-field"
					/>
					<span class="input-hint">Default: lore://127.0.0.1:41337</span>
				</div>

				{#if error}
					<div class="error-message">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10"/>
							<line x1="12" y1="8" x2="12" y2="12"/>
							<line x1="12" y1="16" x2="12.01" y2="16"/>
						</svg>
						{error}
					</div>
				{/if}

				<div class="form-actions">
					<button type="button" class="btn btn-secondary" onclick={onClose}>Cancel</button>
					<button type="submit" class="btn btn-primary" disabled={creating}>
						{#if creating}
							<span class="spinner"></span>
							{mode === 'link' ? 'Linking...' : 'Creating...'}
						{:else}
							{mode === 'link' ? 'Link Repository' : 'Create Repository'}
						{/if}
					</button>
				</div>
			</form>
		{:else if step === 'confirm'}
			<div class="confirm-section">
				<div class="success-icon">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
						<polyline points="22 4 12 14.01 9 11.01"/>
					</svg>
				</div>
				<h3>Repository Connected!</h3>
				<p>Your Lore repository <strong>{repoName}</strong> is now active for this channel.</p>
				<button class="btn btn-primary" onclick={onConnected}>Start Working</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.lore-connect-modal {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal, 1000);
		backdrop-filter: blur(4px);
	}

	.connect-card {
		background: var(--surface-base);
		border-radius: var(--radius-lg);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		width: 480px;
		max-width: 90vw;
		max-height: 90vh;
		overflow: auto;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
	}

	.connect-header {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.header-icon {
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
		border-radius: var(--radius-md);
		color: var(--accent-primary);
	}

	.header-icon svg {
		width: 24px;
		height: 24px;
	}

	.header-text h2 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.header-text p {
		margin: 0;
		font-size: var(--font-size-sm);
		color: var(--text-muted);
	}

	.close-btn {
		margin-left: auto;
		width: 32px;
		height: 32px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		font-size: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.close-btn:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.health-section {
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent);
	}

	.health-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.health-label {
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
	}

	.health-status {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--font-size-sm);
		color: var(--text-muted);
	}

	.health-status.healthy {
		color: var(--color-success, #22c55e);
	}

	.health-status.error {
		color: var(--color-danger, #ef4444);
	}

	.health-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: currentColor;
	}

	.health-warning {
		margin-top: var(--space-1);
		padding: var(--space-1) var(--space-2);
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 30%, transparent);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		color: var(--color-warning, #f59e0b);
	}

	.health-warning code {
		background: color-mix(in srgb, var(--text-muted) 15%, transparent);
		padding: 1px 4px;
		border-radius: 2px;
		font-family: var(--font-mono);
	}

	.connect-form {
		padding: var(--space-3);
	}

	.form-group {
		margin-bottom: var(--space-3);
	}

	.form-group label {
		display: block;
		margin-bottom: var(--space-1);
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
		font-weight: 500;
	}

	.form-label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--space-1);
	}

	.form-label-row label {
		margin-bottom: 0;
	}

	.mode-toggle {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
	}

	.mode-btn {
		padding: 2px var(--space-2);
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.mode-btn.active {
		background: var(--accent-primary);
		color: white;
		font-weight: 600;
	}

	.mode-btn:not(.active):hover {
		color: var(--text-heading);
	}

	.input-field {
		width: 100%;
		padding: var(--space-2);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
		font-family: var(--font-mono);
		transition: border-color var(--duration-fast) var(--ease-out);
	}

	.input-field:focus {
		outline: none;
		border-color: var(--accent-primary);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 25%, transparent);
	}

	.input-field::placeholder {
		color: var(--text-muted);
		opacity: 0.5;
	}

	.input-hint {
		display: block;
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.error-message {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-2);
		background: color-mix(in srgb, var(--color-danger, #ef4444) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-danger, #ef4444) 30%, transparent);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-sm);
		color: var(--color-danger, #ef4444);
		margin-bottom: var(--space-2);
	}

	.error-message svg {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.form-actions {
		display: flex;
		gap: var(--space-2);
		justify-content: flex-end;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-sm);
		cursor: pointer;
		border: 1px solid transparent;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--accent-primary);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--accent-secondary, #818cf8);
	}

	.btn-secondary {
		background: var(--surface-sunken);
		color: var(--text-secondary);
		border-color: color-mix(in srgb, var(--text-muted) 20%, transparent);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.confirm-section {
		padding: var(--space-4);
		text-align: center;
	}

	.success-icon {
		width: 64px;
		height: 64px;
		margin: 0 auto var(--space-3);
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--color-success, #22c55e) 20%, transparent);
		border-radius: 50%;
		color: var(--color-success, #22c55e);
	}

	.success-icon svg {
		width: 32px;
		height: 32px;
	}

	.confirm-section h3 {
		margin: 0 0 var(--space-1);
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.confirm-section p {
		margin: 0 0 var(--space-3);
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
	}

	.confirm-section .btn {
		min-width: 160px;
		justify-content: center;
	}
</style>