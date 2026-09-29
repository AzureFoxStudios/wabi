/** Global client state: session bootstrap, locale, live revision counter, toasts. */
import { get, authUrl } from './api.ts';

type Toast = { id: number; text: string; tone: 'info' | 'success' | 'danger' | 'warning'; action?: { label: string; href: string } };

export const app = $state({
  boot: null as any,
  locale: (typeof localStorage !== 'undefined' && (localStorage.getItem('sabi.locale') as 'th' | 'en')) || 'th',
  today: new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10),
  /** Incremented whenever the server reports a committed change. Pages re-fetch on change. */
  rev: 0,
  /** Subjects touched by the last change batch (for targeted refresh / highlights). */
  changed: new Set<string>(),
  lastActor: null as string | null,
  toasts: [] as Toast[],
  paletteOpen: false,
  createOpen: false,
  helpOpen: false,
  online: true,
});

/** Pick the string for the current locale: T('Jobs', 'งาน'). */
export const T = (en: string, th?: string) => (app.locale === 'th' && th ? th : en);

export function setLocale(l: 'th' | 'en') {
  app.locale = l;
  localStorage.setItem('sabi.locale', l);
  document.documentElement.lang = l;
}

export async function loadBoot() {
  app.boot = await get('bootstrap');
  app.today = app.boot.today;
  if (!localStorage.getItem('sabi.locale')) app.locale = app.boot.user.locale ?? 'th';
  document.documentElement.lang = app.locale;
  return app.boot;
}

let es: EventSource | null = null;
export function connectStream() {
  if (es) return;
  es = new EventSource(authUrl('/api/stream'));
  es.addEventListener('change', (ev) => {
    const data = JSON.parse((ev as MessageEvent).data);
    app.changed = new Set(data.events.map((e: any) => `${e.subjectType}:${e.subjectId}`));
    app.lastActor = data.events.at(-1)?.actorId ?? null;
    if (data.events.some((e: any) => e.type.startsWith('user.') || e.type === 'company.updated')) loadBoot();
    app.rev++;
  });
  es.onopen = () => (app.online = true);
  es.onerror = () => (app.online = false);
}

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', action?: Toast['action']) {
  const id = ++toastId;
  app.toasts.push({ id, text, tone, action });
  setTimeout(() => (app.toasts = app.toasts.filter((t) => t.id !== id)), tone === 'danger' ? 7000 : 3800);
}

// ── Pack helpers ──
export const pack = () => app.boot?.pack;
export const docTypeDef = (id: string) => app.boot?.pack.documentTypes.find((d: any) => d.id === id);
export const jobTypeDef = (id: string) => app.boot?.pack.jobTypes.find((d: any) => d.id === id);
export const roleLabel = (id: string | null | undefined) => {
  const r = app.boot?.pack.roles.find((x: any) => x.id === id);
  return r ? (app.locale === 'th' ? r.label.th ?? r.label.en : r.label.en) : id ?? '';
};
export const can = (cap: string) => {
  const role = app.boot?.pack.roles.find((r: any) => r.id === app.boot?.user.role);
  return !!role && (role.capabilities.includes('all') || role.capabilities.includes(cap));
};
export const me = () => app.boot?.user;
