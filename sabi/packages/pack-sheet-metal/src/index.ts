/**
 * Configuration pack: metal-sheet roofing & construction-material supplier.
 *
 * This is the ONLY place where the trade appears. Everything below is data
 * interpreted by the generic core: job/document types, workflow states,
 * guards, fields, measure templates, roles and locations.
 */
import type { DocTypeDef, JobTypeDef, Pack, TransitionDef, WorkflowDef, DocPhase } from '@sabi/core';

export { demoSeed, DEMO_USERS, thaiTaxId, type SeedApi } from './seed.ts';

const L = (en: string, th: string) => ({ en, th });

// ───────────────────────────── Documents ─────────────────────────────

const voidT = (from: string[], roles?: string[]): TransitionDef => ({
  id: 'void', from, to: 'void', label: L('Void', 'ยกเลิกเอกสาร'), requireReason: true, tone: 'danger',
  ...(roles ? { roles } : {}),
});
const voidState = { id: 'void', label: L('Void', 'ยกเลิก'), phase: 'void' as DocPhase, tone: 'danger' as const };

const quotation: DocTypeDef = {
  id: 'quotation',
  label: L('Quotation', 'ใบเสนอราคา'),
  printTitle: L('Quotation', 'ใบเสนอราคา'),
  direction: 'sales',
  numbering: { prefix: 'QT' },
  effects: [],
  convertsTo: ['sales_order', 'tax_invoice'],
  priceMode: 'exclusive',
  defaultDueDays: 15,
  dueLabel: L('Valid until', 'ยืนราคาถึง'),
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'sales' },
      { id: 'sent', label: L('Sent', 'ส่งแล้ว'), phase: 'issued', tone: 'info', ownerRole: 'sales', hint: L('Waiting for the customer to decide.', 'รอลูกค้าตัดสินใจ') },
      { id: 'accepted', label: L('Accepted', 'ลูกค้าตกลง'), phase: 'closed', tone: 'success' },
      { id: 'declined', label: L('Declined', 'ลูกค้าปฏิเสธ'), phase: 'closed', tone: 'warning' },
      voidState,
    ],
    transitions: [
      {
        id: 'send', from: ['draft'], to: 'sent', label: L('Issue & send', 'ออกใบเสนอราคา'), primary: true,
        requires: {
          lines: true, fields: ['partyId'],
          approval: { role: 'manager', when: 'max_discount_pct > 10', reason: L('Discount above 10%', 'ส่วนลดเกิน 10%') },
        },
      },
      {
        id: 'accept', from: ['sent'], to: 'accepted', label: L('Customer accepted', 'ลูกค้าตกลง'), primary: true, auto: true,
        requires: { documents: [{ type: 'sales_order', phase: ['issued', 'closed'] }] },
      },
      { id: 'mark_accepted', from: ['sent'], to: 'accepted', label: L('Mark accepted', 'ลูกค้าตกลงแล้ว') },
      { id: 'decline', from: ['sent'], to: 'declined', label: L('Customer declined', 'ลูกค้าปฏิเสธ'), requireReason: true, tone: 'warning' },
      voidT(['draft', 'sent']),
    ],
  },
};

const salesOrder: DocTypeDef = {
  id: 'sales_order',
  label: L('Sales order', 'ใบสั่งขาย'),
  printTitle: L('Sales order confirmation', 'ใบยืนยันการสั่งซื้อ'),
  direction: 'sales',
  numbering: { prefix: 'SO' },
  effects: ['reserve'],
  convertsTo: ['tax_invoice'],
  priceMode: 'exclusive',
  defaultDueDays: 7,
  dueLabel: L('Delivery by', 'กำหนดส่ง'),
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'sales' },
      { id: 'confirmed', label: L('Confirmed', 'ยืนยันแล้ว'), phase: 'issued', tone: 'progress', ownerRole: 'manager' },
      { id: 'fulfilled', label: L('Fulfilled', 'ส่งครบแล้ว'), phase: 'closed', tone: 'success' },
      voidState,
    ],
    transitions: [
      { id: 'confirm', from: ['draft'], to: 'confirmed', label: L('Confirm order', 'ยืนยันคำสั่งซื้อ'), primary: true, requires: { lines: true } },
      { id: 'fulfil', from: ['confirmed'], to: 'fulfilled', label: L('Mark fulfilled', 'ส่งครบแล้ว'), primary: true,
        requires: { documents: [{ type: 'tax_invoice', phase: ['issued', 'closed'] }] } },
      voidT(['draft', 'confirmed'], ['manager', 'accounts']),
    ],
  },
};

