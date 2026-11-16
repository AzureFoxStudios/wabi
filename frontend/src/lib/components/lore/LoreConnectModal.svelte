<script lang="ts">
	import { _ } from '$lib/i18n';
	import { getAuthToken } from '$lib/authSession';
	import { parseLoreChannelId } from '$lib/api/lore';
	import {
		createLoreRepo,
		checkLoreHealth,
		linkLoreExternalRepo,
		importLoreRepo
	} from '$lib/api/lore';
	import { loadLoreRepo, loadLoreHealth, loreHealth } from '$lib/loreStore';

	interface Props {
		channelId: string;
		onConnected: () => void;
		onClose: () => void;
	}

	let { channelId, onConnected, onClose }: Props = $props();

	type Mode = 'create' | 'link' | 'external';
	type ExternalTarget = 'track' | 'import';

	let mode = $state<Mode>('create');
	let externalTarget = $state<ExternalTarget>('track');
	let repoName = $state('');
	let upstreamUrl = $state('');
	let autoBranchOnUpload = $state(false);
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

	function describeError(status: number | undefined, fallback: string): string {
		if (status === 409) return $_('lconn.err_name_taken');
		if (status === 502) return $_('lconn.err_source_unreachable');
		return fallback;
	}

	function defaultNameFromUrl(url: string): string {
		try {
			const parsed = new URL(url.trim());
			const last = parsed.pathname.split('/').filter(Boolean).pop();
			return last || parsed.hostname.replace(/^www\./, '');
		} catch {
			return '';
		}
	}

	function submitLabel(): string {
		if (creating) {
			if (mode === 'create') return $_('lconn.creating');
			if (mode === 'link') return $_('lconn.linking');
			return externalTarget === 'track' ? $_('lconn.tracking') : $_('lconn.importing');
		}
		if (mode === 'create') return $_('lconn.submit_create');
		if (mode === 'link') return $_('lconn.submit_link');
		return externalTarget === 'track' ? $_('lconn.submit_track') : $_('lconn.submit_import');
	}

	async function handleConnect() {
		const token = getAuthToken();
		const numericChannelId = parseLoreChannelId(channelId);
		if (!token || !numericChannelId) {
			error = $_('lconn.err_no_channel');
			return;
		}

		error = null;

		if (mode === 'create') {
			if (!repoName.trim()) {
				error = $_('lconn.err_name_required');
				return;
			}
			creating = true;
			try {
				await createLoreRepo(token, numericChannelId, repoName.trim(), {
					auto_branch_on_upload: autoBranchOnUpload
				});
			} catch (e: any) {
				error = e?.message || $_('lconn.err_create_failed');
				creating = false;
				return;
			}
		} else if (mode === 'link') {
			if (!repoName.trim()) {
				error = $_('lconn.err_link_name_required');
				return;
			}
			creating = true;
			try {
				const url = `/api/addons/lore/repos/${numericChannelId}/link`;
				const res = await fetch(url, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({ channelId: numericChannelId, repoName: repoName.trim() })
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || $_('lconn.err_link_failed'));
				}
			} catch (e: any) {
				error = e?.message || $_('lconn.err_link_failed');
				creating = false;
				return;
			}
		} else {
			if (!upstreamUrl.trim()) {
				error = $_('lconn.err_url_required');
				return;
			}
			const name = repoName.trim() || defaultNameFromUrl(upstreamUrl);
			if (!name) {
				error = $_('lconn.err_name_for_space');
				return;
			}
			creating = true;
			try {
				if (externalTarget === 'track') {
					await linkLoreExternalRepo(token, numericChannelId, upstreamUrl.trim(), name);
				} else {
					await importLoreRepo(token, numericChannelId, upstreamUrl.trim(), name);
				}
			} catch (e: any) {
				error = describeError(e?.status, e?.message || $_('lconn.err_connect_failed'));
				creating = false;
				return;
			}
		}

		await loadLoreRepo();
		await loadLoreHealth();
		onConnected();
	}

	$effect(() => {
		checkHealth();
	});
</script>

