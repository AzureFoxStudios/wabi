<script lang="ts">
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
		reportEvidencePreservation: 'explicit_report'
	});
	let published: ServerPrivacyPolicy | null = $state(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let saved = $state('');

	const retention: Array<{ value: ServerDefaultRetention; label: string; detail: string }> = [
		{ value: 'live', label: 'Live', detail: 'Session-only. New channel messages are not durably written.' },
		{ value: '1h', label: '1 hour', detail: 'Very short-lived chat for transient coordination.' },
		{ value: '24h', label: '24 hours', detail: 'Wabi’s privacy-oriented baseline.' },
		{ value: '7d', label: '7 days', detail: 'Short history without permanent accumulation.' },
		{ value: '30d', label: '30 days', detail: 'Longer operational history.' },
		{ value: 'forever', label: 'Forever', detail: 'Explicitly opt new channels into durable history.' }
	];

	function token() { return getAuthToken($activeServerUrl); }
	async function request(init: RequestInit = {}) {
		const auth = token();
		if (!auth) throw new Error('Sign in again to manage privacy settings.');
		const response = await fetch(`${$activeServerUrl}/api/server-center/privacy`, {
			...init,
			credentials: 'include',
			headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `Privacy request failed (${response.status}).`);
		return data;
	}

	async function load() {
		loading = true; error = ''; saved = '';
		try {
			const data = await request();
			policy = data.policy;
			published = structuredClone(data.policy);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not load privacy settings.';
		} finally { loading = false; }
	}

	async function save() {
		if (saving) return;
		saving = true; error = ''; saved = '';
		try {
			const data = await request({ method: 'PUT', body: JSON.stringify(policy) });
			policy = data.policy;
			published = structuredClone(data.policy);
			saved = 'Privacy policy saved. Existing channels were not rewritten.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save privacy settings.';
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
			<span class="eyebrow">Privacy &amp; retention</span>
			<h2>Choose how much Wabi remembers — and how much it watches.</h2>
			<p>Retention, confidentiality and moderation are separate choices. Making chat ephemeral does not pretend the server could not see it while it was live.</p>
		</div>
		<div class="truth"><strong>Current private-chat boundary</strong><span>Server-readable today · E2EE not yet shipped</span></div>
	</section>

	{#if error}<div class="error" role="alert">{error}</div>{/if}
	{#if saved}<div class="saved" role="status">{saved}</div>{/if}

	{#if loading}
		<section class="card"><p>Loading privacy policy…</p></section>
	{:else}
		<section class="card">
			<header><div><span class="step">1</span><div><h3>Default retention for new channels</h3><p>This changes what newly created community channels inherit. Existing channels keep their current retention until someone deliberately changes them.</p></div></div></header>
			<div class="retention-grid">
				{#each retention as option}
					<button class:selected={policy.defaultRetention === option.value} onclick={() => setRetention(option.value)}>
						<strong>{option.label}</strong><span>{option.detail}</span>
					</button>
				{/each}
			</div>
			<p class="note"><strong>Per-channel choice stays sovereign.</strong> A channel can still be Live, timed, or Forever regardless of this default.</p>
		</section>

		<section class="card">
			<header><div><span class="step">2</span><div><h3>Private conversation moderation</h3><p>DMs and private groups are server-readable today, but that does not mean Wabi should inspect them automatically.</p></div></div></header>
			<div class="choice-row">
				<div><strong>Reports only</strong><span>Default. Safety rules do not inspect DM/group message text. Participants can still deliberately report a message.</span></div>
				<label class="switch"><input type="checkbox" bind:checked={policy.privateContentAutomation} onchange={() => saved = ''}/><span></span></label>
			</div>
			{#if policy.privateContentAutomation}
				<div class="warning"><strong>Private-content automation enabled.</strong><span>Literal server safety rules may inspect server-readable DM/group text before delivery. This setting can never override future E2EE.</span></div>
			{:else}
				<div class="good"><strong>Private spaces are reports-only.</strong><span>Server-side content rules apply to community spaces, not private conversations.</span></div>
			{/if}
		</section>

		<section class="card">
			<header><div><span class="step">3</span><div><h3>Reporting &amp; evidence</h3><p>Ephemeral does not become secretly permanent “just in case.” Evidence is preserved when a participant explicitly submits a report.</p></div></div></header>
			<div class="policy-line"><strong>Evidence preservation</strong><span>Explicit report only</span></div>
			<p class="note">The report dialog tells the reporter that the message snapshot is being preserved for this server’s staff. Wabi does not send it to a central moderation service.</p>
		</section>

		<section class="card muted-card">
			<header><div><span class="step">4</span><div><h3>Local analytics</h3><p>No central Wabi advertising or behavioral profile is created by either choice.</p></div></div></header>
			<div class="two-choice">
				<button class:selected={policy.analyticsMode === 'off'} onclick={() => setAnalytics('off')}><strong>Off</strong><span>Prefer the minimum operational counters necessary to run the server.</span></button>
				<button class:selected={policy.analyticsMode === 'local_aggregate'} onclick={() => setAnalytics('local_aggregate')}><strong>Local aggregate</strong><span>Permit aggregate Server Center statistics on this instance only.</span></button>
			</div>
			<p class="caveat">Policy boundary today: Wabi does not have a central analytics upload here. This setting governs the direction of future Server Center analytics; it is not a claim that every existing operational counter disappears when Off.</p>
		</section>

		<section class="card muted-card">
			<header><div><span class="step">5</span><div><h3>External content processing</h3><p>Keep external services visible instead of silently treating them as part of Wabi.</p></div></div></header>
			<div class="two-choice">
				<button class:selected={policy.externalProcessing === 'none'} onclick={() => setExternal('none')}><strong>None by policy</strong><span>Wabi core should not send message content to outside processors.</span></button>
				<button class:selected={policy.externalProcessing === 'declared_integrations'} onclick={() => setExternal('declared_integrations')}><strong>Declared integrations</strong><span>Allow explicitly installed integrations to disclose their own data access.</span></button>
			</div>
			<p class="caveat">This is a server policy marker today, not a proven sandbox for arbitrary backend plugins. Add-on capability enforcement remains a separate security boundary.</p>
		</section>

		<section class="principles">
			<div><strong>What this never means</strong><span>Live/ephemeral = “not retained,” not “invisible to the running server.”</span></div>
			<div><strong>Future E2EE</strong><span>Operator-blind content will be outside server-side classifiers. Reporting can disclose selected evidence from the participant’s client.</span></div>
			<div><strong>No silent downgrade</strong><span>Future encrypted conversations must never become server-readable merely because an admin toggled a moderation option.</span></div>
		</section>

		<footer>
			<span>{dirty ? 'Unsaved privacy changes' : 'Policy matches the server'}</span>
			<button class="save" onclick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save privacy policy'}</button>
		</footer>
	{/if}
</div>

<style>
	.privacy-center{display:grid;gap:16px;max-width:1100px}.hero,.card,.principles{border:1px solid var(--border-default);border-radius:18px;background:var(--surface-raised)}.hero{display:flex;justify-content:space-between;gap:24px;padding:25px;background:linear-gradient(135deg,var(--surface-raised),var(--surface-base))}.eyebrow{text-transform:uppercase;letter-spacing:.11em;font-size:.72rem;color:var(--text-muted)}.hero h2{margin:5px 0 8px;font-size:1.75rem;max-width:720px}.hero p{margin:0;color:var(--text-secondary);max-width:760px}.truth{align-self:center;display:grid;gap:4px;min-width:250px;padding:13px 15px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-base)}.truth span,.card header p,.note,.caveat,.choice-row span,.two-choice span,.principles span{color:var(--text-secondary)}.card{padding:20px;display:grid;gap:16px}.card header>div{display:flex;gap:12px;align-items:flex-start}.card h3{margin:0 0 4px;font-size:1.08rem}.card header p{margin:0}.step{display:grid;place-items:center;flex:0 0 29px;height:29px;border:1px solid var(--border-default);border-radius:50%;font-weight:700}.retention-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.retention-grid button,.two-choice button{display:grid;gap:5px;text-align:left;min-height:84px;padding:13px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-base);color:var(--text-primary);font:inherit;cursor:pointer}.retention-grid button.selected,.two-choice button.selected{border-color:var(--accent-primary);box-shadow:inset 0 0 0 1px var(--accent-primary);background:var(--surface-hover)}.retention-grid span,.two-choice span{font-size:.84rem;line-height:1.35}.note,.caveat{margin:0;font-size:.84rem}.choice-row{display:flex;justify-content:space-between;gap:20px;align-items:center;padding:14px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-base)}.choice-row>div{display:grid;gap:4px}.switch{position:relative;flex:0 0 48px;height:27px}.switch input{position:absolute;opacity:0}.switch span{position:absolute;inset:0;border-radius:999px;background:var(--surface-hover);border:1px solid var(--border-default);cursor:pointer}.switch span::after{content:'';position:absolute;width:19px;height:19px;left:3px;top:3px;border-radius:50%;background:var(--text-secondary);transition:transform .16s ease}.switch input:checked+span{background:var(--accent-primary)}.switch input:checked+span::after{transform:translateX(21px);background:white}.warning,.good{display:grid;gap:3px;padding:12px 14px;border-radius:11px;border:1px solid var(--border-default)}.warning{border-color:var(--warning, #b9862d)}.good{background:var(--surface-base)}.warning span,.good span{color:var(--text-secondary);font-size:.86rem}.policy-line{display:flex;justify-content:space-between;gap:20px;padding:13px 14px;border-radius:11px;background:var(--surface-base);border:1px solid var(--border-default)}.two-choice{display:grid;grid-template-columns:1fr 1fr;gap:10px}.muted-card{background:color-mix(in srgb,var(--surface-raised) 94%,transparent)}.principles{display:grid;grid-template-columns:repeat(3,1fr);gap:0;overflow:hidden}.principles>div{display:grid;gap:5px;padding:16px}.principles>div+div{border-left:1px solid var(--border-default)}.principles span{font-size:.84rem}footer{display:flex;justify-content:flex-end;align-items:center;gap:14px}footer span{color:var(--text-secondary);font-size:.85rem}.save{font:inherit;font-weight:650;cursor:pointer;color:var(--text-primary);background:var(--surface-base);border:1px solid var(--border-default);border-radius:10px;padding:10px 14px}.save:disabled{opacity:.5;cursor:default}.error,.saved{padding:11px 13px;border:1px solid var(--border-default);border-radius:10px}.error{border-color:var(--danger)}@media(max-width:800px){.hero{display:grid}.truth{min-width:0}.retention-grid{grid-template-columns:1fr 1fr}.principles{grid-template-columns:1fr}.principles>div+div{border-left:0;border-top:1px solid var(--border-default)}}@media(max-width:560px){.retention-grid,.two-choice{grid-template-columns:1fr}.choice-row{align-items:flex-start}.hero,.card{padding:16px}}
</style>