/** Money documents close themselves when fully settled and reopen if a payment is voided. */
function paidTransitions(openState: string): TransitionDef[] {
  return [
    { id: 'paid', from: [openState], to: 'paid', label: L('Paid in full', 'ชำระครบ'), auto: true, primary: true, requires: { settled: true } },
    { id: 'reopen', from: ['paid'], to: openState, label: L('Payment reopened', 'กลับมาค้างชำระ'), auto: true, requires: { settled: false } },
  ];
}

const taxInvoice: DocTypeDef = {
  id: 'tax_invoice',
  label: L('Delivery note / Tax invoice', 'ใบส่งของ/ใบกำกับภาษี'),
  printTitle: L('Delivery note / Tax invoice', 'ใบส่งของ/ใบกำกับภาษี'),
  direction: 'sales',
  numbering: { prefix: 'IV' },
  effects: ['stock_out', 'receivable'],
  convertsTo: ['credit_note', 'debit_note'],
  retention: { field: 'retention_pct' },
  fields: [
    { key: 'retention_pct', type: 'number', label: L('Retention held by customer', 'เงินประกันผลงาน (หัก)'), unit: '%' },
  ],
  priceMode: 'exclusive',
  defaultDueDays: 30,
  dueLabel: L('Payment due', 'ครบกำหนดชำระ'),
  jurisdiction: { th: { taxDocument: 'full', taxPoint: 'delivery' } },
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'accounts' },
      { id: 'issued', label: L('Issued', 'ออกแล้ว'), phase: 'issued', tone: 'info', ownerRole: 'accounts', hint: L('Collect payment.', 'ติดตามรับชำระเงิน') },
      { id: 'paid', label: L('Paid', 'ชำระแล้ว'), phase: 'closed', tone: 'success' },
      voidState,
    ],
    transitions: [
      { id: 'issue', from: ['draft'], to: 'issued', label: L('Issue tax invoice', 'ออกใบกำกับภาษี'), primary: true,
        roles: ['accounts', 'manager', 'sales'], requires: { lines: true } },
      ...paidTransitions('issued'),
      voidT(['draft', 'issued'], ['accounts', 'manager']),
    ],
  },
};

