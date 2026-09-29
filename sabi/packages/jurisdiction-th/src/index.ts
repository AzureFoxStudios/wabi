/**
 * Thailand jurisdiction adapter.
 *
 * Encodes Thai VAT (effective-dated), withholding tax categories, full tax
 * invoice particulars (Revenue Code s.86/4), head-office/branch identity,
 * 13-digit tax ID checksum, Buddhist-era dates, baht text, PromptPay QR and a
 * simplified SME chart of accounts.
 *
 * NOT certified by the Revenue Department. See sabi/docs/03-research.md.
 */
import { roundHalfUp } from '@sabi/core';
import type {
  Jurisdiction, TaxCodeDef, Issue, IssueContext, Document, Party, PartySnapshot, Locale, IsoDate,
  WhtSuggestion, AccountDef,
} from '@sabi/core';
import { bahtTextEn, bahtTextTh } from './bahttext.ts';
import { promptPayPayload } from './promptpay.ts';

export { bahtTextEn, bahtTextTh, thaiNumber, englishNumber } from './bahttext.ts';
export { promptPayPayload, crc16, normalizeProxy } from './promptpay.ts';

/** Last date covered by an enacted/approved reduced-rate decree. Update when a new decree is published. */
export const VAT_REDUCED_RATE_KNOWN_UNTIL = '2027-09-30';

const TAX_CODES: TaxCodeDef[] = [
  {
    code: 'VAT7',
    label: { en: 'VAT 7%', th: 'ภาษีมูลค่าเพิ่ม 7%' },
    kind: 'standard',
    rates: [
      // Statutory 10%, reduced to 7% by successive Royal Decrees (No. 799 to 30 Sep 2026;
      // Cabinet approved extension to 30 Sep 2027 on 27 Jul 2026).
      { from: '1992-01-01', to: VAT_REDUCED_RATE_KNOWN_UNTIL, rate: 0.07 },
      { from: '2027-10-01', rate: 0.1 },
    ],
  },
  { code: 'VAT0', label: { en: 'VAT 0% (zero-rated)', th: 'ภาษี 0%' }, kind: 'zero', rates: [{ from: '1992-01-01', rate: 0 }] },
  { code: 'EXEMPT', label: { en: 'VAT exempt', th: 'ยกเว้นภาษี' }, kind: 'exempt', rates: [{ from: '1992-01-01', rate: 0 }] },
];

/**
 * A small SME chart in the common Thai 4-digit layout. Businesses add their own
 * accounts on top (account.create); these codes are what automatic postings use.
 */
