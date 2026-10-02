import { test } from 'node:test';
import assert from 'node:assert/strict';
import { th, validThaiTaxId, bahtTextTh, bahtTextEn, crc16, promptPayPayload, formatThaiDate, describeBranch, thaiNumber } from '../src/index.ts';
import { computeTotals } from '@sabi/core';
import type { Document, DocTypeDef, Party, PartySnapshot } from '@sabi/core';

test('tax id checksum', () => {
  assert.equal(validThaiTaxId('0105536000011'), true); // computed check digit
  assert.equal(validThaiTaxId('0105536000012'), false);
  assert.equal(validThaiTaxId('123'), false);
  assert.equal(validThaiTaxId('3-1005-00123-45-3'), validThaiTaxId('3100500123453'));
});

test('VAT is effective-dated', () => {
  assert.equal(th.taxRate('VAT7', '2026-09-29'), 0.07);
  assert.equal(th.taxRate('VAT7', '2027-09-30'), 0.07);
  assert.equal(th.taxRate('VAT7', '2027-10-01'), 0.1);
  assert.equal(th.taxRate('EXEMPT', '2026-01-01'), 0);
  assert.equal(th.taxRate('NOPE', '2026-01-01'), 0);
});

test('baht text (BAHTTEXT conventions)', () => {
  assert.equal(bahtTextTh(0), 'ศูนย์บาทถ้วน');
  assert.equal(bahtTextTh(1_00), 'หนึ่งบาทถ้วน');
  assert.equal(bahtTextTh(11_00), 'สิบเอ็ดบาทถ้วน');
  assert.equal(bahtTextTh(21_00), 'ยี่สิบเอ็ดบาทถ้วน');
  assert.equal(bahtTextTh(101_00), 'หนึ่งร้อยเอ็ดบาทถ้วน');
  assert.equal(bahtTextTh(1_000_001_00), 'หนึ่งล้านเอ็ดบาทถ้วน');
  assert.equal(bahtTextTh(26_803_50), 'สองหมื่นหกพันแปดร้อยสามบาทห้าสิบสตางค์');
  assert.equal(bahtTextTh(25), 'ยี่สิบห้าสตางค์');
  assert.equal(thaiNumber(12_000_000), 'สิบสองล้าน');
  assert.equal(bahtTextEn(1_234_56), 'One thousand two hundred thirty-four baht and fifty-six satang');
  assert.equal(bahtTextEn(100_00), 'One hundred baht only');
});

test('PromptPay: CRC16 CCITT-FALSE check value and payload shape', () => {
  assert.equal(crc16('123456789'), '29B1');
  const p = promptPayPayload({ proxyId: '081-234-5678', amount: 1_500_00, reference: 'IV-2026-0001' });
  assert.match(p, /^000201010212/);
  assert.ok(p.includes('01130066812345678'));
  assert.ok(p.includes('54071500.00'));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  const s = promptPayPayload({ proxyId: '0105536000011' });
  assert.match(s, /^000201010211/);
  assert.ok(s.includes('02130105536000011'));
  assert.throws(() => promptPayPayload({ proxyId: '12' }));
});

test('dates and branch labels', () => {
  assert.equal(formatThaiDate('2026-09-29', 'th'), '29 ก.ย. 2569');
  assert.equal(formatThaiDate('2026-09-29', 'en'), '29 Sep 2026');
  assert.equal(describeBranch('00000', 'th'), 'สำนักงานใหญ่');
  assert.equal(describeBranch('2', 'en'), 'Branch 00002');
});

const rate = th.taxRate.bind(th);
const taxInvoice = { id: 'tax_invoice', effects: ['stock_out', 'receivable'], jurisdiction: { th: { taxDocument: 'full' } } } as unknown as DocTypeDef;
const seller: PartySnapshot = { name: 'Co', taxId: '0105536000011', address: { line1: '1 Road' }, fields: { branch_code: '00000' } };
const mkDoc = (lines: Document['lines']): Document => ({
  id: 'd', type: 'tax_invoice', state: 'draft', phase: 'draft', partyId: 'p', date: '2026-09-29', priceMode: 'exclusive',
  lines, fields: {}, createdBy: 'u', createdAt: '', updatedAt: '', totals: computeTotals(lines, 'exclusive', '2026-09-29', rate),
});
const org = (p: Partial<Party> = {}): Party => ({ id: 'p', kind: 'organization', name: 'Buyer Co', roles: ['customer'], fields: {}, createdAt: '', updatedAt: '', ...p });

test('full tax invoice validation: business buyer needs tax id + branch + address', () => {
  const doc = mkDoc([{ id: 'l', description: 'x', qty: 1, uom: 'pc', unitPrice: 100_00, discountPct: 0, taxCode: 'VAT7' }]);
  const codes = th.validateIssue({ doc, docType: taxInvoice, party: org(), seller }).filter((i) => i.level === 'error').map((i) => i.code);
  assert.deepEqual(codes.sort(), ['buyer_address', 'buyer_branch', 'buyer_tax_id']);
  const ok = th.validateIssue({ doc, docType: taxInvoice, party: org({ taxId: '0105536000011', address: { line1: 'x' }, fields: { branch_code: '00000' } }), seller });
  assert.equal(ok.filter((i) => i.level === 'error').length, 0);
  const noSeller = th.validateIssue({ doc, docType: taxInvoice, party: org({ taxId: '0105536000011', address: { line1: 'x' }, fields: { branch_code: '00000' } }), seller: { name: 'Co', fields: {} } });
  assert.ok(noSeller.some((i) => i.code === 'seller_tax_id'));
});

test('WHT suggestion only for juristic payers and services ≥ 1,000 THB', () => {
  const doc = mkDoc([
    { id: 'a', description: 'sheet', qty: 100, uom: 'm', unitPrice: 200_00, discountPct: 0, taxCode: 'VAT7', itemKind: 'stock' },
    { id: 'b', description: 'install', qty: 1, uom: 'job', unitPrice: 8_000_00, discountPct: 0, taxCode: 'VAT7', itemKind: 'service', whtCategory: 'service' },
  ]);
  assert.deepEqual(th.suggestWht(doc, org()), [{ category: 'service', base: 8_000_00, rate: 0.03, amount: 240_00 }]);
  assert.deepEqual(th.suggestWht(doc, org({ kind: 'person' })), []);
});