/** ใบลดหนี้ / ใบเพิ่มหนี้ (Revenue Code s.86/10, s.86/9): always made from the tax invoice they correct. */
const noteReason = { key: 'reason', type: 'longtext' as const, label: L('Reason', 'เหตุผลในการออก') };
const creditNote: DocTypeDef = {
  id: 'credit_note',
  label: L('Credit note', 'ใบลดหนี้'),
  printTitle: L('Credit note / Tax invoice', 'ใบลดหนี้/ใบกำกับภาษี'),
  direction: 'sales',
  numbering: { prefix: 'CN' },
  effects: ['stock_in', 'receivable'],
  effectsWhen: { stock_in: 'goods_returned' },
  adjusts: 'credit',
  convertsTo: [],
  priceMode: 'exclusive',
  jurisdiction: { th: { taxDocument: 'credit_note' } },
  fields: [
    noteReason,
    { key: 'goods_returned', type: 'boolean', label: L('Goods came back into stock', 'รับสินค้าคืนเข้าคลัง') },
  ],
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'accounts' },
      { id: 'issued', label: L('Issued', 'ออกแล้ว'), phase: 'issued', tone: 'info' },
      voidState,
    ],
    transitions: [
      { id: 'issue', from: ['draft'], to: 'issued', label: L('Issue credit note', 'ออกใบลดหนี้'), primary: true,
        roles: ['accounts', 'manager'], requires: { lines: true, fields: ['reason'] } },
      voidT(['draft', 'issued'], ['accounts', 'manager']),
    ],
  },
};
const debitNote: DocTypeDef = {
  id: 'debit_note',
  label: L('Debit note', 'ใบเพิ่มหนี้'),
  printTitle: L('Debit note / Tax invoice', 'ใบเพิ่มหนี้/ใบกำกับภาษี'),
  direction: 'sales',
  numbering: { prefix: 'DN' },
  effects: ['receivable'],
  adjusts: 'debit',
  convertsTo: [],
  priceMode: 'exclusive',
  jurisdiction: { th: { taxDocument: 'debit_note' } },
  fields: [noteReason],
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'accounts' },
      { id: 'issued', label: L('Issued', 'ออกแล้ว'), phase: 'issued', tone: 'info' },
      voidState,
    ],
    transitions: [
      { id: 'issue', from: ['draft'], to: 'issued', label: L('Issue debit note', 'ออกใบเพิ่มหนี้'), primary: true,
        roles: ['accounts', 'manager'], requires: { lines: true, fields: ['reason'] } },
      voidT(['draft', 'issued'], ['accounts', 'manager']),
    ],
  },
};
const supplierCredit: DocTypeDef = {
  id: 'supplier_credit',
  label: L('Supplier credit note', 'ใบลดหนี้จากผู้ขาย'),
  printTitle: L('Supplier credit note (record)', 'บันทึกใบลดหนี้จากผู้ขาย'),
  direction: 'purchase',
  numbering: { prefix: 'SC' },
  effects: ['stock_out', 'payable'],
  effectsWhen: { stock_out: 'goods_returned' },
  adjusts: 'credit',
  convertsTo: [],
  priceMode: 'exclusive',
  fields: [
    { key: 'supplier_ref', type: 'text', label: L("Supplier's credit note no.", 'เลขที่ใบลดหนี้ของผู้ขาย') },
    noteReason,
    { key: 'goods_returned', type: 'boolean', label: L('Goods sent back to the supplier', 'ส่งสินค้าคืนผู้ขาย') },
  ],
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'accounts' },
      { id: 'recorded', label: L('Recorded', 'บันทึกแล้ว'), phase: 'issued', tone: 'info' },
      voidState,
    ],
    transitions: [
      { id: 'record', from: ['draft'], to: 'recorded', label: L('Record credit note', 'บันทึกใบลดหนี้'), primary: true,
        roles: ['accounts', 'manager'], requires: { lines: true, fields: ['supplier_ref', 'reason'] } },
      voidT(['draft', 'recorded'], ['accounts', 'manager']),
    ],
  },
};

const purchaseOrder: DocTypeDef = {
  id: 'purchase_order',
  label: L('Purchase order', 'ใบสั่งซื้อ'),
  printTitle: L('Purchase order', 'ใบสั่งซื้อ'),
  direction: 'purchase',
  numbering: { prefix: 'PO' },
  effects: [],
  convertsTo: ['goods_receipt', 'supplier_bill'],
  priceMode: 'exclusive',
  defaultDueDays: 7,
  dueLabel: L('Expected', 'กำหนดรับของ'),
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'manager' },
      { id: 'ordered', label: L('Ordered', 'สั่งซื้อแล้ว'), phase: 'issued', tone: 'progress', ownerRole: 'workshop', hint: L('Receive the goods when they arrive.', 'รับสินค้าเมื่อมาถึง') },
      { id: 'received', label: L('Received', 'รับครบแล้ว'), phase: 'closed', tone: 'success' },
      voidState,
    ],
    transitions: [
      { id: 'order', from: ['draft'], to: 'ordered', label: L('Send to supplier', 'ส่งใบสั่งซื้อ'), primary: true,
        requires: { lines: true, approval: { role: 'manager', when: 'total > 50000', reason: L('Purchase above ฿50,000', 'สั่งซื้อเกิน 50,000 บาท') } } },
      { id: 'received', from: ['ordered'], to: 'received', label: L('All received', 'รับครบแล้ว'), auto: true, primary: true,
        requires: { documents: [{ type: 'goods_receipt', phase: ['issued', 'closed'] }] } },
      voidT(['draft', 'ordered'], ['manager']),
    ],
  },
};