<div class="lore-connect-modal" role="dialog" aria-modal="true" aria-label={$_('lconn.dialog_label')}>
	<div class="connect-card" onclick={(e) => e.stopPropagation()}>
		<div class="connect-header">
			<div class="header-icon">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
				</svg>
			</div>
			<div class="header-text">
				<h2>{$_('lconn.title')}</h2>
				<p>{$_('lconn.subtitle')}</p>
			</div>
			<button class="close-btn" onclick={onClose} aria-label={$_('common.close')}>×</button>
		</div>

		<!-- Health check -->
		<div class="health-section">
			<div class="health-row">
				<span class="health-label">{$_('lconn.health_label')}</span>
				<span class="health-status" class:healthy={health === 'ok'} class:error={health === 'error' || health === 'disabled'}>
					<span class="health-dot"></span>
					{health === 'ok'
						? $_('media_albums.ready')
						: health === 'disabled'
							? $_('lconn.health_disabled')
							: health === 'error'
								? $_('lconn.health_unavailable')
								: $_('lconn.health_checking')}
				</span>
			</div>
			{#if health === 'error'}
				<div class="health-warning">
					⚠️ {$_('lconn.warn_unreachable')}
				</div>
			{:else if health === 'disabled'}
				<div class="health-warning">
					⚠️ {$_('lconn.warn_disabled')}
				</div>
			{/if}
		</div>

		<!-- Connection form -->
		{#if step === 'connect'}
			<form class="connect-form" onsubmit={(e) => { e.preventDefault(); void handleConnect(); }}>
				<div class="form-group">
					<span class="form-label-row">
						<label>{$_('lconn.origin_label')}</label>
						<span class="mode-toggle" role="tablist" aria-label={$_('lconn.mode_group')}>
							<button
								type="button"
								class="mode-btn"
								class:active={mode === 'create'}
								onclick={() => mode = 'create'}
								role="tab"
								aria-selected={mode === 'create'}
							>{$_('lconn.mode_new')}</button>
							<button
								type="button"
								class="mode-btn"
								class:active={mode === 'link'}
								onclick={() => mode = 'link'}
								role="tab"
								aria-selected={mode === 'link'}
							>{$_('lconn.mode_link')}</button>
							<button
								type="button"
								class="mode-btn"
								class:active={mode === 'external'}
								onclick={() => mode = 'external'}
								role="tab"
								aria-selected={mode === 'external'}
							>GitHub / GitLab</button>
						</span>
					</span>
				</div>

					{#if mode === 'create'}
						<div class="form-group">
							<label for="repo-name">{$_('lconn.space_name')}</label>
							<input
								id="repo-name"
								type="text"
								bind:value={repoName}
								placeholder={$_('lconn.placeholder_project')}
								class="input-field"
								autofocus
							/>
							<span class="input-hint">{$_('lconn.hint_create')}</span>
						</div>

						<label class="checkbox-row">
							<input type="checkbox" bind:checked={autoBranchOnUpload} />
							<span class="checkbox-copy">
								<span class="checkbox-title">{$_('lconn.auto_branch_title')}</span>
								<span class="checkbox-hint">{$_('lconn.auto_branch_hint')}</span>
							</span>
						</label>
					{:else if mode === 'link'}
						<div class="form-group">
							<label for="repo-name">{$_('lconn.space_name')}</label>
							<input
								id="repo-name"
								type="text"
								bind:value={repoName}
								placeholder={$_('lconn.placeholder_existing')}
								class="input-field"
								autofocus
							/>
							<span class="input-hint">{$_('lconn.hint_link')}</span>
						</div>
					{:else}
					<div class="form-group">
						<label for="repo-name">{$_('lconn.space_name')}</label>
						<input
							id="repo-name"
							type="text"
							bind:value={repoName}
							placeholder={$_('lconn.placeholder_project')}
							class="input-field"
							autofocus
						/>
						<span class="input-hint">{$_('lconn.hint_external_name')}</span>
					</div>

					<div class="form-group">
						<label for="upstream-url">{$_('lconn.source_url_label')}</label>
						<input
							id="upstream-url"
							type="text"
							bind:value={upstreamUrl}
							placeholder="https://github.com/org/project"
							class="input-field"
						/>
						<span class="input-hint">{$_('lconn.hint_source')}</span>
					</div>
				{/if}

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
					<button type="button" class="btn btn-secondary" onclick={onClose}>{$_('common.cancel')}</button>
					{#if mode === 'external'}
						<button
							type="button"
							class="btn btn-secondary"
							disabled={creating}
							onclick={() => { externalTarget = 'track'; void handleConnect(); }}
						>
							{#if creating && externalTarget === 'track'}<span class="spinner"></span>{/if}
							{$_('lconn.track_btn')}
						</button>
						<button
							type="button"
							class="btn btn-primary"
							disabled={creating}
							onclick={() => { externalTarget = 'import'; void handleConnect(); }}
						>
							{#if creating && externalTarget === 'import'}<span class="spinner"></span>{/if}
							{$_('lconn.import_btn')}
						</button>
					{:else}
						<button type="submit" class="btn btn-primary" disabled={creating}>
							{#if creating}<span class="spinner"></span>{/if}
							{submitLabel()}
						</button>
					{/if}
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
				<h3>{$_('lconn.connected_title')}</h3>
				<p>{$_('lconn.connected_pre')} <strong>{repoName}</strong> {$_('lconn.connected_post')}</p>
				<button class="btn btn-primary" onclick={onConnected}>{$_('lconn.start_btn')}</button>
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

	.checkbox-row {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-2);
		margin-bottom: var(--space-3);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.checkbox-row input {
		margin-top: 3px;
		accent-color: var(--accent-primary);
		flex-shrink: 0;
	}

	.checkbox-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.checkbox-title {
		font-size: var(--font-size-sm);
		font-weight: 600;
		color: var(--text-heading);
	}

	.checkbox-hint {
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