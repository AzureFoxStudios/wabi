/**
 * Demo data for the sheet-metal pack. Everything goes through the public
 * command API, so the demo exercises the same code paths as real use and the
 * journal tells a believable story (who did what, when).
 *
 * All names, tax IDs and addresses are fictional.
 */
import type { Document } from '@sabi/core';

export interface SeedApi {
  /** Run a command as the given username ('system' for automation/setup). */
  run(username: string, command: string, input: Record<string, unknown>): any;
  /** Set the clock: `daysAgo` before now, at local hour:minute. */
  clock(daysAgo: number, hour?: number, minute?: number): void;
  /** Read a document (for amounts computed by the server). */
  document(id: string): Document;
  /** Open task ids on a subject. */
  openTasks(subjectType: string, subjectId: string): string[];
}

/** Build a checksum-valid 13-digit Thai tax ID from a 12-digit stem. */
export function thaiTaxId(stem12: string): string {
  const d = stem12.split('').map(Number);
  const sum = d.reduce((acc, n, i) => acc + n * (13 - i), 0);
  return stem12 + String((11 - (sum % 11)) % 10);
}

export const DEMO_USERS = [
  { username: 'arun', name: 'Arun Wongsa', role: 'manager' },
  { username: 'nok', name: 'Nok Chaiyaporn', role: 'sales' },
  { username: 'pim', name: 'Pim Rattana', role: 'accounts' },
  { username: 'somchai', name: 'Somchai Kaewdee', role: 'workshop' },
  { username: 'dang', name: 'Dang Srisawat', role: 'installer' },
] as const;

const WHT_RATE: Record<string, number> = { service: 0.03, transport: 0.01 };

/** WHT a juristic customer would withhold on this invoice (demo convenience). */
function whtOn(doc: Document): number {
  return doc.totals.whtBases.reduce((a, b) => a + Math.round(b.base * (WHT_RATE[b.category] ?? 0)), 0);
}

