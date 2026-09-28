<script lang="ts">
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';

	type Rules = { text: string; revision: number; requireAckBeforePosting: boolean };
	let published: Rules | null = $state(null);
	let text = $state('');
	let requireAckBeforePosting = $state(false);
	let materialChange = $state(true);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state('');

	async function request(init: RequestInit = {}) {
		const auth = getAuthToken($activeServerUrl);
		if (!auth) throw new Error('Sign in again to manage server rules.');
		const response = await fetch(`${$activeServerUrl}/api/server-center/rules`, {
			...init, credentials: 'include',
			headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Rules request failed (${response.status}).`);
		return data;
	}
	async function refresh() {
		loading = true; error = '';
		try {
			const data = await request();
			published = data.rules;
			text = data.rules.text;
			requireAckBeforePosting = data.rules.requireAckBeforePosting;
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Could not load rules.'; }
		finally { loading = false; }
	}
	async function save() {
		saving = true; error = ''; saved = '';
		try {
			const data = await request({ method: 'PUT', body: JSON.stringify({ text, requireAckBeforePosting, materialChange }) });
			published = data.rules;
			text = data.rules.text;
			requireAckBeforePosting = data.rules.requireAckBeforePosting;
			saved = `Rules published as revision ${data.rules.revision}.`;
		} catch (cause) { error = cause instanceof Error ? cause.message : 'Could not publish rules.'; }
		finally { saving = false; }
	}
	onMount(() => { void refresh(); });
</script>

<details class="rules-editor">
	<summary><strong>Server rules and newcomer screen</strong><span>Write the rules members see when they arrive.</span></summary>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if saved}<p class="saved" role="status">{saved}</p>{/if}
	{#if loading}<p>Loading published rules…</p>{:else}
		<label>Rules text<textarea bind:value={text} rows="9" maxlength="12000" placeholder="What should someone know before joining this community?"></textarea></label>
		<p class="hint">This is a readable welcome document. Safety-rule patterns and message retention are configured separately.</p>
		<label class="check"><input type="checkbox" bind:checked={requireAckBeforePosting} /> Ask members to acknowledge these rules before posting in community channels</label>
		<label class="check"><input type="checkbox" bind:checked={materialChange} /> This is a material rules change; ask members to acknowledge this revision again</label>
		<div class="actions"><span>Published revision {published?.revision ?? 0}</span><button onclick={save} disabled={saving || (!text.trim() && requireAckBeforePosting)}>{saving ? 'Publishing…' : 'Publish rules'}</button></div>
	{/if}
</details>

<style>
	.rules-editor{padding:18px;border:1px solid var(--border-default);border-radius:16px;background:var(--surface-raised);display:grid;gap:12px;margin-bottom:18px}.rules-editor summary{cursor:pointer;display:grid;gap:4px}.rules-editor summary span,.hint,.actions span{color:var(--text-secondary);font-size:.84rem}.rules-editor label:not(.check){display:grid;gap:7px;margin-top:14px;font-weight:600}.rules-editor textarea{width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--border-default);border-radius:10px;padding:12px;background:var(--surface-base);color:var(--text-primary);font:inherit;line-height:1.5}.check{display:flex;align-items:start;gap:9px;margin:12px 0}.check input{margin-top:4px}.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.actions button{border:1px solid var(--border-default);border-radius:9px;padding:9px 13px;background:var(--surface-base);color:var(--text-primary);font:inherit;cursor:pointer}.actions button:disabled{opacity:.5}.error{color:var(--danger)}.saved{color:var(--text-primary)}
</style>
