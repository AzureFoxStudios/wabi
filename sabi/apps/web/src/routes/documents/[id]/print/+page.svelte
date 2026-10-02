<script lang="ts">
  import { page } from '$app/state';
  import { get } from '$lib/api.ts';
  import Paper from '$components/Paper.svelte';

  let v = $state<any>(null);
  let error = $state('');
  $effect(() => {
    get(`documents/${page.params.id}`)
      .then(async (x) => {
        v = x;
        document.title = `${x.document.number ?? 'draft'} · ${x.party.name}`;
        await document.fonts?.ready;
        setTimeout(() => window.print(), 300);
      })
      .catch((e) => (error = e.message));
  });
  // Full tax invoices are issued in at least two copies (original to the buyer).
  const copies = $derived(v && (v.docType.jurisdiction?.th as any)?.taxDocument === 'full' && v.document.phase !== 'draft' ? (['original', 'copy'] as const) : (['original'] as const));
</script>

{#if error}<p style="padding:2rem">{error}</p>{/if}
{#if v}
  <div class="noprint bar"><button class="btn primary" onclick={() => window.print()}>Print / พิมพ์</button> <a class="btn ghost" href={`/documents/${v.document.id}`}>← Back</a></div>
  {#each copies as c (c)}<div class="sheet"><Paper {v} copy={c} /></div>{/each}
{/if}

<style>
  :global(body) { background: var(--sunken); }
  .bar { position: sticky; top: 0; padding: 10px 16px; display: flex; gap: 8px; background: var(--surface); border-bottom: 1px solid var(--line); }
  .sheet { margin: 20px auto; width: fit-content; }
  @media print {
    :global(body) { background: white; }
    .noprint { display: none !important; }
    .sheet { margin: 0; break-after: page; }
    .sheet:last-child { break-after: auto; }
  }
</style>
