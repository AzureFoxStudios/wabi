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

{#if m.kind === 'field'}{T('First fill in', 'ต้องกรอก')} <strong>{fieldLabel(m.key)}</strong>{T('', ' ก่อน')}
{:else if m.kind === 'document'}{#if m.phase.includes('issued')}{T('First make and issue a', 'ต้องออก')} <strong>{L(docTypeDef(m.type)?.label)}</strong>{T('', ' ก่อน')}{:else}{T('First make a', 'ต้องมี')} <strong>{L(docTypeDef(m.type)?.label)}</strong> ({phaseWord(m.phase)}){/if}
{:else if m.kind === 'tasks'}{T(`First finish the ${m.open} unfinished to-do${m.open > 1 ? 's' : ''}`, `ต้องทำสิ่งที่ค้างอยู่อีก ${m.open} อย่างให้เสร็จก่อน`)}
{:else if m.kind === 'lines'}{T('Add at least one product or service line', 'ต้องใส่สินค้าหรือบริการอย่างน้อย 1 รายการ')}
{:else if m.kind === 'approval'}
  {#if m.status === 'pending'}{T('Waiting for the', 'รอ')} {roleLabel(m.role)} {T('to approve', 'อนุมัติ')}
  {:else if m.status === 'rejected'}{roleLabel(m.role)} {T('said no — change it, then ask again', 'ไม่อนุมัติ — แก้ไขแล้วขออนุมัติใหม่')}
  {:else}{T('The', 'ต้องให้')} {roleLabel(m.role)} {T('must approve this first', 'อนุมัติก่อน')}{/if}
{:else if m.kind === 'payment'}{m.settled ? T('Waiting until it is fully paid', 'รอจนกว่าจะจ่ายครบ') : T('Money is still owed on this', 'ยังมีเงินค้างจ่ายอยู่')}
{:else if m.kind === 'role'}{T('Only these people can do this step:', 'ขั้นนี้ทำได้เฉพาะ')} {m.roles.map(roleLabel).join(', ')}
{/if}
