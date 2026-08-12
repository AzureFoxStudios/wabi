<script lang="ts">
	/** P4: Editor Bridge — opens an ephemeral code-server/OpenVSCode session for the Lore repo.
	 *
	 * The backend manages the code-server container lifecycle. This component
	 * requests a session, polls for readiness, then opens in an iframe or new tab.
	 */
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { parseLoreChannelId } from '$lib/api/lore';
	import { currentChannel } from '$lib/socket';

	interface Props {
		channelId: string;
		repoPath?: string;
		onClose: () => void;
	}

	let { channelId, repoPath, onClose }: Props = $props();

	let sessionUrl = $state<string | null>(null);
	let status = $state<'idle' | 'starting' | 'ready' | 'error'>('idle');
	let errorMessage = $state<string | null>(null);
	let progress = $state(0);

	async function startSession() {
		status = 'starting';
		errorMessage = null;
		progress = 0;

		const token = getAuthToken();
		const numericId = parseLoreChannelId(channelId);
		if (!token || !numericId) {
			status = 'error';
			errorMessage = 'Missing auth or channel ID';
			return;
		}

		try {
			const res = await fetch(`/api/addons/lore/repos/${numericId}/editor`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ repoPath }),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				status = 'error';
				errorMessage = err.error || `Failed to start editor: ${res.status}`;
				return;
			}

			const data = await res.json();
			sessionUrl = data.url;
			status = 'ready';
			progress = 100;
		} catch (e) {
			status = 'error';
			errorMessage = e instanceof Error ? e.message : 'Network error';
		}
	}

	// Poll for progress while starting
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		return () => {
			if (pollInterval) clearInterval(pollInterval);
		};
	});
</script>

<div class="editor-bridge">
	{#if status === 'idle'}
		<div class="editor-prompt">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
				<polyline points="16 18 22 12 16 6"/>
				<polyline points="8 6 2 12 8 18"/>
				<line x1="14" y1="4" x2="10" y2="20"/>
			</svg>
			<span>Open in Editor</span>
			<p class="subtitle">Launch an ephemeral code-server session for this repository</p>
			<button class="btn btn-primary" onclick={startSession}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
					<polygon points="5 3 19 12 5 21 5 3"/>
				</svg>
				Start Editor Session
			</button>
		</div>
	{:else if status === 'starting'}
		<div class="editor-starting">
			<span class="spinner"></span>
			<span>Starting code-server...</span>
			<div class="progress-bar">
				<div class="progress-fill" style="width: {progress}%"></div>
			</div>
			<p class="subtitle">This may take 10-30 seconds on first launch</p>
		</div>
	{:else if status === 'error'}
		<div class="editor-error">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48">
				<circle cx="12" cy="12" r="10"/>
				<line x1="12" y1="8" x2="12" y2="12"/>
				<line x1="12" y1="16" x2="12.01" y2="16"/>
			</svg>
			<span>Failed to start editor</span>
			<p class="error-detail">{errorMessage}</p>
			<button class="btn" onclick={startSession}>Retry</button>
		</div>
	{:else if status === 'ready' && sessionUrl}
		<div class="editor-ready">
			<div class="editor-header">
				<span class="editor-status">
					<span class="status-dot ready"></span>
					Editor Ready
				</span>
				<div class="editor-actions">
					<a href={sessionUrl} target="_blank" rel="noopener" class="btn btn-primary">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
							<polyline points="15 3 21 3 21 9"/>
							<line x1="10" y1="14" x2="21" y2="3"/>
						</svg>
						Open in New Tab
					</a>
					<button class="btn" onclick={onClose}>Close</button>
				</div>
			</div>
			<iframe src={sessionUrl} class="editor-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
		</div>
	{/if}
</div>

<style>
	.editor-bridge {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.editor-prompt, .editor-starting, .editor-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: 100%;
		color: var(--text-secondary);
	}

	.editor-prompt svg {
		opacity: 0.5;
	}

	.subtitle {
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		margin: 0;
		text-align: center;
		max-width: 300px;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 8px var(--space-3);
		border-radius: var(--radius-sm);
		font-size: var(--font-size-sm);
		cursor: pointer;
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		background: var(--surface-sunken);
		color: var(--text-secondary);
		text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.btn:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.btn-primary {
		background: var(--accent-primary);
		color: white;
		border-color: var(--accent-primary);
	}

	.btn-primary:hover {
		background: var(--accent-secondary);
		border-color: var(--accent-secondary);
	}

	.spinner {
		width: 24px;
		height: 24px;
		border: 2px solid var(--surface-raised);
		border-top-color: var(--accent-primary);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.progress-bar {
		width: 200px;
		height: 4px;
		background: var(--surface-raised);
		border-radius: 2px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent-primary);
		transition: width 0.3s ease;
		border-radius: 2px;
	}

	.editor-error {
		color: var(--color-danger, #ef4444);
	}

	.editor-error svg {
		opacity: 0.6;
	}

	.error-detail {
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		font-family: var(--font-mono);
		margin: 0;
		max-width: 400px;
		word-break: break-all;
	}

	.editor-ready {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.editor-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-1) var(--space-2);
		background: var(--surface-raised);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.editor-status {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--font-size-sm);
		color: var(--color-success, #22c55e);
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.status-dot.ready {
		background: var(--color-success, #22c55e);
		box-shadow: 0 0 6px var(--color-success, #22c55e);
	}

	.editor-actions {
		display: flex;
		gap: var(--space-1);
	}

	.editor-frame {
		flex: 1;
		border: none;
		background: #1e1e1e;
	}
</style>