<script lang="ts">
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { isCurrentTailcatProxy } from '$lib/tailcatConnection';
	import { readCommunityEntryPoints, publishCommunityEntryPoints } from '$lib/api/communityEntryPoints';
	import { validCommunityEntryUrl, type CommunityEntry, type SignedCommunityRoster } from '$lib/communityRoster';

	let { owner = false }: { owner?: boolean } = $props();
	let roster: SignedCommunityRoster | null = $state(null);
	let entries: CommunityEntry[] = $state([{ nodeId: 'site_a', role: 'authority', url: '' }]);
	let password = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	let request = 0;

	function resetDraft(next: SignedCommunityRoster | null): void {
		roster = next;
		entries = next ? next.body.entries.map((entry) => ({ ...entry })) :
			[{ nodeId: 'site_a', role: 'authority', url: '' }];
		password = '';
	}

	async function refresh(): Promise<void> {
		if (loading || saving) return;
		const server = $activeServerUrl;
		const current = ++request;
		loading = true;
		error = '';
		try {
			const next = await readCommunityEntryPoints(server);
			if (current !== request || server !== $activeServerUrl) return;
			resetDraft(next);
			notice = next ? 'Loaded the signed entry-point list.' : 'No entry points published yet.';
		} catch (cause) {
			if (current === request) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			if (current === request) loading = false;
		}
	}

	function edit(index: number, field: keyof CommunityEntry, value: string): void {
		entries = entries.map((entry, position) => position === index ? { ...entry, [field]: value } as CommunityEntry : entry);
		notice = '';
	}

	function addAnchor(): void {
		let number = entries.length + 1;
		while (entries.some((entry) => entry.nodeId === `site_${number}`)) number++;
		entries = [...entries, { nodeId: `site_${number}`, role: 'anchor', url: '' }];
		notice = '';
	}

	function preparedEntries(): CommunityEntry[] {
		if (entries.length < 1 || entries.length > 64) throw new Error('Enter 1 to 64 site addresses');
		const ids = new Set<string>();
		const urls = new Set<string>();
		const prepared = entries.map((entry) => {
			const nodeId = entry.nodeId.trim();
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(nodeId) || ids.has(nodeId)) {
				throw new Error('Use a unique site ID of up to 64 letters, digits, hyphens or underscores');
			}
			ids.add(nodeId);
			let parsed: URL;
			try { parsed = new URL(entry.url.trim()); }
			catch { throw new Error(`Enter a full HTTP(S) address for ${nodeId}`); }
			if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
				throw new Error(`Use an address with no path, credentials or query for ${nodeId}`);
			}
			const url = parsed.origin;
			if (!validCommunityEntryUrl(url) || urls.has(url)) {
				throw new Error(`Use a unique HTTPS address or private HTTP address for ${nodeId}`);
			}
			urls.add(url);
			return { nodeId, role: entry.role, url };
		});
		if (prepared.filter((entry) => entry.role === 'authority').length !== 1) {
			throw new Error('Choose exactly one current Authority');
		}
		return prepared;
	}

	async function publish(): Promise<void> {
		if (!owner || loading || saving) return;
		const server = $activeServerUrl;
		const current = ++request;
		saving = true;
		error = '';
		notice = '';
		try {
			const prepared = preparedEntries();
			const next = await publishCommunityEntryPoints(server, password, roster?.body.version ?? 0, prepared);
			if (current !== request || server !== $activeServerUrl) return;
			resetDraft(next);
			notice = `Published version ${next.body.version}. Members can learn these addresses from this Authority.`;
		} catch (cause) {
			if (current === request) error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			password = '';
			if (current === request) saving = false;
		}
	}

	onMount(() => {
		void refresh();
		return () => { request++; password = ''; };
	});
</script>