const goodsReceipt: DocTypeDef = {
  id: 'goods_receipt',
  label: L('Goods receipt', 'ใบรับสินค้า'),
  printTitle: L('Goods receipt', 'ใบรับสินค้า'),
  direction: 'purchase',
  numbering: { prefix: 'GR' },
  effects: ['stock_in'],
  convertsTo: ['supplier_bill'],
  priceMode: 'exclusive',
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'workshop' },
      { id: 'received', label: L('Received', 'รับเข้าคลังแล้ว'), phase: 'issued', tone: 'success' },
      voidState,
    ],
    transitions: [
      { id: 'receive', from: ['draft'], to: 'received', label: L('Receive into stock', 'รับเข้าคลัง'), primary: true, requires: { lines: true } },
      voidT(['draft', 'received'], ['manager']),
    ],
  },
};

const supplierBill: DocTypeDef = {
  id: 'supplier_bill',
  label: L('Supplier bill', 'ใบแจ้งหนี้ผู้ขาย'),
  printTitle: L('Supplier bill (record)', 'บันทึกใบกำกับภาษีซื้อ'),
  direction: 'purchase',
  numbering: { prefix: 'BL' },
  effects: ['payable'],
  convertsTo: ['supplier_credit'],
  priceMode: 'exclusive',
  defaultDueDays: 30,
  dueLabel: L('Pay by', 'ครบกำหนดจ่าย'),
  fields: [
    { key: 'supplier_ref', type: 'text', label: L("Supplier's invoice no.", 'เลขที่ใบกำกับภาษีของผู้ขาย') },
  ],
  workflow: {
    initial: 'draft',
    states: [
      { id: 'draft', label: L('Draft', 'ร่าง'), phase: 'draft', tone: 'neutral', ownerRole: 'accounts' },
      { id: 'recorded', label: L('Recorded', 'บันทึกแล้ว'), phase: 'issued', tone: 'info', ownerRole: 'accounts', hint: L('Pay the supplier by the due date.', 'จ่ายเงินภายในวันครบกำหนด') },
      { id: 'paid', label: L('Paid', 'จ่ายแล้ว'), phase: 'closed', tone: 'success' },
      voidState,
    ],
    transitions: [
      { id: 'record', from: ['draft'], to: 'recorded', label: L('Record bill', 'บันทึกใบแจ้งหนี้'), primary: true,
        roles: ['accounts', 'manager'], requires: { lines: true, fields: ['supplier_ref'] } },
      ...paidTransitions('recorded'),
      voidT(['draft', 'recorded'], ['accounts', 'manager']),
    ],
  },
};

// ─────────────────────────────── Jobs ───────────────────────────────

