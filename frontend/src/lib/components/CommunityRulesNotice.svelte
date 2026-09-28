<script lang="ts">
	let { autoOpen = true }: { autoOpen?: boolean } = $props();
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { socket, currentUser } from '$lib/socket';
	import { communityRulesAvailable, communityRulesOpen } from '$lib/communityRulesUi';
	import { renderReaderHtml } from './readerTabHelpers';

	type Rules = { text: string; revision: number; requireAckBeforePosting: boolean };
	let rules: Rules | null = $state(null);
	let acknowledgedRevision = $state(0);
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let lastScope = $state('');
	let rulesFontSize = $state(16);
	const renderedRules = $derived(rules?.text ? renderReaderHtml(rules.text, 'markdown') : '');

	async function refresh(server = $activeServerUrl): Promise<void> {
		const token = getAuthToken(server);
		if (!server || !token) { rules = null; communityRulesAvailable.set(false); return; }
		loading = true;
		try {
			const response = await fetch(`${server}/api/server-center/rules`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
			if (!response.ok) throw new Error(`Could not read server rules (${response.status}).`);
			const data = await response.json();
			if (server !== $activeServerUrl || token !== getAuthToken(server)) return;
			rules = data.rules;
			acknowledgedRevision = data.acknowledgedRevision ?? 0;
			communityRulesAvailable.set(Boolean(rules?.text?.trim()));
			if (autoOpen && rules?.text?.trim() && rules.revision > acknowledgedRevision) communityRulesOpen.set(true);
			error = '';
		} catch (cause) {
			if (server === $activeServerUrl) error = cause instanceof Error ? cause.message : 'Could not read server rules.';
		} finally { loading = false; }
	}

	async function acknowledge(): Promise<void> {
		if (!rules || saving) return;
		const server = $activeServerUrl;
		const token = getAuthToken(server);
		if (!token) { error = 'Sign in again to acknowledge the rules.'; return; }
		saving = true; error = '';
		try {
			const response = await fetch(`${server}/api/server-center/rules/ack`, {
				method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				credentials: 'include', body: JSON.stringify({ revision: rules.revision })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.error || 'Rules changed. Read the current version and try again.');
			}
			acknowledgedRevision = rules.revision;
			communityRulesOpen.set(false);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : 'Could not save acknowledgement.';
			await refresh(server);
			error = message;
		} finally { saving = false; }
	}

	$effect(() => {
		const server = $activeServerUrl;
		const scope = `${server}:${$currentUser?.dbUserId ?? $currentUser?.id ?? 'guest'}`;
		if (scope !== lastScope) { lastScope = scope; rules = null; communityRulesAvailable.set(false); void refresh(server); }
	});
	$effect(() => {
		if ($communityRulesOpen) void refresh($activeServerUrl);
	});
	$effect(() => {
		const connection = $socket;
		if (!connection) return;
		const changed = () => void refresh($activeServerUrl);
		connection.on('community-rules-updated', changed);
		return () => connection.off('community-rules-updated', changed);
	});
	onMount(() => {
		const visible = () => { if (!document.hidden) void refresh(); };
		document.addEventListener('visibilitychange', visible);
		return () => document.removeEventListener('visibilitychange', visible);
	});
</script>

{#if $communityRulesOpen && (rules?.text?.trim() || loading || error)}
	<div class="rules-backdrop">
		<section class="rules-reader" role="dialog" aria-modal="true" aria-labelledby="community-rules-title">
			<header><div><span>Welcome to this server</span><h2 id="community-rules-title">Community rules</h2></div><div class="rules-controls"><button type="button" aria-label="Smaller rules text" disabled={rulesFontSize <= 14} onclick={() => rulesFontSize = Math.max(14, rulesFontSize - 2)}>A−</button><button type="button" aria-label="Larger rules text" disabled={rulesFontSize >= 24} onclick={() => rulesFontSize = Math.min(24, rulesFontSize + 2)}>A+</button><button type="button" onclick={() => communityRulesOpen.set(false)} aria-label="Close rules">×</button></div></header>
			{#if loading && !rules}<p>Loading rules…</p>{/if}
			{#if rules?.text?.trim()}<article style:font-size={`${rulesFontSize}px`}>{@html renderedRules}</article>{/if}
			{#if error}<p class="rules-error" role="alert">{error}</p>{/if}
			<footer><p>{rules?.requireAckBeforePosting && rules.revision > acknowledgedRevision ? "You can look around. Read and acknowledge the rules before posting. " : ""}Check each room’s retention label. A deliberate report can preserve the message you choose to send to staff.</p>{#if rules?.text?.trim() && rules.revision > acknowledgedRevision}<button type="button" class="rules-primary" onclick={acknowledge} disabled={saving}>{saving ? 'Saving…' : 'I’ve read these rules'}</button>{:else}<button type="button" onclick={() => communityRulesOpen.set(false)}>Done</button>{/if}</footer>
		</section>
	</div>
{/if}

<style>
	.rules-backdrop{position:fixed;inset:0;z-index:10015;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.55);animation:rules-in .18s ease-out}.rules-reader{display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:14px;width:min(650px,100%);max-height:min(800px,calc(100dvh - 32px));padding:22px;border:1px solid var(--border-default);border-radius:18px;background:var(--surface-raised);box-shadow:0 25px 90px rgba(0,0,0,.35);color:var(--text-primary)}header{display:flex;justify-content:space-between;gap:20px;align-items:start}header span{font-size:.76rem;text-transform:uppercase;color:var(--text-secondary)}h2{margin:4px 0 0;font-size:1.45rem}button{border:1px solid var(--border-default);border-radius:9px;background:var(--surface-base);color:var(--text-primary);font:inherit;padding:8px 12px;cursor:pointer}.rules-controls{display:flex;gap:5px;align-items:center}.rules-controls button:last-child{font-size:1.4rem;line-height:1}article{overflow:auto;white-space:pre-wrap;line-height:1.6;padding:18px;border:1px solid var(--border-default);border-radius:12px;background:var(--surface-base)}article :global(h1),article :global(h2),article :global(h3){margin:1em 0 .4em;line-height:1.25}article :global(a){color:var(--accent-primary);text-decoration:underline}footer{display:flex;align-items:center;justify-content:space-between;gap:14px}footer p{margin:0;color:var(--text-secondary);font-size:.82rem;max-width:400px}.rules-primary{background:var(--accent-primary);color:white;border-color:transparent}.rules-error{color:var(--danger)}@keyframes rules-in{from{opacity:0}to{opacity:1}}@media(max-width:600px){.rules-reader{padding:16px}footer{display:grid;justify-items:start}}@media(prefers-reduced-motion:reduce){.rules-backdrop{animation:none}}
</style>
