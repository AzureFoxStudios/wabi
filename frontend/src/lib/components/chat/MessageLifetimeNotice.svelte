<script lang="ts">
    import type { Component } from 'svelte';
    import { channels, currentUser, type Channel } from '$lib/socket';
    import { activeServerUrl } from '$lib/serverUrl';
    import { authSessionGeneration, getAuthToken, getStoredDbUserId } from '$lib/authSession';
    import { accountPreferenceKey } from '$lib/openingSurfacePreference';
    import { currentRetentionFromPrivacy } from '$lib/retentionDisplay';
    import { updateChannelSettings } from '$lib/channelStore';
    import { connected, getSocket } from '$lib/socketConnection';
    import { MESSAGE_RETENTION_LABELS, type MessageRetentionDuration } from '../../../../../shared/messageRetention.js';

    let { channelId }: { channelId: string } = $props();
    let retention = $state<string | null>(null), error = $state(''), firstUse = $state(false);
    let loading = $state(false), showSettings = $state(false);
    let SettingsComponent = $state<Component<any> | null>(null);
    let abort: AbortController | null = null;
    let requestGeneration = 0;
    let admittedCurrent = () => false;
    let preferenceKey = '';
    const channel = $derived($channels.find(item => item.id === channelId));
    const canChoose = $derived(!!channel && (['dm', 'group'].includes(channel.type || '') || ['owner', 'admin'].includes($currentUser?.highestRole || '')));
    const label = $derived(retention === 'forever' ? 'Keep forever' : retention === 'live' ? 'Live session' : retention ? MESSAGE_RETENTION_LABELS[retention as MessageRetentionDuration] || retention : 'Checking…');
    const settingsChannel = $derived(channel && retention !== null ? {
        ...channel, autoDeleteAfter: retention === 'forever' ? null : retention
    } as Channel : null);

    async function refresh(server: string, id: string): Promise<void> {
        abort?.abort(); abort = new AbortController();
        const signal = abort.signal, generation = ++requestGeneration;
        const token = getAuthToken(server), account = getStoredDbUserId(server);
        const sessionGeneration = authSessionGeneration(server);
        const current = () => !signal.aborted && generation === requestGeneration && server === $activeServerUrl && id === channelId && getAuthToken(server) === token && authSessionGeneration(server) === sessionGeneration;
        admittedCurrent = current;
        retention = null; error = ''; loading = true; firstUse = false; showSettings = false;
        if (!token || account === null) { loading = false; return; }
        try {
            const response = await fetch(`${server}/api/privacy/channels/${encodeURIComponent(id)}`, {
                headers: { Authorization: `Bearer ${token}` }, credentials: 'include', signal
            });
            if (!response.ok) throw new Error('Could not check the current message lifetime.');
            const value = currentRetentionFromPrivacy(await response.json(), id);
            if (!current()) return;
            if (value === null) throw new Error('The server returned an invalid message lifetime.');
            retention = value;
            preferenceKey = accountPreferenceKey('message-lifetime-reviewed', server, account);
            try { firstUse = localStorage.getItem(preferenceKey) !== '1'; }
            catch { firstUse = true; }
        } catch (failure) {
            if (current()) error = failure instanceof Error ? failure.message : 'Could not check the current message lifetime.';
        } finally { if (current()) loading = false; }
    }
    function acknowledge() {
        if (!admittedCurrent() || retention === null) return;
        try { localStorage.setItem(preferenceKey, '1'); } catch { /* UI acknowledgement only. */ }
        firstUse = false;
    }
    async function choose() {
        if (!canChoose || !admittedCurrent() || !settingsChannel) return;
        const current = admittedCurrent;
        const module = await import('../sidebar/ChannelSettingsModal.svelte');
        if (!current()) return;
        SettingsComponent = module.default; showSettings = true;
    }
    async function save(event: CustomEvent<{ channelId: string; updates: Parameters<typeof updateChannelSettings>[1] }>) {
        if (!admittedCurrent() || event.detail.channelId !== channelId) return;
        const server = $activeServerUrl, id = channelId;
        await updateChannelSettings(id, event.detail.updates);
        if (!admittedCurrent()) return;
        showSettings = false;
        await refresh(server, id);
        // The server remains the source of truth; a failed save cannot invent a new label.
    }
    $effect(() => {
        const server = $activeServerUrl, id = channelId, account = $currentUser?.dbUserId;
        account;
        void refresh(server, id);
        return () => { abort?.abort(); requestGeneration++; };
    });
    $effect(() => {
        if (!$connected) return;
        const socket = getSocket(); if (!socket) return;
        const changed = (payload: { channelId?: string; autoDeleteAfter?: unknown }) => {
            if (payload?.channelId === channelId && Object.hasOwn(payload, 'autoDeleteAfter')) void refresh($activeServerUrl, channelId);
        };
        socket.on('channel-updated', changed);
        return () => socket.off('channel-updated', changed);
    });
</script>

<div class="message-lifetime-notice" aria-live="polite">
    {#if retention !== null}
        <span title="New messages use this lifetime. Earlier messages keep the policy set when they were sent.">New messages: {label}</span>
        {#if canChoose}<button type="button" onclick={() => void choose()}>Choose message lifetime</button>{/if}
        {#if firstUse}
            <div class="first-use">
                <strong>Review your message lifetime</strong>
                <p>This room’s current default is {label}. Earlier messages keep their original lifetime. Retention does not make messages private from the server operator.</p>
                {#if !canChoose}<p>An administrator chooses the lifetime for this community room.</p>{/if}
                <button type="button" onclick={acknowledge}>Use current default</button>
            </div>
        {/if}
    {:else if loading}<span>Checking message lifetime…</span>
    {:else if error}<span>{error}</span><button type="button" onclick={() => void refresh($activeServerUrl, channelId)}>Retry</button>{/if}
</div>
{#if showSettings && SettingsComponent && settingsChannel}
    <SettingsComponent channel={settingsChannel} on:save={save} on:close={() => showSettings = false}/>
{/if}
<style>
    .message-lifetime-notice{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2,.5rem);font-size:var(--font-size-sm,.8rem);color:var(--text-secondary);padding:.35rem .5rem}
    button{color:var(--accent-primary);background:transparent;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);padding:.3rem .5rem;cursor:pointer}
    .first-use{flex-basis:100%;background:var(--surface-raised);border-radius:var(--radius-sm);padding:var(--space-3,.75rem)}
    p{margin:.35rem 0;max-width:65ch}
</style>
