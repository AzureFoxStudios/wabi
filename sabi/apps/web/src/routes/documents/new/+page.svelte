<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { get, command } from '$lib/api.ts';
  import { app, T, toast, docTypeDef } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';
  import Picker from '$components/Picker.svelte';

  const type = page.url.searchParams.get('type') ?? 'quotation';
  const jobId = page.url.searchParams.get('jobId') ?? undefined;
  const short = page.url.searchParams.get('short') === '1';
  const dt = docTypeDef(type);
  let partyId = $state(page.url.searchParams.get('partyId') ?? '');
  let busy = $state(false);
  let prefill = $state<any[]>([]);

  // Ordering a shortage from a job: pre-fill lines with what is missing.
  $effect(() => {
    if (!short || !jobId) return;
    get(`jobs/${jobId}`).then((w) => {
      prefill = w.fulfilment.filter((l: any) => l.short && l.itemId).map((l: any) => ({ itemId: l.itemId, qty: Math.max(0, Math.round((-(l.available ?? 0) - (l.incoming ?? 0)) * 1000) / 1000) || l.remaining }));
    });
  });

  async function create(e: Event) {
    e.preventDefault();
    busy = true;
    try {
      const r = await command('document.create', { type, partyId, jobId, lines: prefill });
      goto(`/documents/${r.id}`, { replaceState: true });
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }
</script>

<div class="page narrow">
  <header class="page-head"><h1>{T('New', 'สร้าง')} {L(dt?.label)}</h1></header>
  <form class="stack" onsubmit={create}>
    <Picker kind="parties" role={dt?.direction === 'purchase' ? 'supplier' : 'customer'} bind:value={partyId} label={dt?.direction === 'purchase' ? T('Supplier', 'ผู้ขาย') : T('Customer', 'ลูกค้า')} autofocus />
    {#if prefill.length}<p class="callout info small">{T(`${prefill.length} short item(s) from the job will be added. Adjust quantities on the next screen.`, `จะเพิ่มรายการที่ขาด ${prefill.length} รายการจากงาน แก้จำนวนได้ในหน้าถัดไป`)}</p>{/if}
    {#if jobId}<p class="small muted">{T('Linked to the job, so it shows up in its documents and money.', 'ผูกกับงาน จะแสดงในเอกสารและการเงินของงาน')}</p>{/if}
    <div class="row"><button class="btn primary" disabled={!partyId || busy}>{T('Continue', 'ต่อไป')}</button><a class="btn ghost" href={jobId ? `/jobs/${jobId}` : '/documents'}>{T('Cancel', 'ยกเลิก')}</a></div>
  </form>
</div>
