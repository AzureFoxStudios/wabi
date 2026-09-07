<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { _ } from '$lib/i18n';
  import { isTauriRuntime } from '$lib/tauri-platform';
  import { getWabiDB } from '$lib/wabidb';
  import type { ScopeStatus } from '$lib/wabidb/types';

  let scopes = $state<ScopeStatus[]>([]);
  let queueCounts = $state({ pending: 0, failed: 0, synced: 0 });
  let ready = $state(false);
  let working = $state(false);
  let error = $state('');
  let notice = $state('');
  let mounted = false;
  const isTauri = isTauriRuntime();

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

  async function run(action?: () => Promise<void>) {
    if (working) return;
    working = true; error = ''; notice = '';
    try {
      await action?.();
      await refreshQueue();
    } catch (cause) {
      if (mounted) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (mounted) working = false; }
  }

  async function retry() {
    await run(async () => {
      const db = getWabiDB();
      if (!db) throw new Error(get(_)('storage.archiveBoundary.queueUnavailable'));
      await db.retryFailed();
      if (mounted) notice = get(_)('storage.archiveBoundary.retryMarked');
    });
  }

  async function toggleScope(scopeId: string, enable: boolean) {
    await run(async () => {
      const db = getWabiDB();
      if (!db) throw new Error(get(_)('storage.archiveBoundary.queueUnavailable'));
      if (enable) await db.enableScope(scopeId); else await db.disableScope(scopeId);
    });
  }

  onMount(() => {
    mounted = true;
    void run();
    return () => { mounted = false; };
  });
</script>

<div class="storage-settings">
  <section class="setting-group" aria-labelledby="archive-boundary-title">
    <div class="header">
      <h3 id="archive-boundary-title">{$_('storage.archiveBoundary.title')}</h3>
      <p class="subtitle">{$_('storage.archiveBoundary.explanation')}</p>
    </div>
    <p class="hint">{$_('storage.archiveBoundary.preserved')}</p>
    {#if isTauri}<p class="hint">{$_('storage.archiveBoundary.native')}</p>{/if}
  </section>

  <section class="offline-section" aria-labelledby="offline-queue-title" aria-busy={working}>
    <div class="header">
      <h3 id="offline-queue-title">{$_('storage.offline.wabiDB.queue_label')}</h3>
      <p class="subtitle">{$_('storage.archiveBoundary.queueExplanation')}</p>
    </div>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if !ready}
      <p class="hint">{$_('storage.archiveBoundary.queueUnavailable')}</p>
    {:else}
      {#if scopes.length > 0}
        <div class="setting-group">
          <span class="label">{$_('storage.offline.wabiDB.scope_label')}</span>
          {#each scopes as scope (scope.scopeId)}
            <div class="scope-item">
              <span class="scope-name">{scope.name}</span>
              {#if scope.userControl === 'always'}
                <span class="badge">{$_('storage.offline.scopes.always_on')}</span>
              {:else}
                <button class="btn-small" disabled={working}
                  onclick={() => toggleScope(scope.scopeId, !scope.enabled)}>
                  {scope.enabled ? $_('storage.offline.scopes.disable') : $_('storage.offline.scopes.enable')}
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      <p class="queue-counts">
        {$_('storage.offline.wabiDB.pending')}: {queueCounts.pending} |
        {$_('storage.offline.wabiDB.failed')}: {queueCounts.failed} |
        {$_('storage.offline.wabiDB.synced')}: {queueCounts.synced}
      </p>
    {/if}
    <div class="storage-queue-actions">
      <button class="btn-small" disabled={working} onclick={() => run()}>
        {$_('storage.archiveBoundary.refresh')}
      </button>
      <button class="btn-small" disabled={working || !ready} onclick={retry}>
        {$_('storage.offline.retry.button')}
      </button>
    </div>
  </section>
</div>

<style>
  .queue-counts { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .scope-item, .storage-queue-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
  .scope-item { justify-content: space-between; margin-block: var(--space-2); }
  .scope-name { overflow-wrap: anywhere; min-width: 0; }
  button { min-height: 44px; }
  [role='alert'] { color: var(--text-danger); }
</style>