const installWorkflow: WorkflowDef<'open' | 'done' | 'cancelled'> = {
  initial: 'inquiry',
  states: [
    { id: 'inquiry', label: L('Inquiry', 'สอบถาม'), phase: 'open', ownerRole: 'sales', tone: 'neutral',
      hint: L('Capture what the customer needs and where the site is.', 'บันทึกความต้องการและสถานที่หน้างาน') },
    { id: 'survey', label: L('Site survey', 'สำรวจหน้างาน'), phase: 'open', ownerRole: 'sales', tone: 'info',
      hint: L('Measure the site, attach photos and a sketch, then quote.', 'วัดหน้างาน แนบรูปและแบบร่าง แล้วเสนอราคา') },
    { id: 'quoted', label: L('Quoted', 'เสนอราคาแล้ว'), phase: 'open', ownerRole: 'sales', tone: 'info',
      hint: L('Follow up with the customer. Convert the quotation when they agree.', 'ติดตามลูกค้า เมื่อตกลงให้แปลงเป็นใบสั่งขาย') },
    { id: 'confirmed', label: L('Confirmed', 'ยืนยันแล้ว'), phase: 'open', ownerRole: 'manager', tone: 'progress',
      hint: L('Check materials. Order anything that is short.', 'ตรวจสอบวัสดุ สั่งซื้อส่วนที่ขาด') },
    { id: 'production', label: L('Cutting', 'ตัด/ผลิต'), phase: 'open', ownerRole: 'workshop', tone: 'progress',
      hint: L('Cut sheets to the ordered lengths.', 'ตัดแผ่นตามความยาวที่สั่ง') },
    { id: 'ready', label: L('Ready', 'พร้อมส่ง'), phase: 'open', ownerRole: 'manager', tone: 'progress',
      hint: L('Schedule delivery and the install crew.', 'นัดวันส่งของและทีมติดตั้ง') },
    { id: 'delivering', label: L('Delivery & install', 'ส่งของ/ติดตั้ง'), phase: 'open', ownerRole: 'installer', tone: 'progress',
      hint: L('Deliver, install, and photograph the finished work.', 'ส่งของ ติดตั้ง และถ่ายรูปงานที่เสร็จ') },
    { id: 'completed', label: L('Completed', 'เสร็จสิ้น'), phase: 'done', tone: 'success' },
    { id: 'lost', label: L('Lost', 'ไม่ได้งาน'), phase: 'cancelled', tone: 'danger' },
  ],
  transitions: [
    { id: 'survey', from: ['inquiry'], to: 'survey', label: L('Schedule site survey', 'นัดสำรวจหน้างาน'), primary: true,
      requires: { fields: ['site_address'] },
      actions: [{ createTask: { title: L('Survey & measure the site', 'สำรวจและวัดหน้างาน'), role: 'sales', dueInDays: 2 } }] },
    { id: 'quoted', from: ['inquiry', 'survey'], to: 'quoted', label: L('Quotation sent', 'ส่งใบเสนอราคาแล้ว'), primary: true, auto: true,
      requires: { documents: [{ type: 'quotation', phase: ['issued', 'closed'] }] } },
    { id: 'confirm', from: ['inquiry', 'survey', 'quoted'], to: 'confirmed', label: L('Customer confirmed', 'ลูกค้ายืนยัน'), primary: true, auto: true,
      requires: { documents: [{ type: 'sales_order', phase: ['issued', 'closed'] }] },
      actions: [{ notifyRole: 'manager', message: L('Order confirmed — please check materials.', 'ยืนยันคำสั่งซื้อแล้ว กรุณาตรวจสอบวัสดุ') }] },
    { id: 'produce', from: ['confirmed'], to: 'production', label: L('Start cutting', 'เริ่มตัดแผ่น'), primary: true,
      roles: ['workshop', 'manager'],
      actions: [{ createTask: { title: L('Cut sheets per the sales order', 'ตัดแผ่นตามใบสั่งขาย'), role: 'workshop', dueInDays: 1 } }] },
    { id: 'ready', from: ['production'], to: 'ready', label: L('Mark ready', 'พร้อมส่ง'), primary: true, requires: { tasksDone: true } },
    { id: 'dispatch', from: ['ready'], to: 'delivering', label: L('Dispatch', 'ออกส่งของ'), primary: true,
      requires: { fields: ['delivery_date'] },
      actions: [{ createTask: { title: L('Deliver, install and photograph the result', 'ส่งของ ติดตั้ง และถ่ายรูปผลงาน'), role: 'installer', dueInDays: 0 } }] },
    { id: 'complete', from: ['delivering'], to: 'completed', label: L('Complete job', 'ปิดงาน'), primary: true,
      requires: { tasksDone: true, documents: [{ type: 'tax_invoice', phase: ['issued', 'closed'] }] } },
    { id: 'lose', from: ['inquiry', 'survey', 'quoted'], to: 'lost', label: L('Mark lost', 'ไม่ได้งาน'), requireReason: true, tone: 'danger' },
    { id: 'reopen', from: ['lost'], to: 'inquiry', label: L('Reopen', 'เปิดงานใหม่') },
  ],
};

const installJob: JobTypeDef = {
  id: 'install',
  label: L('Supply & install', 'ขายพร้อมติดตั้ง'),
  numbering: { prefix: 'J' },
  documentTypes: ['quotation', 'sales_order', 'purchase_order', 'tax_invoice'],
  fields: [
    { key: 'site_address', type: 'text', label: L('Site address', 'ที่อยู่หน้างาน'), summary: true },
    { key: 'work_type', type: 'select', label: L('Work type', 'ประเภทงาน'), summary: true, options: [
      { value: 'new_roof', label: L('New roof', 'หลังคาใหม่') },
      { value: 'reroof', label: L('Re-roof', 'เปลี่ยนหลังคา') },
      { value: 'cladding', label: L('Wall cladding', 'ผนังเมทัลชีท') },
      { value: 'gutter', label: L('Gutter / flashing', 'รางน้ำ/ครอบ') },
      { value: 'repair', label: L('Repair', 'ซ่อม') },
    ] },
    { key: 'area_sqm', type: 'number', label: L('Roof area', 'พื้นที่หลังคา'), unit: 'm²' },
    { key: 'color', type: 'text', label: L('Colour', 'สี') },
    { key: 'survey_date', type: 'date', label: L('Survey date', 'วันสำรวจ') },
    { key: 'delivery_date', type: 'date', label: L('Delivery / install date', 'วันส่งของ/ติดตั้ง'), summary: true },
    { key: 'requirements', type: 'longtext', label: L('Requirements', 'รายละเอียดความต้องการ') },
  ],
  workflow: installWorkflow,
};

