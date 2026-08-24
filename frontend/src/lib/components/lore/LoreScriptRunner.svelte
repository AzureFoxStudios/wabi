<script lang="ts">
	/**
	 * Script runner — execute repo scripts (.py/.sh/.js) server-side with
	 * concurrency limits and timeouts (addon P5). Owner/Admin/Developer only;
	 * callers gate visibility.
	 */
	import { getAuthToken } from '$lib/authSession';
	import { parseLoreChannelId, loreUrl } from '$lib/api/lore';

	interface Props {
		channelId: string | null;
	}

	let { channelId }: Props = $props();

	let scriptPath = $state('');
	let args = $state('');
	let running = $state(false);
	let error = $state<string | null>(null);
	let output = $state<string | null>(null);

	async function run() {
		const token = getAuthToken();
		const numericId = parseLoreChannelId(channelId);
		if (!token || !numericId || !scriptPath.trim()) return;
		running = true;
		error = null;
		output = null;
		try {
			const res = await fetch(loreUrl(`/repos/${numericId}/scripts/run`), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					script_path: scriptPath.trim(),
					arguments: args.trim() ? args.split(/\s+/) : []
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = payload.error || `Run failed (${res.status})`;
				return;
			}
			const r = payload.result ?? {};
			output = [r.stdout, r.stderr].filter(Boolean).join('\n') || `(exit ${r.exit_code ?? 0}, no output)`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Network error';
		} finally {
			running = false;
		}
	}
</script>

<div class="script-runner">
	<form
		class="run-row"
		onsubmit={(e) => {
			e.preventDefault();
			void run();
		}}
	>
		<input
			class="run-input"
			placeholder="scripts/deploy.py"
			bind:value={scriptPath}
			aria-label="Script path"
		/>
		<input class="run-input args" placeholder="args…" bind:value={args} aria-label="Arguments" />
		<button class="run-btn" type="submit" disabled={running || !scriptPath.trim()}>
			{running ? 'Running…' : 'Run'}
		</button>
	</form>

	{#if error}<p class="run-error" role="alert">{error}</p>{/if}

	{#if output !== null}
		<pre class="run-output">{output}</pre>
	{/if}
</div>

<style>
	.script-runner {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.run-row {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.run-input {
		flex: 1 1 180px;
		min-width: 0;
		padding: 4px var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		background: var(--surface-sunken);
		color: var(--text-body);
		font-family: var(--font-family-mono, monospace);
		font-size: var(--font-size-xs);
	}

	.run-input.args {
		flex: 0 1 140px;
	}

	.run-btn {
		padding: 4px var(--space-3);
		border-radius: var(--radius-sm);
		border: none;
		background: var(--accent-primary);
		color: #fff;
		font-size: var(--font-size-xs);
		font-weight: 600;
		cursor: pointer;
	}

	.run-btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.run-error {
		margin: 0;
		color: var(--color-danger, #ef4444);
		font-size: var(--font-size-xs);
	}

	.run-output {
		margin: 0;
		padding: var(--space-2);
		max-height: 220px;
		overflow: auto;
		background: rgba(0, 0, 0, 0.28);
		border-radius: var(--radius-sm);
		font-family: var(--font-family-mono, monospace);
		font-size: var(--font-size-xs);
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
