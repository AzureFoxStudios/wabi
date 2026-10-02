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
  const roleName = (id: string): Label => pack.roles.find((r) => r.id === id)?.label ?? L(id);
  const locName = (id: string) => { const l = pack.locations.find((x) => x.id === id)?.name; return { en: l?.en ?? id, th: l?.th ?? l?.en ?? id }; };
  const itemName = (id: string) => one<{ name: string }>(db, 'SELECT name, uom FROM items WHERE id = ?', id)?.name ?? '';

  switch (e.type) {
    case 'job.created':
      return { ...base, summary: L(`Opened a new job: ${d.job.title}`, `เปิดงานใหม่: ${d.job.title}`), context: d.job.number };
    case 'job.updated': {
      const keys = Object.keys(d.patch ?? {}).filter((k) => k !== 'updatedAt');
      return { ...base, summary: L('Changed the job details', 'แก้ไขรายละเอียดงาน'), context: jobNumber(d.id) };
    }
    case 'job.transitioned': {
      const job = one<{ type: string; number: string }>(db, 'SELECT type, number FROM jobs WHERE id = ?', d.id);
      const st = safe(() => stateOf(jobType(pack, job!.type).workflow, d.to), null);
      const lab = st?.label ?? L(d.to);
      return {
        ...base, auto: !!d.auto, tone: st?.tone, detail: d.reason, context: job?.number,
        summary: { en: `Job is now at: ${lab.en}`, th: `งานเดินมาถึงขั้น: ${lab.th ?? lab.en}` },
      };
    }
    case 'document.created': {
      const t = safe(() => docType(pack, d.document.type).label, L(d.document.type));
      return { ...base, summary: { en: `Started a draft ${t.en.toLowerCase()}`, th: `เริ่มร่าง${t.th ?? t.en}` } };
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
        return { ...base, summary: L(`Took ${itemName(first.itemId)} × ${formatQty(first.qty)} from stock for the job`, `เบิกของไปใช้ในงาน: ${itemName(first.itemId)} × ${formatQty(first.qty)}`), detail: first.note };
      }
      if (d.kind === 'adjustment') {
        const sign = first.to === 'adjustment' ? '−' : '+';
        return { ...base, summary: L(`Corrected the stock count of ${itemName(first.itemId)} (${sign}${formatQty(first.qty)})`, `แก้จำนวนของในคลัง ${itemName(first.itemId)} (${sign}${formatQty(first.qty)})`), detail: first.note };
      }
      if (d.kind === 'transfer') {
        return { ...base, summary: L(`Moved ${itemName(first.itemId)} × ${formatQty(first.qty)} from ${locName(first.from).en} to ${locName(first.to).en}`, `ย้าย ${itemName(first.itemId)} × ${formatQty(first.qty)} จาก${locName(first.from).th} ไป${locName(first.to).th}`) };
      }
      const dir = first.note === 'void' ? L('stock movement reversed (voided)', 'กลับรายการสต็อก (ยกเลิกเอกสาร)')
        : first.to === 'customer' ? L('delivered out of stock', 'ตัดสต็อกส่งลูกค้า')
          : first.from === 'supplier' ? L('received into stock', 'รับเข้าคลัง')
            : first.from === 'customer' ? L('returned by the customer into stock', 'ลูกค้าคืนสินค้าเข้าคลัง')
              : first.to === 'supplier' ? L('returned to the supplier', 'คืนสินค้าให้ผู้ขาย')
                : L('stock moved', 'เคลื่อนไหวสต็อก');
      return { ...base, summary: { en: `${n} line${n > 1 ? 's' : ''} ${dir.en}`, th: `${n} รายการ ${dir.th}` } };
    }
    case 'payment.recorded': {
      const p = d.payment;
      const amt = formatMinor(p.amount);
      const wht = p.whtAmount ? L(` (plus ฿${formatMinor(p.whtAmount)} tax held back)`, ` (และหักภาษีไว้ ฿${formatMinor(p.whtAmount)})`) : L('');
      if (p.allocations?.every((a: { refund?: boolean }) => a.refund)) {
        return { ...base, context: p.number, summary: L(`Gave back ฿${amt} to the customer`, `คืนเงินให้ลูกค้า ฿${amt}`) };
      }
      return p.direction === 'in'
        ? { ...base, context: p.number, summary: L(`Received ฿${amt}${wht.en}`, `ได้รับเงิน ฿${amt}${wht.th}`), tone: 'success' }
        : { ...base, context: p.number, summary: L(`Paid out ฿${amt}${wht.en}`, `จ่ายเงินออก ฿${amt}${wht.th}`) };
    }
    case 'payment.voided':
      return { ...base, tone: 'danger', detail: d.reason, summary: L('Cancelled a payment record', 'ยกเลิกรายการรับ/จ่ายเงิน') };
    case 'task.created':
      return { ...base, summary: L(`Added a to-do: ${d.task.title}`, `เพิ่มสิ่งที่ต้องทำ: ${d.task.title}`) };
    case 'task.updated':
      return { ...base, summary: L(`Changed a to-do: ${taskTitle(d.id)}`, `แก้สิ่งที่ต้องทำ: ${taskTitle(d.id)}`) };
    case 'task.completed':
      return { ...base, tone: 'success', summary: L(`Finished: ${taskTitle(d.id)}`, `ทำเสร็จแล้ว: ${taskTitle(d.id)}`) };
    case 'task.reopened':
      return { ...base, summary: L(`Not finished after all: ${taskTitle(d.id)}`, `ยังไม่เสร็จ (เปิดใหม่): ${taskTitle(d.id)}`) };
    case 'message.posted':
      return d.message.label
        ? { ...base, summary: d.message.label, auto: true }
        : { ...base, summary: L('Wrote a message', 'เขียนข้อความ'), detail: d.message.body };
    case 'file.attached':
      return { ...base, summary: L(`Added a file: ${d.file.name}`, `แนบไฟล์: ${d.file.name}`) };
    case 'approval.requested':
      return { ...base, tone: 'warning', detail: d.approval.reason, summary: { en: `Asked the ${roleName(d.approval.role).en.toLowerCase()} to approve`, th: `ขอให้${roleName(d.approval.role).th ?? roleName(d.approval.role).en}อนุมัติ` } };
    case 'approval.decided':
      return d.state === 'approved'
        ? { ...base, tone: 'success', detail: d.comment, summary: L('Said yes (approved)', 'อนุมัติแล้ว') }
        : { ...base, tone: 'danger', detail: d.comment, summary: L('Said no (not approved)', 'ไม่อนุมัติ') };
    case 'approval.invalidated':
      return { ...base, tone: 'warning', summary: L('The approval was cancelled because the document was changed — it needs approving again', 'การอนุมัติถูกยกเลิก เพราะมีการแก้เอกสาร ต้องขออนุมัติใหม่') };
    case 'party.created':
      return { ...base, summary: L(`Added a new contact: ${d.party.name}`, `เพิ่มรายชื่อใหม่: ${d.party.name}`) };
    case 'party.updated':
      return { ...base, summary: L('Updated contact details', 'แก้ไขข้อมูลติดต่อ') };
    case 'item.created':
      return { ...base, summary: L(`Added a new product: ${d.item.name}`, `เพิ่มสินค้าใหม่: ${d.item.name}`) };
    case 'item.updated':
      return { ...base, summary: L('Changed product details', 'แก้ไขข้อมูลสินค้า') };
    case 'user.created':
      return { ...base, summary: { en: `Gave ${d.user.name} a login (${roleName(d.user.role).en})`, th: `เพิ่มผู้ใช้ ${d.user.name} (${roleName(d.user.role).th ?? roleName(d.user.role).en})` } };
    case 'user.updated':
      return { ...base, summary: L('Changed a person’s login', 'แก้ไขข้อมูลผู้ใช้') };
    case 'company.updated':
      return { ...base, summary: L('Changed the company details', 'แก้ไขข้อมูลบริษัท') };
    case 'settings.updated':
      return { ...base, summary: d.key === 'webhook' ? L('Changed the connection to other apps', 'แก้การเชื่อมต่อกับแอปอื่น') : d.key === 'signInNotice' ? L('Changed the message on the sign-in page', 'แก้ข้อความหน้าเข้าสู่ระบบ') : L('Changed a setting', 'เปลี่ยนการตั้งค่า') };
    case 'account.created':
      return { ...base, summary: L(`Added account ${d.account.code} ${d.account.name.en}`, `เพิ่มบัญชี ${d.account.code} ${d.account.name.th ?? d.account.name.en}`) };
    case 'document.applied': {
      const by = docName(d.byId);
      const amt = formatMinor(Math.abs(d.amount));
      return d.amount >= 0
        ? { ...base, context: by.en, summary: { en: `${by.en} lowered the amount still owed by ฿${amt}`, th: `${by.th} ทำให้ยอดที่ยังค้างลดลง ฿${amt}` } }
        : { ...base, context: by.en, summary: { en: `${by.en} added ฿${amt} to the amount owed`, th: `${by.th} ทำให้ยอดที่ค้างเพิ่มขึ้น ฿${amt}` } };
    }
    case 'document.unapplied': {
      const by = docName(d.byId);
      return { ...base, tone: 'warning', summary: { en: `${by.en} no longer applies (voided)`, th: `${by.th} ถูกยกเลิก ไม่มีผลกับยอดค้างแล้ว` } };
    }
    case 'document.retention_released':
      return { ...base, tone: 'success', summary: L(`Released the held-back guarantee money ฿${formatMinor(d.amount)}`, `คืนเงินประกันผลงานที่หักไว้ ฿${formatMinor(d.amount)}`) };
    default:
      return null;
  }
}
