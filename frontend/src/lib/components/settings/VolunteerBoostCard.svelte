<script lang="ts">
    /**
     * "Boost this server" (EXPERIMENTAL, §9.1): a member may volunteer spare upload bandwidth
     * while the app is open. Opt-in only, with the consent facts said before the switch to start;
     * stopping clears the cache. Shown under Settings › Privacy & security, as this device's choice.
     */
    import { onMount } from 'svelte';
    import { activeServerUrl } from '$lib/serverUrl';
    import { getAuthToken } from '$lib/authSession';
    import { infrastructureRequest } from '$lib/api/infrastructure';
    import { boosterState, canBoost, startBoosting, stopBoosting, setPeerDownloads } from '$lib/volunteerBoosters';
    import Icon from '../ui/Icon.svelte';
    import Switch from '../ui/Switch.svelte';
    import { brandName } from '$lib/branding';
    let enabled = $state(false); let checked = $state(false); let busy = $state(false); let error = $state('');
    let name = $state('My device'); let uploadKiBPerSecond = $state(512); let cacheMiB = $state(32); let sessionMiB = $state(128);
    let consent = $state(false); let scope = ''; let sequence = 0;
    let limitsOpen = $state(false); let testOpen = $state(false);
    const supported = $derived(canBoost());
    async function refresh() {
        const server = $activeServerUrl; const n = ++sequence; checked = false;
        try { const data = await infrastructureRequest<{ enabled: boolean }>(getAuthToken(server), '/api/boosters/status'); if (n === sequence && server === $activeServerUrl) { enabled = data.enabled; checked = true; error = ''; } }
        catch (e) { if (n === sequence) { console.warn('[Boost] status check failed:', e); error = "Couldn't check whether this server accepts volunteers."; enabled = false; } }
    }
    $effect(() => { if (scope !== $activeServerUrl) { scope = $activeServerUrl; consent = false; void refresh(); } });
    onMount(() => { void refresh(); return () => { sequence++; }; });
    async function start() {
        if (!consent) { error = 'Choose whether to volunteer before starting.'; return; }
        busy = true; error = '';
        try { await startBoosting({ name, uploadKiBPerSecond, cacheMiB, sessionMiB }); }
        catch (e) { console.warn('[Boost] start failed:', e); error = "Boosting didn't start."; }
        finally { busy = false; }
    }
    function mib(n: number) { return `${(n / 1048576).toFixed(2)} MiB`; }
    const why = $derived(
        !supported ? 'This device needs a secure connection and WebRTC to volunteer.'
        : checked && !enabled ? "This server's owner hasn't turned on volunteer boosting."
        : ''
    );
    // Why the controls are off right now, in words (the boxes and switch also look disabled).
    const statusWordUnknown = "Not available until this server's status is known.";
    const statusWord = $derived(
        why || (checked ? '' : error ? statusWordUnknown : 'Checking whether this server takes volunteers…')
    );
    const receiveLocked = $derived(!$boosterState.receiving && (!enabled || !supported));
</script>

