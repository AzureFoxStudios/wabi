<script lang="ts">
  import { T, docTypeDef, roleLabel } from '$lib/state.svelte.ts';
  import { L } from '$lib/format.ts';
  let { m, fields = [] }: { m: any; fields?: any[] } = $props();
  const fieldLabel = (key: string) => {
    const f = fields.find((x) => x.key === key);
    if (f) return L(f.label);
    return ({ partyId: T('customer', 'ลูกค้า'), supplier_ref: T("supplier's invoice no.", 'เลขที่ใบกำกับของผู้ขาย') } as Record<string, string>)[key] ?? key;
  };
  const phaseWord = (p: string[]) => (p.includes('issued') ? T('issued', 'ที่ออกแล้ว') : p.join('/'));
</script>

{#if m.kind === 'field'}{T('Fill in', 'กรอก')} <strong>{fieldLabel(m.key)}</strong>
{:else if m.kind === 'document'}{T('Needs', 'ต้องมี')} {L(docTypeDef(m.type)?.label)} {phaseWord(m.phase)}
{:else if m.kind === 'tasks'}{T(`Finish ${m.open} open task${m.open > 1 ? 's' : ''}`, `ทำงานที่ค้างอีก ${m.open} รายการ`)}
{:else if m.kind === 'lines'}{T('Add at least one line', 'เพิ่มรายการอย่างน้อยหนึ่งรายการ')}
{:else if m.kind === 'approval'}
  {#if m.status === 'pending'}{T('Waiting for approval from', 'รอการอนุมัติจาก')} {roleLabel(m.role)}
  {:else if m.status === 'rejected'}{roleLabel(m.role)} {T('rejected this — change it and ask again', 'ไม่อนุมัติ — แก้ไขแล้วขอใหม่')}
  {:else}{T('Needs approval from', 'ต้องได้รับอนุมัติจาก')} {roleLabel(m.role)}{/if}
{:else if m.kind === 'payment'}{m.settled ? T('Waiting for full payment', 'รอชำระเงินครบ') : T('A payment is still open', 'ยังมียอดค้างชำระ')}
{:else if m.kind === 'role'}{T('Only', 'เฉพาะ')} {m.roles.map(roleLabel).join(', ')} {T('can do this step', 'ทำขั้นตอนนี้ได้')}
{/if}
