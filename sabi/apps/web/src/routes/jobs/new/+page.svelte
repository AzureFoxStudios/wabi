<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { command } from '$lib/api.ts';
  import { app, T, toast } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';
  import Picker from '$components/Picker.svelte';

  const types = app.boot.pack.jobTypes;
  let type = $state(page.url.searchParams.get('type') ?? types[0].id);
  let partyId = $state(page.url.searchParams.get('partyId') ?? '');
  let title = $state('');
  let fields = $state<Record<string, any>>({});
  let busy = $state(false);
  const jt = $derived(types.find((t: any) => t.id === type));
  // Keep the first form short: only summary fields; everything else is edited in the workspace.
  const quickFields = $derived(jt.fields.filter((f: any) => f.summary || f.type === 'longtext').slice(0, 4));
  let newParty = $state(false);
  let partyName = $state('');
  let partyPhone = $state('');
  let partyKind = $state('person');

  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    try {
      let pid = partyId;
      if (newParty) {
        pid = (await command('party.create', { kind: partyKind, name: partyName, phone: partyPhone || undefined, roles: ['customer'] })).id;
      }
      const cleaned = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v !== undefined));
      const r = await command('job.create', { type, title, partyId: pid, fields: cleaned });
      toast(`${r.number} ✓`, 'success');
      goto(`/jobs/${r.id}`);
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{T('New job', 'งานใหม่')} · Sabi</title></svelte:head>

<div class="page narrow">
  <header class="page-head"><div><h1>{T('New job', 'เปิดงานใหม่')}</h1><p class="hint">{T('Open a job when a customer calls, visits or asks for a price. Only the customer and a short name are needed — everything else can be added later.', 'เปิดงานเมื่อลูกค้าโทรมา มาที่ร้าน หรือขอราคา ใส่แค่ชื่อลูกค้าและชื่องานสั้น ๆ ก็พอ ที่เหลือเพิ่มทีหลังได้')}</p></div></header>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form class="form" onsubmit={submit} onkeydown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(e)}>
    <div class="types">
      {#each types as t (t.id)}
        <label class:on={type === t.id}><input type="radio" bind:group={type} value={t.id} /> {L(t.label)}</label>
      {/each}
    </div>

    {#if !newParty}
      <div class="row end">
        <div class="grow"><Picker kind="parties" role="customer" bind:value={partyId} label={T('Customer', 'ลูกค้า')} autofocus /></div>
        <button type="button" class="btn ghost" onclick={() => (newParty = true)}>+ {T('New customer', 'ลูกค้าใหม่')}</button>
      </div>
    {:else}
      <fieldset>
        <legend class="small muted">{T('New customer', 'ลูกค้าใหม่')} · <button type="button" class="link small" onclick={() => (newParty = false)}>{T('pick existing', 'เลือกจากรายชื่อ')}</button></legend>
        <div class="grid3">
          <select bind:value={partyKind}><option value="person">{T('Person', 'บุคคล')}</option><option value="organization">{T('Company', 'บริษัท/นิติบุคคล')}</option></select>
          <input bind:value={partyName} placeholder={T('Name', 'ชื่อ')} required />
          <input bind:value={partyPhone} placeholder={T('Phone', 'เบอร์โทร')} />
        </div>
        <p class="tiny muted">{T('Tax ID and address can be added later — they are only needed for a full tax invoice.', 'เลขผู้เสียภาษีและที่อยู่เพิ่มทีหลังได้ ใช้เมื่อออกใบกำกับภาษีเต็มรูป')}</p>
      </fieldset>
    {/if}

    <label class="field"><span>{T('Short name for the job', 'ชื่องานสั้น ๆ')}</span><input bind:value={title} required placeholder={T('e.g. House roof, Lat Pla Duk', 'เช่น มุงหลังคาบ้าน ลาดปลาดุก')} /></label>

    {#each quickFields as f (f.key)}
      <label class="field"><span>{L(f.label)}</span>
        {#if f.type === 'select'}
          <select bind:value={fields[f.key]}><option value="">—</option>{#each f.options as o (o.value)}<option value={o.value}>{L(o.label)}</option>{/each}</select>
        {:else if f.type === 'longtext'}<textarea bind:value={fields[f.key]} rows="3"></textarea>
        {:else if f.type === 'date'}<input type="date" bind:value={fields[f.key]} />
        {:else}<input bind:value={fields[f.key]} />{/if}
      </label>
    {/each}

    <div class="row">
      <button class="btn primary lg" disabled={busy || !title || (!partyId && !(newParty && partyName))}>{T('Open the job', 'เปิดงาน')} <kbd>⌘↵</kbd></button>
      <a class="btn ghost" href="/jobs">{T('Cancel', 'ยกเลิก')}</a>
    </div>
  </form>
</div>

<style>
  .form { display: flex; flex-direction: column; gap: 16px; }
  .types { display: flex; gap: 8px; }
  .types label { display: flex; gap: 8px; align-items: center; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 8px 14px; cursor: pointer; background: var(--surface); }
  .types label.on { border-color: var(--accent); background: var(--accent-soft); }
  .types input { accent-color: var(--accent); width: auto; min-height: 0; }
  .end { align-items: flex-end; }
  fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
  .grid3 { display: grid; grid-template-columns: 160px 1fr 180px; gap: 8px; }
  button.link { background: none; border: 0; padding: 0; font: inherit; }
</style>