<section class="settings-block boost" aria-labelledby="boost-title">
    <div class="boost__head">
        <h3 class="settings-block__title" id="boost-title">Boost this server</h3>
        <span class="w-tag w-tag--mat" title="Experimental: not a production guarantee">Experimental</span>
    </div>
    <p class="settings-block__hint">Lend spare upload bandwidth while {brandName} is open, so other members can fetch shared files from you. Membership never depends on it, and downloads always work from the server.</p>

    {#if error}
        <div class="w-notice boost__notice" role="alert">
            <Icon name="alert" />
            <p class="w-notice__title">{error}</p>
            <p class="w-notice__text">Nothing is shared from this device.</p>
            <button type="button" class="w-btn w-btn--sm" onclick={refresh}>Check again</button>
        </div>
    {/if}

    <dl class="boost__facts" aria-label="What volunteering shares">
        <dt>Shares</dt><dd>Channel attachments you download yourself, up to 8 MiB each. Files from private rooms are never shared.</dd>
        <dt>Keeps</dt><dd>Copies for five minutes, in memory. Stopping clears them.</dd>
        <dt>Reveals</dt><dd>Your network address to the member who downloads from you. It may use metered data.</dd>
    </dl>

    {#if !$boosterState.active}
        <label class="w-choice boost__consent" class:is-disabled={!enabled || !supported}>
            <input type="checkbox" class="w-check" bind:checked={consent} disabled={!enabled || !supported} />
            <span>I volunteer this device’s spare upload bandwidth, and I understand the member who downloads can see my network address.</span>
        </label>
    {/if}
    <div class="w-srows">
        <div class="w-srow">
            <div class="w-srow__text">
                <p class="w-srow__label">{$boosterState.active ? 'Boosting now' : 'Volunteer this device'}</p>
                <p class="w-srow__hint">
                    {#if $boosterState.active}
                        {$boosterState.cachedFiles} cached {$boosterState.cachedFiles === 1 ? 'file' : 'files'} · {mib($boosterState.cachedBytes)} · {mib($boosterState.sentBytes)} sent this session
                    {:else}
                        {statusWord || 'Starts a new upload budget each time.'}
                    {/if}
                </p>
            </div>
            <div class="w-srow__control">
                {#if $boosterState.active}
                    <button type="button" class="w-btn w-btn--sm" onclick={() => stopBoosting()}>Stop boosting and clear cache</button>
                {:else}
                    <button type="button" class="w-btn w-btn--sm" disabled={!enabled || !checked || !supported || !consent || busy} aria-busy={busy} onclick={start}>{busy ? 'Starting…' : 'Start boosting'}</button>
                {/if}
            </div>
        </div>
    </div>
    {#if $boosterState.notice}<p class="boost__note" role="status">{$boosterState.notice}</p>{/if}

    <button type="button" class="w-disclosure" aria-expanded={limitsOpen} aria-controls="boost-limits" onclick={() => (limitsOpen = !limitsOpen)}>
        <Icon name="chevRight" />Device and bandwidth limits
    </button>
    {#if limitsOpen}
        <div class="w-disclosure__body boost__limits" id="boost-limits">
            <label class="boost__field"><span class="w-label">Device name</span><input class="w-field" maxlength="60" bind:value={name} disabled={$boosterState.active || busy} /></label>
            <label class="boost__field"><span class="w-label">Upload limit (KiB/s)</span><input class="w-field" type="number" min="16" max="8192" step="16" bind:value={uploadKiBPerSecond} disabled={$boosterState.active || busy} /></label>
            <label class="boost__field"><span class="w-label">Memory cache (MiB)</span><input class="w-field" type="number" min="8" max="128" step="8" bind:value={cacheMiB} disabled={$boosterState.active || busy} /></label>
            <label class="boost__field"><span class="w-label">Upload budget for this session (MiB)</span><input class="w-field" type="number" min="8" max="4096" step="8" bind:value={sessionMiB} disabled={$boosterState.active || busy} /></label>
            <p class="boost__note">Limits count file data; connection overhead comes on top.</p>
        </div>
    {/if}

    <button type="button" class="w-disclosure" aria-expanded={testOpen} aria-controls="boost-test" onclick={() => (testOpen = !testOpen)}>
        <Icon name="chevRight" />Download from volunteers
    </button>
    {#if testOpen}
        <div class="w-disclosure__body boost__test" id="boost-test">
            <div class="w-srows boost__subrows">
                <div class="w-srow">
                    <div class="w-srow__text">
                        <p class="w-srow__label" id="boost-receive-label">Try volunteer downloads</p>
                        <p class="w-srow__hint" id="boost-receive-hint">
                            {#if receiveLocked}
                                <!-- The first row already gives the reason under the notice; say it once. -->
                                {statusWord === statusWordUnknown ? '' : statusWord}
                            {:else}
                                On this server, until you close the app.{#if $boosterState.receivedBytes > 0} {mib($boosterState.receivedBytes)} received so far.{/if}
                            {/if}
                        </p>
                    </div>
                    <div class="w-srow__control">
                        <Switch labelledby="boost-receive-label" describedby="boost-receive-hint" checked={$boosterState.receiving} disabled={receiveLocked} onchange={(on) => setPeerDownloads(on)} />
                    </div>
                </div>
            </div>
            <p class="boost__note">Optional, even when you volunteer. Downloading from a member shows them your network address. Every file is checked against the server’s copy; anything missing or wrong comes from the server instead.</p>
        </div>
    {/if}
</section>

<style>
    .boost__head { display: flex; align-items: center; gap: 10px; }
    .boost__head :global(.settings-block__title) { margin: 0; }
    .boost__notice { margin: 12px 0; }
    .boost__facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 14px 0 16px; }
    .boost__facts dt { color: var(--w-faint); font: var(--w-t-small); }
    .boost__facts dd { margin: 0; color: var(--w-text); font: var(--w-t-small); text-wrap: pretty; }
    .boost__consent { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 12px; color: var(--w-text); font: var(--w-t-small); cursor: pointer; }
    .boost__consent :global(.w-check) { flex: none; margin-top: 1px; }
    .boost__consent.is-disabled { color: var(--w-mute); cursor: not-allowed; }
    /* A box that can't be ticked yet reads as such: sunk, on a faint edge (the kit also dims it). */
    .boost__consent.is-disabled :global(.w-check) { border-color: var(--w-line); background: var(--w-sink); }
    .boost__note { margin: 10px 0 0; color: var(--w-mute); font: var(--w-t-small); }
    .boost__subrows { border-top: 0; }
    .boost__subrows > :global(.w-srow:last-child) { border-bottom: 0; }
    .boost__test { padding: 0 0 12px; }
    .boost > :global(.w-disclosure) { margin-top: 12px; border-bottom: var(--w-bw) solid var(--w-line); }
    .boost > :global(.w-disclosure + .w-disclosure) { margin-top: 0; }
    .boost__limits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; padding: 12px 0 16px; border-top: 0; }
    .boost__limits .boost__note { grid-column: 1 / -1; margin: 0; }
    .boost__field { display: grid; min-width: 0; }
    .boost__field :global(.w-field) { width: 100%; box-sizing: border-box; }
    @media (max-width: 600px) { .boost__limits, .boost__facts { grid-template-columns: 1fr; } .boost__facts dt { margin-top: 4px; } }
</style>
