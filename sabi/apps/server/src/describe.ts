/**
 * Human-readable summaries of journal events for timelines and "what changed"
 * lists. Summaries are computed at read time from the pack's labels, so
 * renaming a state in configuration updates old history too.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { JournalEvent, Label, Pack } from '@sabi/core';
import { formatMinor, formatQty, docType, jobType, stateOf } from '@sabi/core';
import { one } from './db.ts';

const L = (en: string, th = en): Label => ({ en, th });
type D = Record<string, any>;

export interface Described {
  seq: number;
  at: string;
  actorId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  summary: Label;
  /** Short context such as the document number, when the summary is shown outside its subject. */
  context?: string;
  /** Message body / reason, shown as a quote. */
  detail?: string;
  auto?: boolean;
  tone?: string;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function describeEvent(db: DatabaseSync, pack: Pack, e: JournalEvent): Described | null {
  const d = e.data as D;
  const base = { seq: e.seq, at: e.at, actorId: e.actorId, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId };
  const docInfo = (id: string) => one<{ number: string | null; type: string }>(db, 'SELECT number, type FROM documents WHERE id = ?', id);
  const docName = (id: string) => {
    const r = docInfo(id);
    if (!r) return L('document', 'เอกสาร');
    const t = safe(() => docType(pack, r.type).label, L(r.type));
    return { en: `${t.en} ${r.number ?? '(draft)'}`, th: `${t.th ?? t.en} ${r.number ?? '(ร่าง)'}` };
  };
  const jobNumber = (id: string) => one<{ number: string }>(db, 'SELECT number FROM jobs WHERE id = ?', id)?.number ?? '';
  const taskTitle = (id: string) => one<{ title: string }>(db, 'SELECT title FROM tasks WHERE id = ?', id)?.title ?? '';
  const itemName = (id: string) => one<{ name: string }>(db, 'SELECT name, uom FROM items WHERE id = ?', id)?.name ?? '';

  switch (e.type) {
    case 'job.created':
      return { ...base, summary: L(`Opened job ${d.job.number}: ${d.job.title}`, `เปิดงาน ${d.job.number}: ${d.job.title}`), context: d.job.number };
    case 'job.updated': {
      const keys = Object.keys(d.patch ?? {}).filter((k) => k !== 'updatedAt');
      return { ...base, summary: L(`Updated ${keys.includes('fields') ? 'job details' : keys.join(', ')}`, 'แก้ไขรายละเอียดงาน'), context: jobNumber(d.id) };
    }
    case 'job.transitioned': {
      const job = one<{ type: string; number: string }>(db, 'SELECT type, number FROM jobs WHERE id = ?', d.id);
      const st = safe(() => stateOf(jobType(pack, job!.type).workflow, d.to), null);
      const lab = st?.label ?? L(d.to);
      return {
        ...base, auto: !!d.auto, tone: st?.tone, detail: d.reason, context: job?.number,
        summary: { en: `Moved to ${lab.en}`, th: `เปลี่ยนสถานะเป็น ${lab.th ?? lab.en}` },
      };
    }
    case 'document.created': {
      const t = safe(() => docType(pack, d.document.type).label, L(d.document.type));
      return { ...base, summary: { en: `Drafted ${t.en}`, th: `ร่าง${t.th ?? t.en}` } };
    }
    case 'document.updated':
      return { ...base, summary: { en: `Edited ${docName(d.id).en}`, th: `แก้ไข${docName(d.id).th}` } };
    case 'document.transitioned': {
      const r = docInfo(d.id);
      const dt = r ? safe(() => docType(pack, r.type), null) : null;
      const tr = dt?.workflow.transitions.find((t) => t.id === d.transitionId);
      const st = dt ? safe(() => stateOf(dt.workflow, d.to), null) : null;
      const name = docName(d.id);
      const verb = tr?.label ?? st?.label ?? L(d.to);
      return {
        ...base, auto: !!d.auto, tone: st?.tone, detail: d.reason, context: r?.number ?? undefined,
        summary: { en: `${verb.en} — ${name.en}`, th: `${verb.th ?? verb.en} — ${name.th}` },
      };
    }
    case 'stock.moved': {
      const moves = d.moves as D[];
      if (!moves.length) return null;
      const first = moves[0];
      const n = moves.length;
      if (d.kind === 'issue') {
        return { ...base, summary: L(`Used ${formatQty(first.qty)} × ${itemName(first.itemId)} on the job`, `เบิกใช้ ${formatQty(first.qty)} × ${itemName(first.itemId)}`), detail: first.note };
      }
      if (d.kind === 'adjustment') {
        const sign = first.to === 'adjustment' ? '−' : '+';
        return { ...base, summary: L(`Stock adjusted ${sign}${formatQty(first.qty)} ${itemName(first.itemId)}`, `ปรับสต็อก ${sign}${formatQty(first.qty)} ${itemName(first.itemId)}`), detail: first.note };
      }
      if (d.kind === 'transfer') {
        return { ...base, summary: L(`Moved ${formatQty(first.qty)} ${itemName(first.itemId)} ${first.from} → ${first.to}`, `ย้าย ${formatQty(first.qty)} ${itemName(first.itemId)} ${first.from} → ${first.to}`) };
      }
      const dir = first.to === 'customer' ? L('delivered out of stock', 'ตัดสต็อกส่งลูกค้า')
        : first.from === 'supplier' ? L('received into stock', 'รับเข้าคลัง')
          : L('stock reversed', 'กลับรายการสต็อก');
      return { ...base, summary: { en: `${n} line${n > 1 ? 's' : ''} ${dir.en}`, th: `${n} รายการ ${dir.th}` } };
    }
    case 'payment.recorded': {
      const p = d.payment;
      const amt = formatMinor(p.amount);
      const wht = p.whtAmount ? ` (+ ฿${formatMinor(p.whtAmount)} WHT)` : '';
      if (p.allocations?.every((a: { refund?: boolean }) => a.refund)) {
        return { ...base, context: p.number, summary: L(`Refunded ฿${amt} — ${p.number}`, `คืนเงิน ฿${amt} — ${p.number}`) };
      }
      return p.direction === 'in'
        ? { ...base, context: p.number, summary: L(`Received ฿${amt}${wht} — ${p.number}`, `รับชำระ ฿${amt}${wht} — ${p.number}`), tone: 'success' }
        : { ...base, context: p.number, summary: L(`Paid ฿${amt}${wht} — ${p.number}`, `จ่ายเงิน ฿${amt}${wht} — ${p.number}`) };
    }
    case 'payment.voided':
      return { ...base, tone: 'danger', detail: d.reason, summary: L('Voided a payment', 'ยกเลิกการรับ/จ่ายเงิน') };
    case 'task.created':
      return { ...base, summary: L(`Task: ${d.task.title}`, `งานที่ต้องทำ: ${d.task.title}`) };
    case 'task.updated':
      return { ...base, summary: L(`Updated task: ${taskTitle(d.id)}`, `แก้ไขงาน: ${taskTitle(d.id)}`) };
    case 'task.completed':
      return { ...base, tone: 'success', summary: L(`Done: ${taskTitle(d.id)}`, `เสร็จแล้ว: ${taskTitle(d.id)}`) };
    case 'task.reopened':
      return { ...base, summary: L(`Reopened: ${taskTitle(d.id)}`, `เปิดใหม่: ${taskTitle(d.id)}`) };
    case 'message.posted':
      return d.message.label
        ? { ...base, summary: d.message.label, auto: true }
        : { ...base, summary: L('Commented', 'แสดงความคิดเห็น'), detail: d.message.body };
    case 'file.attached':
      return { ...base, summary: L(`Attached ${d.file.name}`, `แนบไฟล์ ${d.file.name}`) };
    case 'approval.requested':
      return { ...base, tone: 'warning', detail: d.approval.reason, summary: L(`Asked ${d.approval.role} for approval`, `ขออนุมัติจาก ${d.approval.role}`) };
    case 'approval.decided':
      return d.state === 'approved'
        ? { ...base, tone: 'success', detail: d.comment, summary: L('Approved', 'อนุมัติแล้ว') }
        : { ...base, tone: 'danger', detail: d.comment, summary: L('Rejected', 'ไม่อนุมัติ') };
    case 'approval.invalidated':
      return { ...base, tone: 'warning', summary: L('Approval reset because the document changed', 'การอนุมัติถูกยกเลิกเพราะเอกสารถูกแก้ไข') };
    case 'party.created':
      return { ...base, summary: L(`Added ${d.party.name}`, `เพิ่ม ${d.party.name}`) };
    case 'party.updated':
      return { ...base, summary: L('Updated contact details', 'แก้ไขข้อมูลติดต่อ') };
    case 'item.created':
      return { ...base, summary: L(`Added item ${d.item.sku}`, `เพิ่มสินค้า ${d.item.sku}`) };
    case 'item.updated':
      return { ...base, summary: L('Updated item', 'แก้ไขสินค้า') };
    case 'user.created':
      return { ...base, summary: L(`Added user ${d.user.name} (${d.user.role})`, `เพิ่มผู้ใช้ ${d.user.name} (${d.user.role})`) };
    case 'user.updated':
      return { ...base, summary: L('Updated a user', 'แก้ไขผู้ใช้') };
    case 'company.updated':
      return { ...base, summary: L('Updated company settings', 'แก้ไขข้อมูลบริษัท') };
    case 'settings.updated':
      return { ...base, summary: L(`Changed setting: ${d.key}`, `เปลี่ยนการตั้งค่า: ${d.key}`) };
    case 'account.created':
      return { ...base, summary: L(`Added account ${d.account.code} ${d.account.name.en}`, `เพิ่มบัญชี ${d.account.code} ${d.account.name.th ?? d.account.name.en}`) };
    case 'document.applied': {
      const by = docName(d.byId);
      const amt = formatMinor(Math.abs(d.amount));
      return d.amount >= 0
        ? { ...base, context: by.en, summary: { en: `${by.en} reduced the balance by ฿${amt}`, th: `${by.th} ลดยอดค้าง ฿${amt}` } }
        : { ...base, context: by.en, summary: { en: `${by.en} added ฿${amt} to the balance`, th: `${by.th} เพิ่มยอดค้าง ฿${amt}` } };
    }
    case 'document.unapplied': {
      const by = docName(d.byId);
      return { ...base, tone: 'warning', summary: { en: `${by.en} no longer applies (voided)`, th: `${by.th} ถูกยกเลิก ไม่มีผลกับยอดค้างแล้ว` } };
    }
    case 'document.retention_released':
      return { ...base, tone: 'success', summary: L(`Released retention ฿${formatMinor(d.amount)}`, `คืนเงินประกันผลงาน ฿${formatMinor(d.amount)}`) };
    default:
      return null;
  }
}
