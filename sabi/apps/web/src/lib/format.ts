import type { Label } from '@sabi/core';
import { app } from './state.svelte.ts';

export const L = (l: Label | undefined | null): string => {
  if (!l) return '';
  return (app.locale === 'th' ? l.th : l.en) ?? l.en ?? '';
};

const moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

/** Minor units (satang) → "12,345.00". */
export const money = (minor: number | null | undefined, symbol = false): string =>
  minor === null || minor === undefined ? '—' : `${minor < 0 ? '−' : ''}${symbol ? '฿' : ''}${moneyFmt.format(Math.abs(minor) / 100)}`;

/** Compact money for summaries: ฿1.2M, ฿45.3k. */
export const moneyShort = (minor: number): string => {
  const v = minor / 100;
  if (Math.abs(v) >= 1_000_000) return `฿${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `฿${(v / 1000).toFixed(1)}k`;
  return `฿${moneyFmt.format(v)}`;
};

export const qty = (n: number | null | undefined) => (n === null || n === undefined ? '—' : qtyFmt.format(n));

function dateFmt(opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(app.locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB', { timeZone: 'Asia/Bangkok', ...opts });
}

/** "29 ก.ย. 2569" / "29 Sep 2026" */
export const date = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00+07:00`) : new Date(iso);
  return dateFmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(d);
};
export const dateShort = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00+07:00`) : new Date(iso);
  return dateFmt({ day: 'numeric', month: 'short' }).format(d);
};
export const time = (iso: string) => dateFmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** "5 min ago", "yesterday 14:20", "3 Sep". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const th = app.locale === 'th';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return th ? 'เมื่อสักครู่' : 'just now';
  if (s < 3600) return th ? `${Math.floor(s / 60)} นาทีที่แล้ว` : `${Math.floor(s / 60)} min ago`;
  if (s < 6 * 3600) return th ? `${Math.floor(s / 3600)} ชม. ที่แล้ว` : `${Math.floor(s / 3600)} h ago`;
  const today = dayKey(new Date());
  const k = dayKey(d);
  if (k === today) return `${th ? 'วันนี้' : 'today'} ${time(iso)}`;
  if (k === dayKey(new Date(Date.now() - 86400_000))) return `${th ? 'เมื่อวาน' : 'yesterday'} ${time(iso)}`;
  if (s < 6 * 86400) return `${dateFmt({ weekday: 'short' }).format(d)} ${time(iso)}`;
  return dateShort(iso);
}
const dayKey = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

/** Days from today to an ISO date (negative = past). */
export function daysUntil(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  const t = Date.parse(`${app.today}T00:00:00Z`);
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - t) / 86400_000);
}

export function dueText(isoDate: string | null | undefined): { text: string; tone: string } {
  const n = daysUntil(isoDate);
  const th = app.locale === 'th';
  if (n === null) return { text: '', tone: 'neutral' };
  if (n < 0) return { text: th ? `เกินกำหนด ${-n} วัน` : `${-n}d overdue`, tone: 'danger' };
  if (n === 0) return { text: th ? 'วันนี้' : 'today', tone: 'warning' };
  if (n === 1) return { text: th ? 'พรุ่งนี้' : 'tomorrow', tone: 'warning' };
  if (n < 7) return { text: th ? `อีก ${n} วัน` : `in ${n}d`, tone: 'neutral' };
  return { text: dateShort(isoDate), tone: 'neutral' };
}

export const initials = (name: string | undefined) =>
  (name ?? '?').replace(/^(Khun|คุณ)\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function userName(id: string | null | undefined): string {
  if (!id) return '';
  if (id === 'system') return 'Sabi';
  return app.boot?.users.find((u: any) => u.id === id)?.name ?? '';
}

export const fmtAddress = (a: any): string =>
  a ? [a.line1, a.line2, a.district, a.province, a.postcode].filter(Boolean).join(', ') : '';

/** Unit of measure label from the pack ("m" → "เมตร"); falls back to the stored code. */
export const unit = (uom: string | null | undefined, locale?: 'th' | 'en'): string => {
  if (!uom) return '';
  const u = app.boot?.pack.units?.find((x: { id: string }) => x.id === uom);
  if (!u) return uom;
  return (locale ?? app.locale) === 'th' ? u.label.th ?? u.label.en : u.label.en;
};
