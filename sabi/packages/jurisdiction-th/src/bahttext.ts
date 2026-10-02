/** Thai and English amount-in-words for baht (matches Excel BAHTTEXT conventions). */

const TH_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const TH_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/** Reads 0 < n < 1,000,000. `hasHigher` = a higher group precedes (affects เอ็ด). */
function thGroup(n: number, hasHigher: boolean): string {
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const place = s.length - i - 1;
    if (d === 0) continue;
    if (place === 1 && d === 1) out += 'สิบ';
    else if (place === 1 && d === 2) out += 'ยี่สิบ';
    else if (place === 0 && d === 1 && (s.length > 1 || hasHigher)) out += 'เอ็ด';
    else out += TH_DIGITS[d] + TH_PLACES[place];
  }
  return out;
}

export function thaiNumber(n: number): string {
  if (n === 0) return TH_DIGITS[0];
  const parts: number[] = [];
  let x = Math.floor(n);
  while (x > 0) {
    parts.unshift(x % 1_000_000);
    x = Math.floor(x / 1_000_000);
  }
  let out = '';
  parts.forEach((p, i) => {
    if (p > 0) out += thGroup(p, i > 0);
    if (i < parts.length - 1) out += 'ล้าน';
  });
  return out;
}

export function bahtTextTh(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const baht = Math.floor(abs / 100);
  const satang = abs % 100;
  let s = '';
  if (baht > 0 || satang === 0) s += thaiNumber(baht) + 'บาท';
  s += satang === 0 ? 'ถ้วน' : thaiNumber(satang) + 'สตางค์';
  return (neg ? 'ลบ' : '') + s;
}

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function en999(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${EN_ONES[h]} hundred`);
  if (r) parts.push(r < 20 ? EN_ONES[r] : EN_TENS[Math.floor(r / 10)] + (r % 10 ? '-' + EN_ONES[r % 10] : ''));
  return parts.join(' ');
}

export function englishNumber(n: number): string {
  if (n === 0) return 'zero';
  const scales = ['', ' thousand', ' million', ' billion'];
  const parts: string[] = [];
  let x = Math.floor(n);
  let i = 0;
  while (x > 0) {
    const g = x % 1000;
    if (g) parts.unshift(en999(g) + scales[i]);
    x = Math.floor(x / 1000);
    i++;
  }
  return parts.join(' ');
}

export function bahtTextEn(minor: number): string {
  const abs = Math.abs(Math.round(minor));
  const baht = Math.floor(abs / 100);
  const satang = abs % 100;
  let s = englishNumber(baht) + ' baht';
  s += satang ? ` and ${englishNumber(satang)} satang` : ' only';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return (minor < 0 ? 'Minus ' : '') + s;
}
