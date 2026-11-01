<script lang="ts">
  /**
   * Settings › Storage (§8.9, §9.4): what this device keeps for this community, and the one
   * choice a member has here: whether chat messages may wait for a connection. Required app
   * actions are stated as a fact, not dressed as a control, and queue counts are words.
   */
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { _ } from '$lib/i18n';
  import { brandName } from '$lib/branding';
  import { isTauriRuntime } from '$lib/tauri-platform';
  import { getWabiDB } from '$lib/wabidb';
  import type { ScopeStatus } from '$lib/wabidb/types';
  import Icon from './ui/Icon.svelte';

  let scopes = $state<ScopeStatus[]>([]);
  let queueCounts = $state({ pending: 0, failed: 0, synced: 0 });
  let ready = $state(false);
  let working = $state(false);
  let error = $state('');
  let notice = $state('');
  let olderOpen = $state(false);
  let mounted = false;
  const isTauri = isTauriRuntime();
  // Said once, under "Waiting on this device"; the rows above describe what they do.
  const NOT_READY = `Not ready yet. Check again once ${brandName} has connected.`;

  /** The member-facing scopes: chat sends can be switched; required app actions are a fact. */
  const chatScope = $derived(scopes.find((scope) => scope.scopeId === 'corechat') ?? null);
  const otherScopes = $derived(scopes.filter((scope) => scope.scopeId !== 'corechat' && scope.scopeId !== 'system' && scope.userControl !== 'always'));
  const queueWords = $derived(
    queueCounts.failed
      ? `${queueCounts.failed} ${queueCounts.failed === 1 ? 'action' : 'actions'} didn't reach the server.`
      : queueCounts.pending
        ? `${queueCounts.pending} ${queueCounts.pending === 1 ? 'action is' : 'actions are'} waiting for a connection.`
        : 'Nothing is waiting. Everything has reached the server.'
  );

  async function refreshQueue() {
    const db = getWabiDB();
    if (!db) { ready = false; return; }
    const queue = await db.listQueue();
    if (!mounted) return;
    scopes = db.listScopes();
    queueCounts = {
      pending: queue.filter(action => action.status === 'pending').length,
      failed: queue.filter(action => action.status === 'failed').length,
      synced: queue.filter(action => action.status === 'synced').length,
    };
    ready = true;
  }

  /** Runs one action; a failure is said in `failure`'s words (the raw cause is only logged). */
  async function run(action?: () => Promise<void>, failure = NOT_READY) {
    if (working) return;
    working = true; error = ''; notice = '';
    try {
      await action?.();
      await refreshQueue();
    } catch (cause) {
      console.warn('[Storage] action failed:', cause);
      if (mounted) error = getWabiDB() ? failure : NOT_READY;
    } finally { if (mounted) working = false; }
  }

  async function retry() {
    await run(async () => {
      const db = getWabiDB();
      if (!db) throw new Error(get(_)('storage.archiveBoundary.queueUnavailable'));
      await db.retryFailed();
      if (mounted) notice = get(_)('storage.archiveBoundary.retryMarked');
    }, "The retry didn't start.");
  }

  async function toggleScope(scopeId: string, enable: boolean) {
    await run(async () => {
      const db = getWabiDB();
      if (!db) throw new Error(get(_)('storage.archiveBoundary.queueUnavailable'));
      if (enable) await db.enableScope(scopeId); else await db.disableScope(scopeId);
    }, "That change didn't save.");
  }

  function scopeLabel(scope: ScopeStatus): string {
    return scope.name || scope.scopeId;
  }

  onMount(() => {
    mounted = true;
    void run();
    return () => { mounted = false; };
  });
</script>

<div class="storage-settings">
  <section class="settings-block" aria-labelledby="storage-history-title">
    <h3 class="settings-block__title" id="storage-history-title">Chat history</h3>
    <p class="settings-block__hint">{$_('storage.archiveBoundary.explanation')}</p>
    {#if isTauri}<p class="storage-settings__note">{$_('storage.archiveBoundary.native')}</p>{/if}
    <button type="button" class="w-disclosure storage-settings__disclosure" aria-expanded={olderOpen} aria-controls="storage-older" onclick={() => (olderOpen = !olderOpen)}>
      <Icon name="chevRight" />Older saved files
    </button>
    {#if olderOpen}
      <div class="w-disclosure__body" id="storage-older">
        <p class="storage-settings__note">{$_('storage.archiveBoundary.preserved')}</p>
      </div>
    {/if}
  </section>

  <section class="settings-block" aria-labelledby="storage-offline-title" aria-busy={working}>
    <h3 class="settings-block__title" id="storage-offline-title">While you're offline</h3>
    <p class="settings-block__hint">{$_('storage.archiveBoundary.queueExplanation')}</p>

    {#if error}
      <div class="w-notice storage-settings__notice" role="alert">
        <Icon name="alert" />
        <p class="w-notice__title">{error}</p>
        <p class="w-notice__text">Nothing waiting on this device was lost.</p>
      </div>
    {/if}

    <div class="w-srows">
      <div class="w-srow">
        <div class="w-srow__text">
          <p class="w-srow__label" id="storage-chat-label">Send chat messages later</p>
          <p class="w-srow__hint">
            {#if ready && !chatScope}
              This server doesn't support waiting messages.
            {:else}
              Messages you send without a connection wait on this device and go out when {brandName} reconnects.
            {/if}
          </p>
        </div>
        <div class="w-srow__control">
          <button
            type="button"
            class="w-switch"
            role="switch"
            aria-labelledby="storage-chat-label"
            aria-checked={Boolean(chatScope?.enabled)}
            disabled={working || !ready || !chatScope || chatScope.userControl === 'always'}
            onclick={() => chatScope && toggleScope(chatScope.scopeId, !chatScope.enabled)}
          ></button>
        </div>
      </div>

      {#each otherScopes as scope (scope.scopeId)}
        <div class="w-srow">
          <div class="w-srow__text">
            <p class="w-srow__label" id={`storage-scope-${scope.scopeId}`}>{scopeLabel(scope)}</p>
            <p class="w-srow__hint">Waits on this device until {brandName} reconnects.</p>
          </div>
          <div class="w-srow__control">
            <button type="button" class="w-switch" role="switch" aria-labelledby={`storage-scope-${scope.scopeId}`} aria-checked={scope.enabled} disabled={working} onclick={() => toggleScope(scope.scopeId, !scope.enabled)}></button>
          </div>
        </div>
      {/each}

      <div class="w-srow">
        <div class="w-srow__text">
          <p class="w-srow__label">Waiting on this device</p>
          <p class="w-srow__hint" role="status">{ready ? queueWords : NOT_READY}{#if notice} {notice}{/if}</p>
        </div>
        <div class="w-srow__control">
          <button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={working} aria-busy={working} onclick={() => run()}>
            Check again
          </button>
          <button type="button" class="w-btn w-btn--sm" disabled={working || !ready || queueCounts.failed === 0} onclick={retry}>
            {$_('storage.offline.retry.button')}
          </button>
        </div>
      </div>
    </div>
    <p class="storage-settings__note">Some app actions always wait for a connection; they can't be turned off.</p>
  </section>
</div>