const supplyJob: JobTypeDef = {
  id: 'supply',
  label: L('Material supply', 'ขายส่งวัสดุ'),
  numbering: { prefix: 'S' },
  documentTypes: ['quotation', 'sales_order', 'tax_invoice'],
  fields: [
    { key: 'delivery_address', type: 'text', label: L('Deliver to', 'ส่งที่'), summary: true },
    { key: 'delivery_date', type: 'date', label: L('Delivery date', 'วันส่งของ'), summary: true },
  ],
  workflow: {
    initial: 'inquiry',
    states: [
      { id: 'inquiry', label: L('Inquiry', 'สอบถาม'), phase: 'open', ownerRole: 'sales', tone: 'neutral' },
      { id: 'quoted', label: L('Quoted', 'เสนอราคาแล้ว'), phase: 'open', ownerRole: 'sales', tone: 'info' },
      { id: 'confirmed', label: L('Confirmed', 'ยืนยันแล้ว'), phase: 'open', ownerRole: 'workshop', tone: 'progress',
        hint: L('Pick and load the order.', 'จัดของและขึ้นรถ') },
      { id: 'delivered', label: L('Delivered', 'ส่งแล้ว'), phase: 'done', tone: 'success' },
      { id: 'lost', label: L('Lost', 'ไม่ได้งาน'), phase: 'cancelled', tone: 'danger' },
    ],
    transitions: [
      { id: 'quoted', from: ['inquiry'], to: 'quoted', label: L('Quotation sent', 'ส่งใบเสนอราคาแล้ว'), primary: true, auto: true,
        requires: { documents: [{ type: 'quotation', phase: ['issued', 'closed'] }] } },
      { id: 'confirm', from: ['inquiry', 'quoted'], to: 'confirmed', label: L('Customer confirmed', 'ลูกค้ายืนยัน'), primary: true, auto: true,
        requires: { documents: [{ type: 'sales_order', phase: ['issued', 'closed'] }] } },
      { id: 'deliver', from: ['confirmed'], to: 'delivered', label: L('Delivered', 'ส่งของแล้ว'), primary: true, auto: true,
        requires: { documents: [{ type: 'tax_invoice', phase: ['issued', 'closed'] }] } },
      { id: 'lose', from: ['inquiry', 'quoted'], to: 'lost', label: L('Mark lost', 'ไม่ได้งาน'), requireReason: true, tone: 'danger' },
      { id: 'reopen', from: ['lost'], to: 'inquiry', label: L('Reopen', 'เปิดงานใหม่') },
    ],
  },
};

// ─────────────────────────────── Pack ───────────────────────────────