const COA: AccountDef[] = [
  { code: '1110', name: { en: 'Cash', th: 'เงินสด' }, type: 'asset' },
  { code: '1120', name: { en: 'Bank deposits', th: 'เงินฝากธนาคาร' }, type: 'asset' },
  { code: '1130', name: { en: 'Trade receivables', th: 'ลูกหนี้การค้า' }, type: 'asset' },
  { code: '1140', name: { en: 'Inventory', th: 'สินค้าคงเหลือ' }, type: 'asset' },
  { code: '1150', name: { en: 'Retention receivable', th: 'เงินประกันผลงานค้างรับ' }, type: 'asset' },
  { code: '1160', name: { en: 'Input VAT', th: 'ภาษีซื้อ' }, type: 'asset' },
  { code: '1170', name: { en: 'Withholding tax prepaid', th: 'ภาษีเงินได้ถูกหัก ณ ที่จ่าย' }, type: 'asset' },
  { code: '1180', name: { en: 'Prepaid expenses', th: 'ค่าใช้จ่ายจ่ายล่วงหน้า' }, type: 'asset' },
  { code: '1210', name: { en: 'Equipment and vehicles', th: 'อุปกรณ์และยานพาหนะ' }, type: 'asset' },
  { code: '1219', name: { en: 'Accumulated depreciation', th: 'ค่าเสื่อมราคาสะสม' }, type: 'asset' },
  { code: '2110', name: { en: 'Short-term loans', th: 'เงินกู้ยืมระยะสั้น' }, type: 'liability' },
  { code: '2120', name: { en: 'Trade payables', th: 'เจ้าหนี้การค้า' }, type: 'liability' },
  { code: '2130', name: { en: 'Accrued expenses', th: 'ค่าใช้จ่ายค้างจ่าย' }, type: 'liability' },
  { code: '2140', name: { en: 'Retention payable', th: 'เงินประกันผลงานค้างจ่าย' }, type: 'liability' },
  { code: '2150', name: { en: 'Output VAT', th: 'ภาษีขาย' }, type: 'liability' },
  { code: '2160', name: { en: 'Withholding tax payable', th: 'ภาษีหัก ณ ที่จ่ายค้างจ่าย' }, type: 'liability' },
  { code: '2170', name: { en: 'Customer deposits', th: 'เงินรับล่วงหน้าจากลูกค้า' }, type: 'liability' },
  { code: '2210', name: { en: 'Long-term loans', th: 'เงินกู้ยืมระยะยาว' }, type: 'liability' },
  { code: '3100', name: { en: 'Owner equity', th: 'ทุน' }, type: 'equity' },
  { code: '3200', name: { en: 'Retained earnings', th: 'กำไรสะสม' }, type: 'equity' },
  { code: '4110', name: { en: 'Sales of goods', th: 'รายได้จากการขายสินค้า' }, type: 'income' },
  { code: '4120', name: { en: 'Service income', th: 'รายได้ค่าบริการ' }, type: 'income' },
  { code: '4900', name: { en: 'Other income', th: 'รายได้อื่น' }, type: 'income' },
  { code: '5110', name: { en: 'Purchases', th: 'ซื้อสินค้า' }, type: 'expense' },
  { code: '5120', name: { en: 'Cost of sales adjustment', th: 'ปรับปรุงต้นทุนขาย' }, type: 'expense' },
  { code: '5200', name: { en: 'Operating expenses', th: 'ค่าใช้จ่ายในการดำเนินงาน' }, type: 'expense' },
  { code: '5210', name: { en: 'Salaries and wages', th: 'เงินเดือนและค่าแรง' }, type: 'expense' },
  { code: '5220', name: { en: 'Rent', th: 'ค่าเช่า' }, type: 'expense' },
  { code: '5230', name: { en: 'Utilities', th: 'ค่าสาธารณูปโภค' }, type: 'expense' },
  { code: '5240', name: { en: 'Fuel and transport', th: 'ค่าน้ำมันและขนส่ง' }, type: 'expense' },
  { code: '5250', name: { en: 'Depreciation', th: 'ค่าเสื่อมราคา' }, type: 'expense' },
  { code: '5300', name: { en: 'Interest and bank charges', th: 'ดอกเบี้ยและค่าธรรมเนียมธนาคาร' }, type: 'expense' },
];

/** 13-digit Thai tax / citizen ID: last digit = (11 − Σ dᵢ·(13−i) mod 11) mod 10. */
export function validThaiTaxId(raw: string): boolean {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 13) return false;
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(d[i]) * (13 - i);
  return (11 - (s % 11)) % 10 === Number(d[12]);
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatThaiDate(date: IsoDate, locale: Locale): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return date;
  return locale === 'th' ? `${d} ${TH_MONTHS[m - 1]} ${y + 543}` : `${d} ${EN_MONTHS[m - 1]} ${y}`;
}

function branchOf(s: { fields: Record<string, unknown> }): string | undefined {
  const b = s.fields?.branch_code;
  return typeof b === 'string' && b.trim() ? b.trim() : undefined;
}

export function describeBranch(branch: string | undefined, locale: Locale): string {
  if (!branch) return '';
  if (/^0+$/.test(branch)) return locale === 'th' ? 'สำนักงานใหญ่' : 'Head office';
  return locale === 'th' ? `สาขาที่ ${branch.padStart(5, '0')}` : `Branch ${branch.padStart(5, '0')}`;
}

