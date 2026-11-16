<script lang="ts">
	import { _ } from '$lib/i18n';
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
		{ value: 'flag', label: $_('safety.action_flag') }, { value: 'delete', label: $_('safety.action_delete') },
		{ value: 'warn', label: $_('safety.action_warn') }, { value: 'timeout', label: $_('safety.action_timeout') }, { value: 'ban', label: $_('safety.action_ban') }
	];
	const matches: Array<{ value: SafetyRuleMatch; label: string }> = [
		{ value: 'contains', label: $_('safety.match_contains') }, { value: 'equals', label: $_('safety.match_equals') },
		{ value: 'starts_with', label: $_('safety.match_starts_with') }, { value: 'ends_with', label: $_('safety.match_ends_with') }
	];

	function token() { return getAuthToken($activeServerUrl); }
	async function request(init: RequestInit = {}) {
		const auth = token(); if (!auth) throw new Error($_('safety.sign_in_again'));
		const response = await fetch(`${$activeServerUrl}/api/server-center/safety`, {
			...init, credentials: 'include', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || $_('safety.request_failed', { values: { status: response.status } }));
		return data;
	}
	async function load() { loading = true; error = ''; try { policy = (await request()).policy; } catch (cause) { error = cause instanceof Error ? cause.message : $_('safety.load_failed'); } finally { loading = false; } }
	async function save() { saving = true; error = ''; saved = ''; try { policy = (await request({ method: 'PUT', body: JSON.stringify(policy) })).policy; saved = $_('safety.rules_saved'); } catch (cause) { error = cause instanceof Error ? cause.message : $_('safety.save_failed'); } finally { saving = false; } }
	function addRule() {
		policy.rules = [...policy.rules, { id: crypto.randomUUID(), enabled: true, name: $_('safety.new_rule'), pattern: '', match: 'contains', caseSensitive: false, action: 'flag', timeoutMinutes: 10, reason: null }];
	}
	function removeRule(id: string) { policy.rules = policy.rules.filter(rule => rule.id !== id); }
	function ruleSentence(rule: SafetyRule) {
		const action = actions.find(item => item.value === rule.action)?.label ?? rule.action;
		return $_('safety.rule_sentence', { values: { match: (matches.find(item => item.value === rule.match)?.label ?? rule.match).replace('_', ' '), pattern: rule.pattern || '…', action } });
	}
	onMount(() => { void load(); });
</script>

<div class="safety-center">
	<section class="hero">
		<div><span class="eyebrow">{$_('safety.eyebrow')}</span><h2>{$_('safety.hero_title')}</h2><p>{$_('safety.hero_desc')} <code>{$_('safety.example_rule')}</code>.</p></div>
		<label class="master"><input type="checkbox" bind:checked={policy.enabled} /><span>{policy.enabled ? $_('safety.rules_active') : $_('safety.rules_paused')}</span></label>
	</section>
	<section class="principle"><strong>{$_('safety.principle_title')}</strong><span>{$_('safety.principle_desc')}</span></section>
	<section class="scope"><strong>{$_('safety.scope_title')}</strong><span>{$_('safety.scope_desc_1')} <b>{$_('pc.eyebrow')}</b>{$_('safety.scope_desc_2')}</span></section>
	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if saved}<div class="saved" role="status">{saved}</div>{/if}
	{#if loading}<p>{$_('safety.loading')}</p>{:else}
		<div class="toolbar"><div><strong>{$_('safety.rules_count', { values: { count: policy.rules.length } })}</strong><span>{$_('safety.first_match')}</span></div><button onclick={addRule}>{$_('safety.add_rule')}</button></div>
		<div class="rules">
			{#each policy.rules as rule (rule.id)}
				<article class:disabled={!rule.enabled}>
					<header><label class="toggle"><input type="checkbox" bind:checked={rule.enabled}/><span>{rule.enabled ? $_('audio_settings.on') : $_('audio_settings.off')}</span></label><input class="name" bind:value={rule.name} maxlength="80" aria-label={$_('safety.rule_name_label')}/><button class="remove" onclick={() => removeRule(rule.id)}>{$_('profile_settings.remove')}</button></header>
					<div class="sentence">{ruleSentence(rule)}</div>
					<div class="grid">
						<label><span>{$_('safety.match')}</span><select bind:value={rule.match}>{#each matches as item}<option value={item.value}>{item.label}</option>{/each}</select></label>
						<label class="pattern"><span>{$_('safety.text_word')}</span><input bind:value={rule.pattern} maxlength="500" placeholder={$_('safety.pattern_placeholder')}/></label>
						<label><span>{$_('ffxiv.kind_action')}</span><select bind:value={rule.action}>{#each actions as item}<option value={item.value}>{item.label}</option>{/each}</select></label>
						{#if rule.action === 'timeout'}<label><span>{$_('safety.minutes')}</span><input type="number" min="1" max="10080" bind:value={rule.timeoutMinutes}/></label>{/if}
					</div>
					<div class="options"><label><input type="checkbox" bind:checked={rule.caseSensitive}/> {$_('safety.case_sensitive')}</label><label class="reason"><span>{$_('safety.reason_staff')}</span><input bind:value={rule.reason} maxlength="280" placeholder={$_('payment_sheet.optional')}/></label></div>
					{#if rule.action === 'ban'}<p class="warning">{$_('safety.ban_warning')}</p>{/if}
					{#if rule.action === 'flag'}<p class="hint">{$_('safety.flag_hint')}</p>{/if}
				</article>
			{/each}
			{#if policy.rules.length === 0}<button class="empty" onclick={addRule}><strong>{$_('safety.empty_title')}</strong><span>{$_('safety.empty_desc')}</span></button>{/if}
		</div>
		<footer><button class="save" onclick={save} disabled={saving}>{saving ? $_('payment_access_panel.saving') : $_('safety.save_rules')}</button></footer>
	{/if}
</div>

<style>
	.safety-center{display:grid;gap:16px}.hero{display:flex;justify-content:space-between;gap:24px;padding:24px;border:1px solid var(--w-line-strong);border-radius:18px;background:linear-gradient(135deg,var(--w-raise),var(--w-bg2))}.hero h2{margin:4px 0 7px;font-size:1.7rem}.hero p{margin:0;color:var(--w-mute)}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--w-mute)}code{padding:2px 6px;background:var(--w-raise);border-radius:6px}.master,.toggle{display:flex;gap:8px;align-items:center;white-space:nowrap}.principle,.scope{display:flex;gap:9px;padding:13px 15px;border:1px solid var(--w-line-strong);border-radius:12px;background:var(--w-bg2)}.principle span,.scope span{color:var(--w-mute)}.scope{background:var(--w-raise)}.toolbar{display:flex;align-items:center;justify-content:space-between}.toolbar div{display:grid}.toolbar span{color:var(--w-mute);font-size:.85rem}.rules{display:grid;gap:12px}.rules article{padding:16px;border:1px solid var(--w-line-strong);border-radius:15px;background:var(--w-raise);display:grid;gap:12px}.rules article.disabled{opacity:.62}.rules header{display:flex;gap:10px;align-items:center}.name{font-weight:650;flex:1}.sentence{font-size:1.05rem;padding:11px 13px;background:var(--w-bg2);border-radius:10px}.grid{display:grid;grid-template-columns:150px minmax(180px,1fr) 180px 120px;gap:10px}.grid label,.reason{display:grid;gap:5px}.grid label>span,.reason>span{font-size:.78rem;color:var(--w-mute)}input,select{font:inherit;color:var(--w-text);background:var(--w-bg2);border:1px solid var(--w-line-strong);border-radius:9px;padding:9px 10px;min-width:0}.options{display:flex;align-items:end;gap:16px}.reason{flex:1}.warning,.hint{margin:0;color:var(--w-mute);font-size:.86rem}.error,.saved{padding:11px 13px;border:1px solid var(--w-line-strong);border-radius:10px}.error{border-color:var(--w-danger)}button{font:inherit;cursor:pointer;color:var(--w-text);background:var(--w-bg2);border:1px solid var(--w-line-strong);border-radius:9px;padding:9px 12px}.remove{opacity:.75}.save{font-weight:650}.empty{padding:26px;display:grid;text-align:center;gap:4px;border-style:dashed}.empty span{color:var(--w-mute)}footer{display:flex;justify-content:flex-end}@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}.hero,.principle,.scope{display:grid}}@media(max-width:600px){.grid{grid-template-columns:1fr}.rules header,.options{align-items:stretch;flex-direction:column}.toolbar{align-items:stretch;gap:10px;flex-direction:column}}
</style>