export const sheetMetalPack: Pack = {
  id: 'sheet-metal',
  label: L('Metal sheet & roofing supplier', 'ร้านเมทัลชีทและหลังคา'),
  version: '0.1.0',
  roles: [
    { id: 'owner', label: L('Owner', 'เจ้าของ'), capabilities: ['all'] },
    { id: 'manager', label: L('Manager', 'ผู้จัดการ'), capabilities: ['jobs.write', 'documents.write', 'documents.issue', 'documents.void', 'money.write', 'stock.write', 'parties.write', 'items.write', 'reports.read', 'ledger.write', 'approve'] },
    { id: 'sales', label: L('Sales', 'ฝ่ายขาย'), capabilities: ['jobs.write', 'documents.write', 'documents.issue', 'parties.write'] },
    { id: 'accounts', label: L('Accounts', 'ฝ่ายบัญชี'), capabilities: ['documents.write', 'documents.issue', 'documents.void', 'money.write', 'parties.write', 'reports.read', 'ledger.write'] },
    { id: 'workshop', label: L('Workshop / stock', 'ฝ่ายผลิต/คลัง'), capabilities: ['jobs.write', 'stock.write', 'documents.write', 'documents.issue'] },
    { id: 'installer', label: L('Install crew', 'ทีมติดตั้ง'), capabilities: ['jobs.write'] },
  ],
  jobTypes: [installJob, supplyJob],
  documentTypes: [quotation, salesOrder, taxInvoice, creditNote, debitNote, purchaseOrder, goodsReceipt, supplierBill, supplierCredit],
  measureTemplates: [
    {
      id: 'sheet_length',
      label: L('Pieces × length', 'จำนวนแผ่น × ความยาว'),
      inputs: [
        { key: 'pieces', label: L('Pieces', 'แผ่น'), step: 1 },
        { key: 'length', label: L('Length', 'ยาว'), unit: 'm', step: 0.01 },
      ],
      qty: 'pieces * length',
      describe: '{pieces} × {length} m',
    },
    {
      id: 'area',
      label: L('Pieces × width × length', 'จำนวน × กว้าง × ยาว'),
      inputs: [
        { key: 'pieces', label: L('Pieces', 'แผ่น'), step: 1 },
        { key: 'width', label: L('Width', 'กว้าง'), unit: 'm', step: 0.01 },
        { key: 'length', label: L('Length', 'ยาว'), unit: 'm', step: 0.01 },
      ],
      qty: 'pieces * width * length',
      describe: '{pieces} × {width} × {length} m',
    },
  ],
  partyFields: [
    { key: 'line_id', type: 'text', label: L('LINE ID', 'ไลน์ไอดี') },
    { key: 'customer_type', type: 'select', label: L('Customer type', 'ประเภทลูกค้า'), options: [
      { value: 'contractor', label: L('Contractor', 'ผู้รับเหมา') },
      { value: 'homeowner', label: L('Homeowner', 'เจ้าของบ้าน') },
      { value: 'reseller', label: L('Shop / reseller', 'ร้านค้า') },
      { value: 'developer', label: L('Developer', 'โครงการ') },
    ] },
  ],
  itemFields: [
    { key: 'thickness_mm', type: 'number', label: L('Thickness', 'ความหนา'), unit: 'mm', summary: true },
    { key: 'color', type: 'text', label: L('Colour', 'สี'), summary: true },
    { key: 'profile', type: 'select', label: L('Profile', 'ลอน'), options: [
      { value: 'corrugated', label: L('Corrugated', 'ลอนลูกฟูก') },
      { value: 'trapezoid', label: L('Trapezoid', 'ลอนสี่เหลี่ยม') },
      { value: 'tile', label: L('Tile profile', 'ลอนกระเบื้อง') },
      { value: 'flat', label: L('Flat', 'แผ่นเรียบ') },
    ] },
  ],
  locations: [
    { id: 'wh', name: L('Main warehouse', 'คลังหลัก'), kind: 'internal' },
    { id: 'yard', name: L('Cutting yard', 'ลานตัด'), kind: 'internal' },
  ],
  defaultLocation: 'wh',
  units: [
    { id: 'm', label: L('m', 'เมตร') },
    { id: 'm2', label: L('m²', 'ตร.ม.') },
    { id: 'pc', label: L('pc', 'ชิ้น') },
    { id: 'sheet', label: L('sheet', 'แผ่น') },
    { id: 'box', label: L('box', 'กล่อง') },
    { id: 'roll', label: L('roll', 'ม้วน') },
    { id: 'kg', label: L('kg', 'กก.') },
    { id: 'set', label: L('set', 'ชุด') },
    { id: 'trip', label: L('trip', 'เที่ยว') },
    { id: 'job', label: L('job', 'งาน') },
  ],
  paymentMethods: [
    { id: 'transfer', label: L('Bank transfer', 'โอนเงิน') },
    { id: 'promptpay', label: L('PromptPay', 'พร้อมเพย์') },
    { id: 'cash', label: L('Cash', 'เงินสด'), cash: true },
    { id: 'cheque', label: L('Cheque', 'เช็ค') },
    { id: 'card', label: L('Card', 'บัตร') },
  ],
};

export default sheetMetalPack;