const err = (code: string, en: string, th: string, field?: string): Issue => ({ level: 'error', code, message: { en, th }, field });
const warn = (code: string, en: string, th: string, field?: string): Issue => ({ level: 'warning', code, message: { en, th }, field });

function validateIssue({ doc, docType, party, seller }: IssueContext): Issue[] {
  const th = (docType.jurisdiction?.th ?? {}) as { taxDocument?: 'full' | 'abbreviated' };
  const issues: Issue[] = [];
  if (doc.date > VAT_REDUCED_RATE_KNOWN_UNTIL && doc.lines.some((l) => l.taxCode === 'VAT7')) {
    issues.push(warn('vat_rate_unconfirmed',
      `No enacted reduced VAT rate is known after ${VAT_REDUCED_RATE_KNOWN_UNTIL}; the statutory 10% is used. Check for a new Royal Decree.`,
      `ยังไม่มีพระราชกฤษฎีกาลดอัตราภาษีหลัง ${formatThaiDate(VAT_REDUCED_RATE_KNOWN_UNTIL, 'th')} ระบบใช้อัตรา 10% ตามกฎหมาย`));
  }
  if (th.taxDocument !== 'full') return issues;

  // Seller particulars.
  if (!seller.taxId) issues.push(err('seller_tax_id', 'Company tax ID is missing (Settings → Company).', 'ยังไม่ได้ระบุเลขประจำตัวผู้เสียภาษีของบริษัท', 'seller.taxId'));
  else if (!validThaiTaxId(seller.taxId)) issues.push(err('seller_tax_id_invalid', 'Company tax ID fails the checksum.', 'เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้อง', 'seller.taxId'));
  if (!branchOf(seller)) issues.push(err('seller_branch', 'Company head office / branch number is missing.', 'ยังไม่ได้ระบุสำนักงานใหญ่/สาขาของบริษัท', 'seller.branch_code'));
  if (!seller.address?.line1) issues.push(err('seller_address', 'Company address is missing.', 'ยังไม่ได้ระบุที่อยู่บริษัท', 'seller.address'));
  if (seller.fields?.vat_registered === false) issues.push(err('seller_not_vat', 'The company is not VAT-registered and cannot issue tax invoices.', 'บริษัทไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม ไม่สามารถออกใบกำกับภาษีได้'));

  // Buyer particulars.
  if (!party.name?.trim()) issues.push(err('buyer_name', 'Customer name is missing.', 'ยังไม่ได้ระบุชื่อลูกค้า', 'party.name'));
  if (!party.address?.line1) issues.push(err('buyer_address', 'Customer address is required on a full tax invoice.', 'ใบกำกับภาษีเต็มรูปต้องมีที่อยู่ลูกค้า', 'party.address'));
  const business = party.kind === 'organization' || party.fields?.vat_registered === true;
  if (party.taxId && !validThaiTaxId(party.taxId)) {
    issues.push(err('buyer_tax_id_invalid', 'Customer tax ID fails the checksum.', 'เลขประจำตัวผู้เสียภาษีของลูกค้าไม่ถูกต้อง', 'party.taxId'));
  }
  if (business && !party.taxId) {
    issues.push(err('buyer_tax_id', 'Business customers need a tax ID on a full tax invoice.', 'ลูกค้านิติบุคคลต้องมีเลขประจำตัวผู้เสียภาษี', 'party.taxId'));
  }
  if (business && !branchOf(party)) {
    issues.push(err('buyer_branch', 'Business customers need "Head office" or a branch number.', 'ต้องระบุสำนักงานใหญ่หรือเลขสาขาของลูกค้า', 'party.branch_code'));
  }
  if (!business && !party.taxId) {
    issues.push(warn('buyer_tax_id_person', 'No customer tax ID: fine for individuals who will not claim input VAT.', 'ไม่มีเลขผู้เสียภาษีของลูกค้า (บุคคลธรรมดาที่ไม่ขอคืนภาษีซื้อ)'));
  }
  if (doc.lines.length === 0) issues.push(err('no_lines', 'A tax invoice needs at least one line.', 'ใบกำกับภาษีต้องมีรายการอย่างน้อยหนึ่งรายการ'));
  return issues;
}

