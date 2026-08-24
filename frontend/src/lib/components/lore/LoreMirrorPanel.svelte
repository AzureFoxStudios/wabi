<script lang="ts">
	/**
	 * Mirror panel — configure and run off-box mirroring of this space to a
	 * generic git remote, GitHub, GitLab, or S3 (addon P7).
	 */
	import { onMount } from 'svelte';
	import { getAuthToken } from '$lib/authSession';
	import { parseLoreChannelId, getLoreRepo, loreUrl } from '$lib/api/lore';

	interface Props {
		channelId: string | null;
	}

	let { channelId }: Props = $props();

	let backend = $state<'git' | 'github' | 'gitlab' | 's3'>('git');
	let remoteUrl = $state('');
	let autoMirror = $state(false);
	let saving = $state(false);
	let mirroring = $state(false);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);
	let readOnlyRepo = $state(false);

	onMount(async () => {
		const token = getAuthToken();
		const numericId = parseLoreChannelId(channelId);
		if (!token || !numericId) return;
		try {
			const repo = await getLoreRepo(token, numericId);
			readOnlyRepo = repo?.class === 'mirror' || (repo?.class != null && typeof repo.class === 'object' && 'mirror' in repo.class);
			const res = await fetch(loreUrl(`/repos/${numericId}/mirror/configs`), {
				headers: { Authorization: `Bearer ${token}` }
			});
			if (res.ok) {
				const payload = (await res.json()) as {
					configs?: Array<{ backend?: string; remote_url?: string; auto_mirror?: boolean }>;
				};
				const cfg = payload.configs?.[0];
				if (cfg) {
					backend = (cfg.backend as typeof backend) ?? 'git';
					remoteUrl = cfg.remote_url ?? '';
					autoMirror = cfg.auto_mirror ?? false;
				}
			}
		} catch {
			// Panel stays empty; saving will surface errors.
		}
	});

	async function save() {
		const token = getAuthToken();
		const numericId = parseLoreChannelId(channelId);
		if (!token || !numericId || !remoteUrl.trim()) return;
		saving = true;
		error = null;
		message = null;
		try {
			const res = await fetch(loreUrl(`/repos/${numericId}/mirror`), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					backend,
					remote_url: remoteUrl.trim(),
					auto_mirror: autoMirror,
					tags: true
				})
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = payload.error || `Save failed (${res.status})`;
				return;
			}
			message = 'Mirror configuration saved.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Network error';
		} finally {
			saving = false;
		}
	}

	async function runNow() {
		const token = getAuthToken();
		const numericId = parseLoreChannelId(channelId);
		if (!token || !numericId) return;
		mirroring = true;
		error = null;
		message = null;
		try {
			const res = await fetch(loreUrl(`/repos/${numericId}/mirror/run`), {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` }
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = payload.error || `Mirror run failed (${res.status})`;
				return;
			}
			message = 'Mirror pushed.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Network error';
		} finally {
			mirroring = false;
		}
	}
</script>

{#if readOnlyRepo}
	<p class="mirror-readonly">External mirrors are read-only pointers — nothing to push.</p>
{:else}
	<div class="mirror-panel">
		<div class="row">
			<select class="input select" bind:value={backend} aria-label="Mirror backend">
				<option value="git">Git remote</option>
				<option value="github">GitHub</option>
				<option value="gitlab">GitLab</option>
				<option value="s3">S3</option>
			</select>
			<input
				class="input grow"
				placeholder="https://github.com/you/repo.git"
				bind:value={remoteUrl}
				aria-label="Remote URL"
			/>
		</div>
		<label class="auto-row">
			<input type="checkbox" bind:checked={autoMirror} />
			Mirror automatically after every commit
		</label>
		<div class="row">
			<button class="btn" disabled={saving || !remoteUrl.trim()} onclick={() => void save()}>
				{saving ? 'Saving…' : 'Save configuration'}
			</button>
			<button class="btn primary" disabled={mirroring || !remoteUrl.trim()} onclick={() => void runNow()}>
				{mirroring ? 'Pushing…' : 'Push mirror now'}
			</button>
		</div>
		{#if message}<p class="ok" role="status">{message}</p>{/if}
		{#if error}<p class="err" role="alert">{error}</p>{/if}
	</div>
{/if}

<style>
	.mirror-panel,
	.mirror-readonly {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--font-size-xs);
	}

	.mirror-readonly {
		color: var(--text-muted);
	}

	.row {
		display: flex;
		gap: var(--space-1);
		flex-wrap: wrap;
	}

	.input {
		padding: 4px var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		background: var(--surface-sunken);
		color: var(--text-body);
		font-size: var(--font-size-xs);
	}

	.select {
		flex: 0 0 auto;
	}

	.grow {
		flex: 1 1 220px;
		min-width: 0;
		font-family: var(--font-family-mono, monospace);
	}

	.auto-row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--text-secondary);
	}

	.btn {
		padding: 4px var(--space-3);
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
		background: var(--surface-raised);
		color: var(--text-heading);
		font-size: var(--font-size-xs);
		cursor: pointer;
	}

	.btn.primary {
		background: var(--accent-primary);
		border-color: transparent;
		color: #fff;
		font-weight: 600;
	}

	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.ok {
		margin: 0;
		color: var(--color-success, #22c55e);
	}

	.err {
		margin: 0;
		color: var(--color-danger, #ef4444);
	}
</style>
