<script lang="ts">
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import type { SafetyRule, SafetyRulesPolicy, SafetyRuleAction, SafetyRuleMatch } from '../../../../../shared/adminPolicyContracts';

	let policy: SafetyRulesPolicy = $state({ enabled: false, rules: [], defaultFlagChannelId: null });
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state('');

	const actions: Array<{ value: SafetyRuleAction; label: string }> = [
		{ value: 'flag', label: 'Flag for staff' }, { value: 'delete', label: 'Block / delete' },
		{ value: 'warn', label: 'Warn' }, { value: 'timeout', label: 'Timeout' }, { value: 'ban', label: 'Ban from channel' }
	];
	const matches: Array<{ value: SafetyRuleMatch; label: string }> = [
		{ value: 'contains', label: 'contains' }, { value: 'equals', label: 'equals' },
		{ value: 'starts_with', label: 'starts with' }, { value: 'ends_with', label: 'ends with' }
	];

	function token() { return getAuthToken($activeServerUrl); }
	async function request(init: RequestInit = {}) {
		const auth = token(); if (!auth) throw new Error('Sign in again to manage safety rules.');
		const response = await fetch(`${$activeServerUrl}/api/server-center/safety`, {
			...init, credentials: 'include', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Safety request failed (${response.status}).`);
		return data;
	}
	async function load() { loading = true; error = ''; try { policy = (await request()).policy; } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not load safety rules.'; } finally { loading = false; } }
	async function save() { saving = true; error = ''; saved = ''; try { policy = (await request({ method: 'PUT', body: JSON.stringify(policy) })).policy; saved = 'Rules saved.'; } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not save safety rules.'; } finally { saving = false; } }
	function addRule() {
		policy.rules = [...policy.rules, { id: crypto.randomUUID(), enabled: true, name: 'New rule', pattern: '', match: 'contains', caseSensitive: false, action: 'flag', timeoutMinutes: 10, reason: null }];
	}
	function removeRule(id: string) { policy.rules = policy.rules.filter(rule => rule.id !== id); }
	function ruleSentence(rule: SafetyRule) {
		const action = actions.find(item => item.value === rule.action)?.label ?? rule.action;
		return `If a message ${rule.match.replace('_', ' ')} “${rule.pattern || '…'}” → ${action}`;
	}
	onMount(() => { void load(); });
</script>

<div class="safety-center">
	<section class="hero">
		<div><span class="eyebrow">Safety rules</span><h2>Automation you can actually understand.</h2><p>Literal trigger → action rules. No mystery score is required for <code>badword → ban</code>.</p></div>
		<label class="master"><input type="checkbox" bind:checked={policy.enabled} /><span>{policy.enabled ? 'Rules active' : 'Rules paused'}</span></label>
	</section>
	<section class="principle"><strong>Simple is valid.</strong><span>A rule can be as dumb and dependable as “if message equals this word, ban from the channel.” More advanced detectors can still use the same action pipeline later.</span></section>
	<section class="scope"><strong>Scope respects privacy.</strong><span>These rules apply to community spaces. DMs and private groups are reports-only unless an admin explicitly opts them into automation under <b>Privacy &amp; retention</b>. Future E2EE content is outside server-side scanning.</span></section>
	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if saved}<div class="saved" role="status">{saved}</div>{/if}
	{#if loading}<p>Loading safety rules…</p>{:else}
		<div class="toolbar"><div><strong>{policy.rules.length} rules</strong><span>First matching enabled rule wins.</span></div><button onclick={addRule}>+ Add rule</button></div>
		<div class="rules">
			{#each policy.rules as rule (rule.id)}
				<article class:disabled={!rule.enabled}>
					<header><label class="toggle"><input type="checkbox" bind:checked={rule.enabled}/><span>{rule.enabled ? 'On' : 'Off'}</span></label><input class="name" bind:value={rule.name} maxlength="80" aria-label="Rule name"/><button class="remove" onclick={() => removeRule(rule.id)}>Remove</button></header>
					<div class="sentence">{ruleSentence(rule)}</div>
					<div class="grid">
						<label><span>Match</span><select bind:value={rule.match}>{#each matches as item}<option value={item.value}>{item.label}</option>{/each}</select></label>
						<label class="pattern"><span>Text / word</span><input bind:value={rule.pattern} maxlength="500" placeholder="badword"/></label>
						<label><span>Action</span><select bind:value={rule.action}>{#each actions as item}<option value={item.value}>{item.label}</option>{/each}</select></label>
						{#if rule.action === 'timeout'}<label><span>Minutes</span><input type="number" min="1" max="10080" bind:value={rule.timeoutMinutes}/></label>{/if}
					</div>
					<div class="options"><label><input type="checkbox" bind:checked={rule.caseSensitive}/> Case sensitive</label><label class="reason"><span>Reason shown to staff</span><input bind:value={rule.reason} maxlength="280" placeholder="Optional"/></label></div>
					{#if rule.action === 'ban'}<p class="warning">Ban currently means the channel containing the matching message; it is not disguised as a server-wide ban.</p>{/if}
					{#if rule.action === 'flag'}<p class="hint">Flag-only currently records the trigger in server diagnostics without punishing the sender. Durable automated case ingestion is still separate from user reports.</p>{/if}
				</article>
			{/each}
			{#if policy.rules.length === 0}<button class="empty" onclick={addRule}><strong>No safety rules yet.</strong><span>Add a literal word/filter rule.</span></button>{/if}
		</div>
		<footer><button class="save" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save safety rules'}</button></footer>
	{/if}
</div>

<style>
	.safety-center{display:grid;gap:16px}.hero{display:flex;justify-content:space-between;gap:24px;padding:24px;border:1px solid var(--border-default);border-radius:18px;background:linear-gradient(135deg,var(--surface-raised),var(--surface-base))}.hero h2{margin:4px 0 7px;font-size:1.7rem}.hero p{margin:0;color:var(--text-secondary)}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--text-muted)}code{padding:2px 6px;background:var(--surface-hover);border-radius:6px}.master,.toggle{display:flex;gap:8px;align-items:center;white-space:nowrap}.principle,.scope{display:flex;gap:9px;padding:13px 15px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-base)}.principle span,.scope span{color:var(--text-secondary)}.scope{background:var(--surface-raised)}.toolbar{display:flex;align-items:center;justify-content:space-between}.toolbar div{display:grid}.toolbar span{color:var(--text-secondary);font-size:.85rem}.rules{display:grid;gap:12px}.rules article{padding:16px;border:1px solid var(--border-default);border-radius:15px;background:var(--surface-raised);display:grid;gap:12px}.rules article.disabled{opacity:.62}.rules header{display:flex;gap:10px;align-items:center}.name{font-weight:650;flex:1}.sentence{font-size:1.05rem;padding:11px 13px;background:var(--surface-base);border-radius:10px}.grid{display:grid;grid-template-columns:150px minmax(180px,1fr) 180px 120px;gap:10px}.grid label,.reason{display:grid;gap:5px}.grid label>span,.reason>span{font-size:.78rem;color:var(--text-secondary)}input,select{font:inherit;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:9px;padding:9px 10px;min-width:0}.options{display:flex;align-items:end;gap:16px}.reason{flex:1}.warning,.hint{margin:0;color:var(--text-secondary);font-size:.86rem}.error,.saved{padding:11px 13px;border:1px solid var(--border-default);border-radius:10px}.error{border-color:var(--danger)}button{font:inherit;cursor:pointer;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:9px;padding:9px 12px}.remove{opacity:.75}.save{font-weight:650}.empty{padding:26px;display:grid;text-align:center;gap:4px;border-style:dashed}.empty span{color:var(--text-secondary)}footer{display:flex;justify-content:flex-end}@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}.hero,.principle,.scope{display:grid}}@media(max-width:600px){.grid{grid-template-columns:1fr}.rules header,.options{align-items:stretch;flex-direction:column}.toolbar{align-items:stretch;gap:10px;flex-direction:column}}
</style>