const WHT_MIN_BASE = 1_000_00;

function suggestWht(doc: Document, party: Party): WhtSuggestion[] {
  // Juristic-person payers are obliged to withhold on services ≥ 1,000 THB (ex-VAT).
  if (party.kind !== 'organization') return [];
  return doc.totals.whtBases
    .filter((w) => w.base >= WHT_MIN_BASE)
    .map((w) => {
      const rate = th.whtCategories.find((c) => c.id === w.category)?.rate ?? 0;
      return { category: w.category, base: w.base, rate, amount: roundHalfUp(w.base * rate) };
    })
    .filter((w) => w.rate > 0);
}

export const th: Jurisdiction = {
  id: 'th',
  label: { en: 'Thailand', th: 'ประเทศไทย' },
  currency: 'THB',
  currencySymbol: '฿',
  taxCodes: TAX_CODES,
  defaultTaxCode: 'VAT7',
  whtCategories: [
    { id: 'service', label: { en: 'Services / hire of work 3%', th: 'ค่าบริการ/ค่าจ้างทำของ 3%' }, rate: 0.03 },
    { id: 'transport', label: { en: 'Transport 1%', th: 'ค่าขนส่ง 1%' }, rate: 0.01 },
    { id: 'advertising', label: { en: 'Advertising 2%', th: 'ค่าโฆษณา 2%' }, rate: 0.02 },
    { id: 'rent', label: { en: 'Rent 5%', th: 'ค่าเช่า 5%' }, rate: 0.05 },
  ],
  partyFields: [
    { key: 'branch_code', type: 'text', label: { en: 'Head office / branch no.', th: 'สำนักงานใหญ่/สาขา' }, placeholder: { en: '00000 = head office', th: '00000 = สำนักงานใหญ่' } },
    { key: 'vat_registered', type: 'boolean', label: { en: 'VAT registered', th: 'จดทะเบียนภาษีมูลค่าเพิ่ม' } },
  ],
  companyFields: [
    { key: 'branch_code', type: 'text', label: { en: 'Head office / branch no.', th: 'สำนักงานใหญ่/สาขา' }, placeholder: { en: '00000 = head office', th: '00000 = สำนักงานใหญ่' } },
    { key: 'vat_registered', type: 'boolean', label: { en: 'VAT registered', th: 'จดทะเบียนภาษีมูลค่าเพิ่ม' } },
    { key: 'promptpay_id', type: 'text', label: { en: 'PromptPay ID (for QR on invoices)', th: 'พร้อมเพย์ (แสดง QR บนใบแจ้งหนี้)' } },
  ],
  chartOfAccounts: COA,
  postingAccounts: {
    cash: '1110', bank: '1120', receivable: '1130', inputTax: '1160', whtPrepaid: '1170',
    payable: '2120', outputTax: '2150', whtPayable: '2160',
    revenueGoods: '4110', revenueServices: '4120', purchases: '5110',
    retentionReceivable: '1150', retentionPayable: '2140',
  },
  taxRate(code, date) {
    const def = TAX_CODES.find((t) => t.code === code);
    if (!def) return 0;
    const r = def.rates.find((x) => date >= x.from && (!x.to || date <= x.to));
    return r?.rate ?? 0;
  },
  validateTaxId: validThaiTaxId,
  validateIssue,
  suggestWht,
  amountInWords: (minor, locale) => (locale === 'th' ? bahtTextTh(minor) : bahtTextEn(minor)),
  formatDate: formatThaiDate,
  paymentQr: ({ proxyId, amount, reference }) => promptPayPayload({ proxyId, amount, reference }),
  describeTaxIdentity(s: PartySnapshot, locale) {
    return describeBranch(branchOf(s), locale);
  },
};

export default th;
