<script lang="ts">
	import { _ } from '$lib/i18n';
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
		if (!auth) throw new Error($_('crp.sign_in'));
		const response = await fetch(`${$activeServerUrl}/api/server-center/rules`, {
			...init, credentials: 'include',
			headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || $_('crp.request_failed', { values: { status: response.status } }));
		return data;
	}
	async function refresh() {
		loading = true; error = '';
		try {
			const data = await request();
			published = data.rules;
			text = data.rules.text;
			requireAckBeforePosting = data.rules.requireAckBeforePosting;
		} catch (cause) { error = cause instanceof Error ? cause.message : $_('crp.load_failed'); }
		finally { loading = false; }
	}
	async function save() {
		saving = true; error = ''; saved = '';
		try {
			const data = await request({ method: 'PUT', body: JSON.stringify({ text, requireAckBeforePosting, materialChange }) });
			published = data.rules;
			text = data.rules.text;
			requireAckBeforePosting = data.rules.requireAckBeforePosting;
			saved = $_('crp.published', { values: { revision: data.rules.revision } });
		} catch (cause) { error = cause instanceof Error ? cause.message : $_('crp.publish_failed'); }
		finally { saving = false; }
	}
	onMount(() => { void refresh(); });
</script>

<details class="rules-editor">
	<summary><strong>{$_('crp.title')}</strong><span>{$_('crp.summary_hint')}</span></summary>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if saved}<p class="saved" role="status">{saved}</p>{/if}
	{#if loading}<p>{$_('crp.loading')}</p>{:else}
		<label>{$_('crp.rules_text')}<textarea bind:value={text} rows="9" maxlength="12000" placeholder={$_('crp.rules_ph')}></textarea></label>
		<p class="hint">{$_('crp.hint')}</p>
		<label class="check"><input type="checkbox" bind:checked={requireAckBeforePosting} /> {$_('crp.ack')}</label>
		<label class="check"><input type="checkbox" bind:checked={materialChange} /> {$_('crp.material')}</label>
		<div class="actions"><span>{$_('crp.published_rev', { values: { revision: published?.revision ?? 0 } })}</span><button onclick={save} disabled={saving || (!text.trim() && requireAckBeforePosting)}>{saving ? $_('crp.publishing') : $_('crp.publish')}</button></div>
	{/if}
</details>

<style>
	.rules-editor{padding:18px;border:1px solid var(--w-line-strong);border-radius:16px;background:var(--w-raise);display:grid;gap:12px;margin-bottom:18px}.rules-editor summary{cursor:pointer;display:grid;gap:4px}.rules-editor summary span,.hint,.actions span{color:var(--w-mute);font-size:.84rem}.rules-editor label:not(.check){display:grid;gap:7px;margin-top:14px;font-weight:600}.rules-editor textarea{width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--w-line-strong);border-radius:10px;padding:12px;background:var(--w-bg2);color:var(--w-text);font:inherit;line-height:1.5}.check{display:flex;align-items:start;gap:9px;margin:12px 0}.check input{margin-top:4px}.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.actions button{border:1px solid var(--w-line-strong);border-radius:9px;padding:9px 13px;background:var(--w-bg2);color:var(--w-text);font:inherit;cursor:pointer}.actions button:disabled{opacity:.5}.error{color:var(--w-danger)}.saved{color:var(--w-text)}
</style>