<section class="entry-points" aria-label="Community entry points">
	<header>
		<div>
			<h3>Community entry points</h3>
			<p>Publish the addresses members may use for this one community. Anchors still forward work to the current Authority.</p>
		</div>
		<button type="button" onclick={refresh} disabled={loading || saving}>{loading ? 'Loading…' : 'Reload'}</button>
	</header>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if roster}
		<dl class="identity">
			<div><dt>Community ID</dt><dd><code>{roster.body.communityId}</code></dd></div>
			<div><dt>Roster version</dt><dd>{roster.body.version}</dd></div>
			<div><dt>Signed list expires</dt><dd>{new Date(roster.body.expiresAt * 1000).toLocaleString()}</dd></div>
		</dl>
	{:else if !loading && !error}
		<p>No signed address list exists yet. Publish one before giving members alternate site addresses.</p>
	{/if}
	{#if owner}
		{#if isCurrentTailcatProxy()}
			<p class="hint">Your current address is a temporary Tailcat proxy. Enter stable addresses that another device can reach.</p>
		{/if}
		<div class="rows">
			{#each entries as entry, index (index)}
				<div class="entry-row">
					<label>Site ID<input value={entry.nodeId} maxlength="64" oninput={(event) => edit(index, 'nodeId', event.currentTarget.value)} /></label>
					<label>Role<select value={entry.role} onchange={(event) => edit(index, 'role', event.currentTarget.value)}><option value="authority">Authority</option><option value="anchor">Anchor</option></select></label>
					<label>Reachable address<input value={entry.url} type="url" placeholder="https://site.example or https://public-ip:3001" oninput={(event) => edit(index, 'url', event.currentTarget.value)} /></label>
					<button type="button" onclick={() => { entries = entries.filter((_, position) => position !== index); notice = ''; }} disabled={entries.length === 1}>Remove</button>
				</div>
			{/each}
		</div>
		<div class="actions">
			<button type="button" onclick={addAnchor} disabled={entries.length >= 64 || saving}>Add site</button>
			<label>Owner password<input type="password" autocomplete="current-password" bind:value={password} disabled={saving} /></label>
			<button type="button" class="publish" onclick={publish} disabled={loading || saving || !password}>{saving ? 'Publishing…' : 'Publish signed list'}</button>
		</div>
	{:else if roster}
		<ul class="read-only">
			{#each roster.body.entries as entry (entry.nodeId)}
				<li><strong>{entry.nodeId}</strong> · {entry.role} · <code>{entry.url}</code></li>
			{/each}
		</ul>
	{/if}
	<p class="hint">This list identifies approved access addresses. It does not elect a replacement Authority or make an Anchor writable after the Authority fails. Public IP addresses need HTTPS valid for that IP. Private HTTP addresses require members to sign in separately.</p>
</section>

<style>
	.entry-points{display:grid;gap:var(--space-3);padding:var(--space-5);border:1px solid var(--w-line-strong);border-radius:calc(14px * var(--w-rs, 1));background:var(--w-bg2)}
	header{display:flex;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}h3,p{margin:0}header p,.hint,dt{color:var(--w-mute)}
	.identity{display:grid;gap:var(--space-2);margin:0}.identity div{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:var(--space-2)}dd{margin:0;overflow-wrap:anywhere}
	.rows{display:grid;gap:var(--space-3)}.entry-row{display:grid;grid-template-columns:minmax(7rem,1fr) minmax(7rem,0.7fr) minmax(12rem,2fr) auto;gap:var(--space-2);align-items:end}
	label{display:grid;gap:var(--space-1);min-width:0;color:var(--w-mute)}input,select,button{font:inherit;border:1px solid var(--w-line-strong);border-radius:calc(10px * var(--w-rs, 1));padding:var(--space-2);background:var(--w-raise);color:var(--w-text)}input{width:100%;box-sizing:border-box}button{cursor:pointer;white-space:nowrap}button:disabled{opacity:.55;cursor:not-allowed}
	.actions{display:flex;align-items:end;gap:var(--space-2);flex-wrap:wrap}.actions label{min-width:12rem}.publish{background:var(--w-accent);color:var(--w-on-accent)}
	.error{color:var(--w-danger)}.notice{color:var(--w-text)}code{overflow-wrap:anywhere}.read-only{margin:0;padding-left:var(--space-5)}
	@media(max-width:720px){.entry-row{grid-template-columns:1fr 1fr}.entry-row label:nth-child(3){grid-column:1/-1}.identity div{grid-template-columns:1fr}}
</style>