export function demoSeed(api: SeedApi): void {
  const { run } = api;
  const ids: Record<string, string> = {};
  const uid: Record<string, string> = {};
  let j1 = '', qt1 = '', so1 = '', iv1 = '', po1 = '', gr1 = '', bl1 = '', s0 = '', so0 = '', iv0 = '', j3 = '', qt3 = '', so3 = '', po3 = '', j2 = '', qt2 = '', j4 = '', qt4 = '';
  const steps: { at: [number, number, number]; order: number; fn: () => void }[] = [];
  const step = (daysAgo: number, hour: number, minute: number | (() => void), fn?: () => void) => {
    if (typeof minute === 'function') {
      fn = minute;
      minute = 0;
    }
    steps.push({ at: [daysAgo, hour, minute], order: steps.length, fn: fn! });
  };
  // ── Company, people ──────────────────────────────────────────────
  step(62, 8, 30, () => {
    run('owner', 'company.update', {
      name: 'Thaweesap Metal Sheet Ltd., Part.',
      taxId: thaiTaxId('010355801234'),
      phone: '02-123-4567',
      email: 'sales@thaweesap.example',
      address: { line1: '88/8 Moo 4, Bang Kruai–Sai Noi Rd.', district: 'Bang Bua Thong', province: 'Nonthaburi', postcode: '11110' },
      fields: { branch_code: '00000', vat_registered: true, promptpay_id: thaiTaxId('010355801234') },
    });
    for (const u of DEMO_USERS) uid[u.username] = run('owner', 'user.create', { ...u, locale: 'th' }).id;

    // ── Parties ──────────────────────────────────────────────────────
    const party = (by: string, input: Record<string, unknown>) => run(by, 'party.create', input).id as string;
    ids.baanSuan = party('nok', {
      kind: 'organization', name: 'Baan Suan Housing Co., Ltd.', roles: ['customer'], taxId: thaiTaxId('010556012345'),
      phone: '02-555-0101', email: 'purchasing@baansuan.example', paymentTermsDays: 30, creditLimit: 50_000_000,
      address: { line1: '12 Soi Ratchaphruek 5', district: 'Taling Chan', province: 'Bangkok', postcode: '10170' },
      fields: { branch_code: '00000', vat_registered: true, customer_type: 'developer', line_id: '@baansuan' },
    });
    ids.wichai = party('nok', {
      kind: 'person', name: 'Khun Wichai (site engineer)', roles: ['contact'], parentId: ids.baanSuan, phone: '081-234-5678',
    });
    ids.malee = party('nok', {
      kind: 'person', name: 'Malee Srisuk', roles: ['customer'], phone: '089-765-4321',
      address: { line1: '45/2 Moo 7, Soi Wat Lat Pla Duk', district: 'Bang Bua Thong', province: 'Nonthaburi', postcode: '11110' },
      fields: { customer_type: 'homeowner', line_id: 'malee.s' },
    });
    ids.thaiCoil = party('arun', {
      kind: 'organization', name: 'Thai Coil Steel Supply Co., Ltd.', roles: ['supplier'], taxId: thaiTaxId('010554098765'),
      phone: '02-777-8888', paymentTermsDays: 30,
      address: { line1: '99 Bangna–Trat Km. 18', district: 'Bang Phli', province: 'Samut Prakan', postcode: '10540' },
      fields: { branch_code: '00000', vat_registered: true },
    });
    ids.bkkFastener = party('arun', {
      kind: 'organization', name: 'BKK Fastener Trading Co., Ltd.', roles: ['supplier'], taxId: thaiTaxId('010555043210'),
      phone: '02-333-2211', paymentTermsDays: 15,
      address: { line1: '7 Charoen Krung Rd.', district: 'Samphanthawong', province: 'Bangkok', postcode: '10100' },
      fields: { branch_code: '00000', vat_registered: true },
    });
    ids.chokchai = party('nok', {
      kind: 'organization', name: 'Chokchai Construction Ltd., Part.', roles: ['customer'], taxId: thaiTaxId('014355007788'),
      phone: '035-222-333', paymentTermsDays: 30,
      address: { line1: '3/1 Rojana Industrial Park Rd.', district: 'U Thai', province: 'Phra Nakhon Si Ayutthaya', postcode: '13210' },
      fields: { branch_code: '00001', vat_registered: true, customer_type: 'contractor' },
    });
    ids.somsak = party('nok', {
      kind: 'organization', name: 'Somsak Hardware Ltd., Part.', roles: ['customer'], taxId: thaiTaxId('012355009911'),
      phone: '02-591-2020', paymentTermsDays: 30,
      address: { line1: '201 Rattanathibet Rd.', district: 'Mueang Nonthaburi', province: 'Nonthaburi', postcode: '11000' },
      fields: { branch_code: '00000', vat_registered: true, customer_type: 'reseller' },
    });

    // ── Items (prices in satang) ─────────────────────────────────────
    const item = (input: Record<string, unknown>) => run('arun', 'item.create', input).id as string;
    ids.ms035 = item({ sku: 'MS-035-BLU', name: 'Metal sheet 0.35 mm, blue, corrugated', kind: 'stock', uom: 'm', salePrice: 16500, costPrice: 12800,
      measureTemplate: 'sheet_length', fields: { thickness_mm: 0.35, color: 'Blue', profile: 'corrugated' }, reorderPoint: 200 });
    ids.ms040 = item({ sku: 'MS-040-RED', name: 'Metal sheet 0.40 mm, red, tile profile', kind: 'stock', uom: 'm', salePrice: 19500, costPrice: 15200,
      measureTemplate: 'sheet_length', fields: { thickness_mm: 0.4, color: 'Red', profile: 'tile' }, reorderPoint: 150 });
    ids.zl047 = item({ sku: 'ZL-047', name: 'Zincalume 0.47 mm, trapezoid', kind: 'stock', uom: 'm', salePrice: 23500, costPrice: 18500,
      measureTemplate: 'sheet_length', fields: { thickness_mm: 0.47, color: 'Natural', profile: 'trapezoid' }, reorderPoint: 150 });
    ids.ridge = item({ sku: 'RG-RED', name: 'Ridge cap, red', kind: 'stock', uom: 'pc', salePrice: 18000, costPrice: 12000, fields: { color: 'Red' }, reorderPoint: 30 });
    ids.screw = item({ sku: 'SC-TEK-12', name: 'Roofing screws 12×1", box of 100', kind: 'stock', uom: 'box', salePrice: 35000, costPrice: 24000, fields: {}, reorderPoint: 20 });
    ids.purlin = item({ sku: 'C-100-23', name: 'C-channel purlin 100×50×2.3 mm, 6 m', kind: 'stock', uom: 'pc', salePrice: 52000, costPrice: 43000, fields: {}, reorderPoint: 40 });
    ids.sealant = item({ sku: 'SL-PU', name: 'PU sealant tube', kind: 'stock', uom: 'pc', salePrice: 12000, costPrice: 8500, fields: {}, reorderPoint: 24 });
    ids.install = item({ sku: 'SVC-INSTALL', name: 'Roof installation labour', kind: 'service', uom: 'm2', salePrice: 12000, costPrice: 0, whtCategory: 'service' });
    ids.delivery = item({ sku: 'SVC-DELIVERY', name: 'Delivery by 6-wheel truck', kind: 'service', uom: 'trip', salePrice: 150000, costPrice: 0, whtCategory: 'transport' });

    // Opening stock.
    const opening: [string, number, string?][] = [
      [ids.ms035, 850], [ids.ms040, 620], [ids.zl047, 120], [ids.ridge, 90], [ids.screw, 60], [ids.purlin, 25], [ids.sealant, 48], [ids.ms035, 150, 'yard'],
    ];
    for (const [itemId, qty, location] of opening) run('somchai', 'stock.adjust', { itemId, qty, location, reason: 'Opening balance' });

    // ── Purchasing history: screws from BKK Fastener (bill still unpaid) ──
  });
  step(24, 10, () => {
    po1 = run('arun', 'document.create', { type: 'purchase_order', partyId: ids.bkkFastener, lines: [{ itemId: ids.screw, qty: 40 }, { itemId: ids.sealant, qty: 24 }] }).id;
    run('arun', 'document.transition', { id: po1, transition: 'order' });
  });
  step(21, 14, () => {
    gr1 = run('somchai', 'document.create', { type: 'goods_receipt', sourceId: po1 }).id;
    run('somchai', 'document.transition', { id: gr1, transition: 'receive' });
  });
  step(20, 9, 15, () => {
    bl1 = run('pim', 'document.create', { type: 'supplier_bill', sourceId: gr1, fields: { supplier_ref: 'BKF-2026/0918' } }).id;
    run('pim', 'document.transition', { id: bl1, transition: 'record' });

    // ── J1: Baan Suan warehouse re-roof — completed and paid ─────────
  });
  step(45, 9, 5, () => {
    j1 = run('nok', 'job.create', {
      type: 'install', title: 'Warehouse re-roof, Taling Chan', partyId: ids.baanSuan, contactId: ids.wichai, ownerId: uid.nok,
      fields: { site_address: '12 Soi Ratchaphruek 5, Taling Chan', work_type: 'reroof', area_sqm: 320, color: 'Red' },
    }).id;
    run('nok', 'message.post', { subjectType: 'job', subjectId: j1, body: 'Khun Wichai called: old asbestos roof on the rear warehouse, about 320 m². Wants red tile profile to match the office.' });
    run('nok', 'job.transition', { id: j1, transition: 'survey' });
  });
  step(43, 15, 40, () => {
    run('nok', 'job.update', { id: j1, fields: { survey_date: isoDaysAgo(43) } });
    completeOpenTasks(api, 'nok', j1);
    run('nok', 'message.post', { subjectType: 'job', subjectId: j1, body: 'Surveyed. 40 sheets × 8.00 m per side is enough, purlins are fine. Ridge 18 m.' });
  });
  step(42, 11, () => {
    qt1 = run('nok', 'document.create', {
      type: 'quotation', jobId: j1, lines: [
        { itemId: ids.ms040, measures: { pieces: 40, length: 8 } },
        { itemId: ids.ridge, qty: 20 },
        { itemId: ids.screw, qty: 8 },
        { itemId: ids.install, qty: 320, discountPct: 5 },
        { itemId: ids.delivery, qty: 1 },
      ], notes: 'Price includes removal of old sheets. Asbestos disposal by customer.',
    }).id;
    run('nok', 'document.transition', { id: qt1, transition: 'send' });
  });
  step(38, 16, 20, () => {
    so1 = run('nok', 'document.create', { type: 'sales_order', sourceId: qt1 }).id;
    run('arun', 'document.transition', { id: so1, transition: 'confirm' });
  });
  step(36, 8, () => {
    run('somchai', 'job.transition', { id: j1, transition: 'produce' });
    run('somchai', 'stock.issue', { jobId: j1, itemId: ids.sealant, qty: 6, note: 'Sealant for ridge & flashing (not billed)' });
  });
  step(35, 17, () => {
    completeOpenTasks(api, 'somchai', j1);
    run('somchai', 'message.post', { subjectType: 'job', subjectId: j1, body: 'All 40 sheets cut and bundled in the yard. @arun ready for scheduling.' });
    run('arun', 'job.transition', { id: j1, transition: 'ready' });
    run('arun', 'job.update', { id: j1, fields: { delivery_date: isoDaysAgo(33) } });
  });
  step(33, 7, 30, () => {
    run('arun', 'job.transition', { id: j1, transition: 'dispatch' });
    iv1 = run('pim', 'document.create', { type: 'tax_invoice', sourceId: so1 }).id;
    run('pim', 'document.transition', { id: iv1, transition: 'issue' });
    run('arun', 'document.transition', { id: so1, transition: 'fulfil' });
  });
  step(32, 17, 45, () => {
    run('dang', 'message.post', { subjectType: 'job', subjectId: j1, body: 'Installed and cleaned up. Khun Wichai signed the delivery copy.' });
    completeOpenTasks(api, 'dang', j1);
    run('arun', 'job.transition', { id: j1, transition: 'complete' });
  });
  step(6, 10, 30, () => {
    const d1 = api.document(iv1);
    const wht1 = whtOn(d1);
    run('pim', 'payment.record', {
      direction: 'in', partyId: ids.baanSuan, method: 'transfer', amount: d1.totals.total - wht1, whtAmount: wht1, whtCategory: 'service',
      whtCertificate: 'BS-50T-0412', reference: 'KBank transfer', allocations: [{ documentId: iv1, amount: d1.totals.total }],
    });

    // ── Overdue: Somsak Hardware bulk supply, invoiced 40 days ago, unpaid ──
  });
  step(41, 13, () => {
    s0 = run('nok', 'job.create', { type: 'supply', title: 'Monthly stock order', partyId: ids.somsak, fields: { delivery_address: 'Shop front, Rattanathibet Rd.' } }).id;
    so0 = run('nok', 'document.create', { type: 'sales_order', jobId: s0, lines: [
      { itemId: ids.ms035, measures: { pieces: 30, length: 4 } }, { itemId: ids.screw, qty: 6 },
    ] }).id;
    run('arun', 'document.transition', { id: so0, transition: 'confirm' });
  });
  step(40, 9, () => {
    iv0 = run('pim', 'document.create', { type: 'tax_invoice', sourceId: so0 }).id;
    run('pim', 'document.transition', { id: iv0, transition: 'issue' });
    run('arun', 'document.transition', { id: so0, transition: 'fulfil' });

    // ── J3: Chokchai cladding — confirmed, zincalume short, PO waiting ──
  });
  // Two sheets from the monthly order came back bent: correct the tax invoice with a credit note.
  step(38, 14, () => {
    run('somchai', 'message.post', { subjectType: 'job', subjectId: s0, body: 'Somsak returned 2 sheets bent during unloading. Back in the yard, not resellable as new. @pim please credit them.' });
    const cn = run('pim', 'document.create', { type: 'credit_note', sourceId: iv0 }).id;
    run('pim', 'document.update', { id: cn, lines: [{ itemId: ids.ms035, measures: { pieces: 2, length: 4 } }], fields: { goods_returned: true, reason: 'Two sheets bent during unloading, returned by the customer' } });
    run('pim', 'document.transition', { id: cn, transition: 'issue' });
  });
  step(10, 10, () => {
    j3 = run('nok', 'job.create', {
      type: 'install', title: 'Factory wall cladding, Rojana', partyId: ids.chokchai, ownerId: uid.arun, dueDate: isoDaysAgo(-12),
      fields: { site_address: 'Rojana Industrial Park, plot C-14', work_type: 'cladding', area_sqm: 380, color: 'Natural' },
    }).id;
  });
  step(7, 14, () => {
    qt3 = run('nok', 'document.create', { type: 'quotation', jobId: j3, lines: [
      { itemId: ids.zl047, measures: { pieces: 60, length: 6 } },
      { itemId: ids.purlin, qty: 30 },
      { itemId: ids.screw, qty: 10 },
      { itemId: ids.install, qty: 380 },
      { itemId: ids.delivery, qty: 2 },
    ] }).id;
    run('nok', 'document.transition', { id: qt3, transition: 'send' });
  });
  step(4, 11, () => {
    so3 = run('nok', 'document.create', { type: 'sales_order', sourceId: qt3 }).id;
    run('arun', 'document.transition', { id: so3, transition: 'confirm' });
  });
  step(4, 11, 30, () => {
    run('somchai', 'message.post', { subjectType: 'job', subjectId: j3, body: '@arun we only have 120 m of ZL-047 and 25 purlins. Need 360 m and 30.' });
    po3 = run('arun', 'document.create', { type: 'purchase_order', partyId: ids.thaiCoil, jobId: j3, dueDate: isoDaysAgo(-1), lines: [
      { itemId: ids.zl047, measures: { pieces: 50, length: 6 } }, { itemId: ids.purlin, qty: 10 },
    ] }).id;
    run('arun', 'document.transition', { id: po3, transition: 'order' });
    run('arun', 'message.post', { subjectType: 'job', subjectId: j3, body: 'Ordered 300 m ZL-047 + 10 purlins from Thai Coil, they promise delivery tomorrow morning. @somchai please receive and check thickness.' });
    run('arun', 'task.create', { subjectType: 'job', subjectId: j3, title: 'Confirm install dates with Chokchai site manager', assigneeId: uid.nok, due: isoDaysAgo(-1) });

    // ── J2: Malee house roof — quoted, discussion in progress ────────
  });
  step(6, 9, 20, () => {
    j2 = run('nok', 'job.create', {
      type: 'install', title: 'House roof, Lat Pla Duk', partyId: ids.malee, ownerId: uid.nok,
      fields: { site_address: '45/2 Moo 7, Soi Wat Lat Pla Duk', work_type: 'new_roof', area_sqm: 140, color: 'Blue', requirements: 'Two-storey house, hip roof. Wants quiet sheets (PU foam backing optional).' },
    }).id;
    run('nok', 'job.transition', { id: j2, transition: 'survey' });
  });
  step(4, 16, () => {
    completeOpenTasks(api, 'nok', j2);
    run('nok', 'message.post', { subjectType: 'job', subjectId: j2, body: 'Measured: longest run 7.50 m. @somchai can we cut 7.5 m in one piece so there is no overlap? Khun Malee is worried about leaks.' });
  });
  step(4, 16, 45, () => {
    run('somchai', 'message.post', { subjectType: 'job', subjectId: j2, body: 'Yes, 7.5 m is fine for 0.35 blue. Truck needs 8 m clearance at the gate though.' });
  });
  step(3, 10, () => {
    qt2 = run('nok', 'document.create', { type: 'quotation', jobId: j2, lines: [
      { itemId: ids.ms035, measures: { pieces: 22, length: 7.5 } },
      { itemId: ids.ridge, qty: 12, description: 'Ridge cap, blue' },
      { itemId: ids.screw, qty: 4 },
      { itemId: ids.install, qty: 140 },
      { itemId: ids.delivery, qty: 1 },
    ], notes: 'Valid 15 days. 50% deposit on confirmation.' }).id;
    run('nok', 'document.transition', { id: qt2, transition: 'send' });
    run('nok', 'task.create', { subjectType: 'job', subjectId: j2, title: 'Call Khun Malee about the quotation', assigneeId: uid.nok, due: isoDaysAgo(0) });

    // ── J4: Somsak supply — draft quote with discount awaiting approval ──
  });
  step(1, 15, 10, () => {
    j4 = run('nok', 'job.create', { type: 'supply', title: 'Bulk red sheet for resale', partyId: ids.somsak, fields: { delivery_address: 'Shop front, Rattanathibet Rd.' } }).id;
    qt4 = run('nok', 'document.create', { type: 'quotation', jobId: j4, lines: [
      { itemId: ids.ms040, measures: { pieces: 80, length: 5 }, discountPct: 12 },
      { itemId: ids.ridge, qty: 30, discountPct: 12 },
    ], notes: 'Volume price for 400 m.' }).id;
    run('nok', 'approval.request', { subjectType: 'document', subjectId: qt4, transitionId: 'send', note: 'Somsak orders every month; matches their other supplier.' });
    run('nok', 'message.post', { subjectType: 'job', subjectId: j4, body: '@arun asked for 12% to match their other supplier. Can you approve?' });

    // A brand-new inquiry (today).
  });
  step(0, 8, 40, () => {
    run('nok', 'job.create', { type: 'install', title: 'Carport roof', partyId: ids.malee, fields: { work_type: 'new_roof', requirements: "Neighbour of Khun Malee; wants a 3×6 m carport. Call back after 5 pm." } });
  });

  // Run in chronological order so the journal reads like real history.
  const key = (a: [number, number, number]) => -a[0] * 1440 + a[1] * 60 + a[2];
  steps.sort((a, b) => key(a.at) - key(b.at) || a.order - b.order);
  for (const st of steps) {
    api.clock(...st.at);
    st.fn();
  }
}

function completeOpenTasks(api: SeedApi, username: string, jobId: string) {
  for (const id of api.openTasks('job', jobId)) api.run(username, 'task.complete', { id });
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() + 7 * 3600_000 - days * 86400_000);
  return d.toISOString().slice(0, 10);
}
