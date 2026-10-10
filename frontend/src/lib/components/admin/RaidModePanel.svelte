<script lang="ts">
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	let active = $state(false);
	let until: string | null = $state(null);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	async function request(init: RequestInit = {}) {
		const token = getAuthToken($activeServerUrl);
		if (!token) throw new Error('Sign in again to manage join controls.');
		const response = await fetch(`${$activeServerUrl}/api/server-center/raid-mode`, {
			...init, credentials: 'include', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Join control request failed (${response.status}).`);
		return data;
	}
	async function refresh() {
		loading = true; error = '';
		try { const data = await request(); active = data.active; until = data.until; }
		catch (cause) { error = cause instanceof Error ? cause.message : 'Could not load join controls.'; }
		finally { loading = false; }
	}
	async function setMinutes(minutes: number) {
		busy = true; error = '';
		try { const data = await request({ method: 'PUT', body: JSON.stringify({ minutes }) }); active = data.active; until = data.until; }
		catch (cause) { error = cause instanceof Error ? cause.message : 'Could not update join controls.'; }
		finally { busy = false; }
	}
	onMount(() => { void refresh(); });
</script>

<section class="join-controls">
	<div><h2>Temporary join controls</h2><p>During a raid, require invitations for new accounts and pause guest joins. Existing members stay signed in. This expires automatically and does not keep extra message content.</p><strong>{loading ? 'Loading…' : active && until ? `Active until ${new Date(until).toLocaleString()}` : 'Normal joining'}</strong></div>
	<div class="buttons"><button onclick={() => setMinutes(30)} disabled={busy || loading}>30 min</button><button onclick={() => setMinutes(60)} disabled={busy || loading}>1 hour</button><button onclick={() => setMinutes(240)} disabled={busy || loading}>4 hours</button>{#if active}<button onclick={() => setMinutes(0)} disabled={busy || loading}>Turn off</button>{/if}</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
	.join-controls{display:grid;gap:12px;margin-bottom:18px;padding:18px;border:1px solid var(--w-line-strong);border-radius:16px;background:var(--w-raise)}h2{margin:0 0 5px;font-size:1.1rem}.join-controls p{margin:0 0 8px;color:var(--w-mute)}.join-controls strong{font-size:.87rem}.buttons{display:flex;flex-wrap:wrap;gap:8px}.buttons button{border:1px solid var(--w-line-strong);border-radius:9px;background:var(--w-bg2);color:var(--w-text);padding:8px 12px;font:inherit;cursor:pointer}.buttons button:disabled{opacity:.5}.error{color:var(--w-danger)}
</style>
