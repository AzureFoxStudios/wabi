<script lang="ts">
    import { onMount } from 'svelte';
    import { activeServerUrl } from '$lib/serverUrl';
    import { getAuthToken } from '$lib/authSession';
    import { infrastructureRequest } from '$lib/api/infrastructure';
    import { boosterState, canBoost, startBoosting, stopBoosting, setPeerDownloads } from '$lib/volunteerBoosters';
    let enabled = $state(false); let checked = $state(false); let busy = $state(false); let error = $state('');
    let name = $state('My device'); let uploadKiBPerSecond = $state(512); let cacheMiB = $state(32); let sessionMiB = $state(128);
    let consent = $state(false); let scope = ''; let sequence = 0;
    const supported = $derived(canBoost());
    async function refresh() {
        const server = $activeServerUrl; const n = ++sequence; checked = false;
        try { const data = await infrastructureRequest<{ enabled: boolean }>(getAuthToken(server), '/api/boosters/status'); if (n === sequence && server === $activeServerUrl) { enabled = data.enabled; checked = true; error = ''; } }
        catch (e) { if (n === sequence) { error = e instanceof Error ? e.message : String(e); enabled = false; } }
    }
    $effect(() => { if (scope !== $activeServerUrl) { scope = $activeServerUrl; consent = false; void refresh(); } });
    onMount(() => { void refresh(); return () => { sequence++; }; });
    async function start() { busy = true; error = ''; try { if (!consent) throw new Error('Choose whether to volunteer before starting.'); await startBoosting({ name, uploadKiBPerSecond, cacheMiB, sessionMiB }); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; } }
    function mib(n: number) { return `${(n / 1048576).toFixed(2)} MiB`; }
</script>
<section class="boost-card" aria-label="Boost this server">
    <header><h3>Boost this server</h3><span class="experimental">Experimental</span></header>
    <p>Volunteer spare upload bandwidth while Wabi is open. Membership never requires boosting, and downloads can always use the server.</p>
    {#if error}<p class="error" role="alert">{error} <button onclick={refresh}>Check again</button></p>{/if}
    {#if checked && !enabled}<p>The server owner has not enabled volunteer boosters.</p>{/if}
    {#if !supported}<p>This device needs a secure browser connection and WebRTC to boost.</p>{/if}
    <details class="limits-disclosure"><summary>Device and bandwidth limits</summary><div class="limits">
        <label>Device name<input maxlength="60" bind:value={name} disabled={$boosterState.active || busy} /></label>
        <label>Upload limit (KiB/s)<input type="number" min="16" max="8192" step="16" bind:value={uploadKiBPerSecond} disabled={$boosterState.active || busy} /></label>
        <label>Memory cache (MiB)<input type="number" min="8" max="128" step="8" bind:value={cacheMiB} disabled={$boosterState.active || busy} /></label>
        <label>Upload budget for this session (MiB)<input type="number" min="8" max="4096" step="8" bind:value={sessionMiB} disabled={$boosterState.active || busy} /></label>
    </div></details>
    <p>Shares eligible channel attachments you explicitly download, up to 8 MiB each. Copies expire after five minutes. Limits cover file data; connection overhead is additional. Private-room files are excluded. Stopping clears the cache; starting again begins a new upload budget.</p>
    {#if !$boosterState.active}<label class="consent volunteer-consent"><input type="checkbox" bind:checked={consent} /><span><strong>Volunteer this device’s bandwidth</strong><span>Direct transfers can reveal my network address to the other member and may use metered data.</span></span></label>{/if}
    <div class="actions">
        {#if $boosterState.active}<button onclick={() => stopBoosting()}>Stop boosting and clear cache</button>{:else}<button class="primary" disabled={!enabled || !checked || !supported || !consent || busy} onclick={start}>{busy ? 'Starting…' : 'Start boosting'}</button>{/if}
    </div>
    <p role="status">{$boosterState.notice}</p>
    <dl><div><dt>Cached files</dt><dd>{$boosterState.cachedFiles} · {mib($boosterState.cachedBytes)}</dd></div><div><dt>Payload sent this session</dt><dd>{mib($boosterState.sentBytes)}</dd></div></dl>
    <details class="download-test"><summary>Test volunteer downloads · {mib($boosterState.receivedBytes)} received</summary>
    <label class="consent"><input type="checkbox" checked={$boosterState.receiving} disabled={!$boosterState.receiving && (!enabled || !supported)} onchange={event => setPeerDownloads(event.currentTarget.checked)} /> Try volunteer downloads on this server during this app session.</label>
    <p>This is optional even when you volunteer. Direct peer downloads reveal your network address to the sender. Files are checked against the server’s hash; unavailable or invalid peer copies fall back to the server. Verified peer bytes received: {mib($boosterState.receivedBytes)}.</p>
    </details>
</section>
<style>
header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.experimental{font-size:.75rem;padding:.3rem .6rem;border:1px solid var(--border-default);border-radius:var(--radius-md);color:var(--text-secondary)}summary{cursor:pointer;padding:.6rem 0;font-weight:600}.volunteer-consent{padding:1rem;border:2px solid var(--accent-primary);border-radius:var(--radius-md);background:var(--surface-raised)}.volunteer-consent input{width:20px;height:20px;flex-shrink:0;accent-color:var(--accent-primary)}.volunteer-consent span{display:grid;gap:.35rem}.volunteer-consent span span{color:var(--text-secondary)}.download-test{border-top:1px solid var(--border-default);padding-top:.5rem}.primary{background:var(--accent-primary);color:var(--text-on-accent,#fff)}.boost-card{padding:var(--space-5);border:1px solid var(--border-default);border-radius:var(--radius-lg);background:var(--surface-base);display:grid;gap:var(--space-3)}h3,p,dl{margin:0}p,dt{color:var(--text-secondary)}.limits,dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}label{display:grid;gap:var(--space-2)}input:not([type=checkbox]){width:100%;min-width:0;padding:var(--space-2);background:var(--surface-sunken);color:var(--text-heading);border:1px solid var(--border-default);border-radius:var(--radius-md)}.consent{display:flex;align-items:start;gap:var(--space-2)}.consent input{margin-top:4px}button{padding:var(--space-2) var(--space-3);background:var(--surface-raised);color:var(--text-heading);border:1px solid var(--border-default);border-radius:var(--radius-md);cursor:pointer}button:disabled{opacity:.5;cursor:default}dd{margin:var(--space-2) 0;font-weight:600}.error{color:var(--color-danger)}@media(max-width:480px){.limits,dl{grid-template-columns:1fr}}
</style>
