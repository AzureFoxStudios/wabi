import type { Label, Locale } from './types.ts';

export function label(l: Label | undefined, locale: Locale): string {
  if (!l) return '';
  return (locale === 'th' ? l.th : undefined) ?? l.en;
}

export function lbl(en: string, th?: string): Label {
  return th ? { en, th } : { en };
}
