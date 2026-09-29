/**
 * PromptPay (Thai QR Payment, EMVCo MPM) payload builder.
 * Ported from Wabi `plugins/th-payments/backend/index.mjs` with typing and
 * static/dynamic handling. Render the returned string as a QR code.
 */

function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC-16/CCITT-FALSE as required by EMVCo (poly 0x1021, init 0xFFFF). */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Mobile `0812345678` → `0066812345678`; 13-digit tax/citizen ID and 15-digit e-wallet pass through. */
export function normalizeProxy(raw: string): string | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('0')) return `0066${d.slice(1)}`;
  if (d.length === 13 || d.length === 15) return d;
  return null;
}

export function promptPayPayload(opts: { proxyId: string; amount?: number; reference?: string }): string {
  const proxy = normalizeProxy(opts.proxyId);
  if (!proxy) throw new Error('Invalid PromptPay ID (use a mobile number, 13-digit tax ID or e-wallet ID)');
  const proxyTag = proxy.startsWith('0066') ? '01' : proxy.length === 15 ? '03' : '02';
  const hasAmount = typeof opts.amount === 'number' && opts.amount > 0;
  let p = tlv('00', '01') + tlv('01', hasAmount ? '12' : '11');
  p += tlv('29', tlv('00', 'A000000677010111') + tlv(proxyTag, proxy));
  p += tlv('53', '764');
  if (hasAmount) p += tlv('54', (opts.amount! / 100).toFixed(2));
  p += tlv('58', 'TH');
  const ref = String(opts.reference || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
  if (ref) p += tlv('62', tlv('05', ref));
  p += '6304';
  return p + crc16(p);
}
