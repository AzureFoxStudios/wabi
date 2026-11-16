<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import type {
		ServerPrivacyPolicy,
		ServerDefaultRetention,
		ServerAnalyticsMode,
		ServerExternalProcessingMode
	} from '../../../../../shared/adminPolicyContracts';

	let policy: ServerPrivacyPolicy = $state({
		defaultRetention: '24h',
		privateContentAutomation: false,
		analyticsMode: 'off',
		externalProcessing: 'none',
		reportEvidencePreservation: 'explicit_report',
		reportEvidenceDays: null
	});
	let published: ServerPrivacyPolicy | null = $state(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state('');

	const retention: Array<{ value: ServerDefaultRetention; label: string; detail: string }> = [
		{ value: 'live', label: $_('pc.ret_live_label'), detail: $_('pc.ret_live_detail') },
		{ value: '1h', label: $_('pc.ret_1h_label'), detail: $_('pc.ret_1h_detail') },
		{ value: '24h', label: $_('pc.ret_24h_label'), detail: $_('pc.ret_24h_detail') },
		{ value: '7d', label: $_('pc.ret_7d_label'), detail: $_('pc.ret_7d_detail') },
		{ value: '30d', label: $_('pc.ret_30d_label'), detail: $_('pc.ret_30d_detail') },
		{ value: 'forever', label: $_('pc.ret_forever_label'), detail: $_('pc.ret_forever_detail') }
	];

	function token() { return getAuthToken($activeServerUrl); }
	async function request(init: RequestInit = {}) {
		const auth = token();
		if (!auth) throw new Error($_('pc.sign_in'));
		const response = await fetch(`${$activeServerUrl}/api/server-center/privacy`, {
			...init,
			credentials: 'include',
			headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || $_('pc.request_failed', { values: { status: response.status } }));
		return data;
	}

	async function load() {
		loading = true; error = ''; saved = '';
		try {
			const data = await request();
			policy = data.policy;
			published = structuredClone(data.policy);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : $_('pc.load_failed');
		} finally { loading = false; }
	}

	async function save() {
		if (saving) return;
		saving = true; error = ''; saved = '';
		try {
			const data = await request({ method: 'PUT', body: JSON.stringify(policy) });
			policy = data.policy;
			published = structuredClone(data.policy);
			saved = $_('pc.saved');
		} catch (cause) {
			error = cause instanceof Error ? cause.message : $_('pc.save_failed');
		} finally { saving = false; }
	}

	function setRetention(value: ServerDefaultRetention) { policy.defaultRetention = value; saved = ''; }
	function setAnalytics(value: ServerAnalyticsMode) { policy.analyticsMode = value; saved = ''; }
	function setExternal(value: ServerExternalProcessingMode) { policy.externalProcessing = value; saved = ''; }
	const dirty = $derived(published ? JSON.stringify(policy) !== JSON.stringify(published) : false);

	onMount(() => { void load(); });
</script>

<div class="privacy-center">
	<section class="hero">
		<div>
			<span class="eyebrow">{$_('pc.eyebrow')}</span>
			<h2>{$_('pc.hero_title')}</h2>
			<p>{$_('pc.hero_1')}</p>
			<p>{$_('pc.hero_2')}</p>
		</div>
		<div class="truth"><strong>{$_('pc.truth_title')}</strong><span>{$_('pc.truth_line')}</span></div>
	</section>

	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if saved}<div class="saved" role="status">{saved}</div>{/if}

	{#if loading}
		<section class="card"><p>{$_('pc.loading')}</p></section>
	{:else}
		<section class="card">
			<header><div><span class="step">1</span><div><h3>{$_('pc.step1_title')}</h3><p>{$_('pc.step1_text')}</p></div></div></header>
			<div class="retention-grid">
				{#each retention as option}
					<button class:selected={policy.defaultRetention === option.value} onclick={() => setRetention(option.value)}>
						<strong>{option.label}</strong><span>{option.detail}</span>
					</button>
				{/each}
			</div>
			<p class="note"><strong>{$_('pc.retention_strong')}</strong> {$_('pc.retention_rest')}</p>
		</section>

		<section class="card">
			<header><div><span class="step">2</span><div><h3>{$_('pc.step2_title')}</h3><p>{$_('pc.step2_text')}</p></div></div></header>
			<div class="choice-row">
				<div><strong>{$_('pc.reports_only')}</strong><span>{$_('pc.reports_only_text')}</span></div>
				<label class="switch"><input type="checkbox" bind:checked={policy.privateContentAutomation} onchange={() => saved = ''}/><span></span></label>
			</div>
			{#if policy.privateContentAutomation}
				<div class="warning"><strong>{$_('pc.automation_on')}</strong><span>{$_('pc.automation_text')}</span></div>
			{:else}
				<div class="good"><strong>{$_('pc.spaces_reports')}</strong><span>{$_('pc.spaces_text')}</span></div>
			{/if}
		</section>

		<section class="card">
			<header><div><span class="step">3</span><div><h3>{$_('pc.step3_title')}</h3><p>{$_('pc.step3_text')}</p></div></div></header>
			<div class="policy-line"><strong>{$_('pc.evidence_pres')}</strong><span>{$_('pc.explicit_only')}</span></div>
			<label class="policy-line"><strong>{$_('pc.snapshots')}</strong><select bind:value={policy.reportEvidenceDays} onchange={() => saved = ''}><option value={null}>{$_('pc.keep_until')}</option><option value={1}>{$_('pc.remove_1d')}</option><option value={7}>{$_('pc.remove_7d')}</option><option value={30}>{$_('pc.remove_30d')}</option><option value={90}>{$_('pc.remove_90d')}</option></select></label>
			<p class="note">{$_('pc.report_note')}</p>
		</section>

		<section class="card muted-card">
			<header><div><span class="step">4</span><div><h3>{$_('pc.step4_title')}</h3><p>{$_('pc.step4_text')}</p></div></div></header>
			<div class="two-choice">
				<button class:selected={policy.analyticsMode === 'off'} onclick={() => setAnalytics('off')}><strong>{$_('pc.off')}</strong><span>{$_('pc.off_text')}</span></button>
				<button class:selected={policy.analyticsMode === 'local_aggregate'} onclick={() => setAnalytics('local_aggregate')}><strong>{$_('pc.local_aggregate')}</strong><span>{$_('pc.local_aggregate_text')}</span></button>
			</div>
			<p class="caveat">{$_('pc.analytics_caveat')}</p>
		</section>

		<section class="card muted-card">
			<header><div><span class="step">5</span><div><h3>{$_('pc.step5_title')}</h3><p>{$_('pc.step5_text')}</p></div></div></header>
			<div class="two-choice">
				<button class:selected={policy.externalProcessing === 'none'} onclick={() => setExternal('none')}><strong>{$_('pc.none_policy')}</strong><span>{$_('pc.none_policy_text')}</span></button>
				<button class:selected={policy.externalProcessing === 'declared_integrations'} onclick={() => setExternal('declared_integrations')}><strong>{$_('pc.declared')}</strong><span>{$_('pc.declared_text')}</span></button>
			</div>
			<p class="caveat">{$_('pc.external_caveat')}</p>
		</section>

		<section class="principles">
			<div><strong>{$_('pc.never_means')}</strong><span>{$_('pc.never_means_text')}</span></div>
			<div><strong>{$_('pc.encrypted_msgs')}</strong><span>{$_('pc.encrypted_text')}</span></div>
			<div><strong>{$_('pc.no_downgrade')}</strong><span>{$_('pc.no_downgrade_text')}</span></div>
		</section>

		<footer>
			<span>{dirty ? $_('pc.unsaved') : $_('pc.matches')}</span>
			<button class="save" onclick={save} disabled={saving || !dirty}>{saving ? $_('pc.saving') : $_('pc.save')}</button>
		</footer>
	{/if}
</div>

<style>
	.privacy-center{display:grid;gap:16px;max-width:1100px}.hero,.card,.principles{border:1px solid var(--w-line-strong);border-radius:18px;background:var(--w-raise)}.hero{display:flex;justify-content:space-between;gap:24px;padding:25px;background:linear-gradient(135deg,var(--w-raise),var(--w-bg2))}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--w-mute)}.hero h2{margin:5px 0 8px;font-size:1.75rem;max-width:720px}.hero p{margin:0;color:var(--w-mute);max-width:760px}.truth{align-self:center;display:grid;gap:4px;min-width:250px;padding:13px 15px;border:1px solid var(--w-line-strong);border-radius:12px;background:var(--w-bg2)}.truth span,.card header p,.note,.caveat,.choice-row span,.two-choice span,.principles span{color:var(--w-mute)}.card{padding:20px;display:grid;gap:16px}.card header>div{display:flex;gap:12px;align-items:flex-start}.card h3{margin:0 0 4px;font-size:1.08rem}.card header p{margin:0}.step{display:grid;place-items:center;flex:0 0 29px;height:29px;border:1px solid var(--w-line-strong);border-radius:50%;font-weight:700}.retention-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.retention-grid button,.two-choice button{display:grid;gap:5px;text-align:left;min-height:84px;padding:13px;border:1px solid var(--w-line-strong);border-radius:12px;background:var(--w-bg2);color:var(--w-text);font:inherit;cursor:pointer}.retention-grid button.selected,.two-choice button.selected{border-color:var(--w-accent);box-shadow:inset 0 0 0 1px var(--w-accent);background:var(--w-raise)}.retention-grid span,.two-choice span{font-size:.84rem;line-height:1.35}.note,.caveat{margin:0;font-size:.84rem}.choice-row{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:14px;border:1px solid var(--w-line-strong);border-radius:12px;background:var(--w-bg2)}.choice-row>div{display:grid;gap:4px}.switch{position:relative;flex:0 0 48px;height:27px}.switch input{position:absolute;opacity:0}.switch span{position:absolute;inset:0;border-radius:999px;background:var(--w-raise);border:1px solid var(--w-line-strong);cursor:pointer}.switch span::after{content:'';position:absolute;width:19px;height:19px;left:3px;top:3px;border-radius:50%;background:var(--w-mute);transition:transform .16s ease}.switch input:checked+span{background:var(--w-accent)}.switch input:checked+span::after{transform:translateX(21px);background:white}.warning,.good{display:grid;gap:3px;padding:12px 14px;border-radius:11px;border:1px solid var(--w-line-strong)}.warning{border-color:var(--warning, #b9862d)}.good{background:var(--w-bg2)}.warning span,.good span{color:var(--w-mute);font-size:.86rem}.policy-line{display:flex;justify-content:space-between;gap:20px;padding:13px 14px;border-radius:11px;background:var(--w-bg2);border:1px solid var(--w-line-strong)}.two-choice{display:grid;grid-template-columns:1fr 1fr;gap:10px}.muted-card{background:color-mix(in srgb,var(--w-raise) 94%,transparent)}.principles{display:grid;grid-template-columns:repeat(3,1fr);gap:0;overflow:hidden}.principles>div{display:grid;gap:5px;padding:16px}.principles>div+div{border-left:1px solid var(--w-line-strong)}.principles span{font-size:.84rem}footer{display:flex;justify-content:flex-end;align-items:center;gap:14px}footer span{color:var(--w-mute);font-size:.85rem}.save{font:inherit;font-weight:650;cursor:pointer;color:var(--w-text);background:var(--w-bg2);border:1px solid var(--w-line-strong);border-radius:10px;padding:10px 14px}.save:disabled{opacity:.5;cursor:default}.error,.saved{padding:11px 13px;border:1px solid var(--w-line-strong);border-radius:10px}.error{border-color:var(--w-danger)}@media(max-width:800px){.hero{display:grid}.truth{min-width:0}.retention-grid{grid-template-columns:1fr 1fr}.principles{grid-template-columns:1fr}.principles>div+div{border-left:0;border-top:1px solid var(--w-line-strong)}}@media(max-width:560px){.retention-grid,.two-choice{grid-template-columns:1fr}.choice-row{align-items:flex-start}.hero,.card{padding:16px}}
</style>
