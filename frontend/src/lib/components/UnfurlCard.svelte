<script lang="ts">
  import { objectRefStore } from '$lib/objectRefRegistry';
  import { navigateToRef } from '$lib/navigateToRef';
  import type { MessageEntity } from '$lib/socket';
  import type { ObjectRefRecord } from '$lib/objectRefRegistry';
  import type { NavRef } from '$lib/navigateToRef';

  export let entity: MessageEntity;

  $: record = findRecordInStore(entity.kind, entity.targetId, $objectRefStore);

  function findRecordInStore(
    kind: string,
    id: string,
    map: Map<string, ObjectRefRecord>
  ): ObjectRefRecord | undefined {
    for (const r of map.values()) {
      if (r.kind === kind && r.id === id) return r;
    }
    return undefined;
  }

  $: displayTitle = entity.previewTitle || record?.title || entity.label;
  $: displaySubtitle = entity.previewSubtitle || record?.subtitle || record?.channelId || '';
  $: displayStatus = entity.previewStatus || record?.status;
  $: thumbUrl = entity.previewThumbUrl || record?.thumbUrl;
  $: hasContent = !!(displayTitle || thumbUrl);

  $: kindLabel = (
    {
      forum_post: 'Forum',
      wiki_page: 'Wiki',
      gallery_work: 'Gallery',
      place: 'Place'
    } as Record<string, string>
  )[entity.kind] || 'Object';

  function getNavRef(): NavRef | null {
    switch (entity.kind) {
      case 'forum_post':
        return { kind: 'forum_post', postId: entity.targetId, channelId: record?.channelId };
      case 'wiki_page':
        return { kind: 'wiki_page', pageId: entity.targetId, channelId: record?.channelId };
      case 'gallery_work':
        return { kind: 'gallery_work', workId: entity.targetId, channelId: record?.channelId };
      case 'place':
        return {
          kind: 'place',
          placeId: entity.targetId,
          layerId: entity.layerId ?? undefined,
          poiId: entity.poiId ?? undefined
        };
      default:
        return null;
    }
  }

  async function handleClick() {
    const ref = getNavRef();
    if (ref) {
      await navigateToRef(ref);
    } else {
      console.info('[UnfurlCard] No navigation target for kind:', entity.kind, 'id:', entity.targetId);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }
</script>

{#if hasContent}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="unfurl-card unfurl-card--{entity.kind}"
    role="button"
    tabindex="0"
    on:click|stopPropagation={handleClick}
    on:keydown={handleKeydown}
  >
    <div class="unfurl-card-body">
      <div class="unfurl-card-kicker">{kindLabel}</div>
      <div class="unfurl-card-title">{displayTitle}</div>
      {#if displaySubtitle}
        <div class="unfurl-card-subtitle">{displaySubtitle}</div>
      {/if}
      {#if displayStatus}
        <span class="unfurl-card-status">{displayStatus}</span>
      {/if}
    </div>
    {#if thumbUrl}
      <div class="unfurl-card-thumb">
        <img src={thumbUrl} alt="" loading="lazy" />
      </div>
    {/if}
  </div>
{/if}

<style>
  .unfurl-card {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.375rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-md, 8px);
    background: var(--surface-card, rgba(255, 255, 255, 0.04));
    border-left: 3px solid var(--interactive-accent, #5865f2);
    cursor: pointer;
    max-width: 280px;
    transition: background 0.15s ease;
    align-items: stretch;
  }
  .unfurl-card:hover {
    background: var(--surface-card-hover, rgba(255, 255, 255, 0.07));
  }
  .unfurl-card-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .unfurl-card-kicker {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted, #8e9297);
    line-height: 1.3;
  }
  .unfurl-card-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-normal, #dcddde);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unfurl-card-subtitle {
    font-size: 0.6875rem;
    color: var(--text-muted, #8e9297);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unfurl-card-status {
    display: inline-block;
    font-size: 0.6rem;
    font-weight: 600;
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm, 4px);
    background: var(--bg-mod-subtle, rgba(255, 255, 255, 0.06));
    color: var(--text-muted, #8e9297);
    align-self: flex-start;
    margin-top: 0.125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .unfurl-card-thumb {
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    border-radius: var(--radius-sm, 4px);
    overflow: hidden;
    align-self: center;
  }
  .unfurl-card-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .unfurl-card--forum_post {
    border-left-color: #3b82f6;
  }
  .unfurl-card--wiki_page {
    border-left-color: #22c55e;
  }
  .unfurl-card--gallery_work {
    border-left-color: #a855f7;
  }
  .unfurl-card--place {
    border-left-color: #f59e0b;
  }
</style>
