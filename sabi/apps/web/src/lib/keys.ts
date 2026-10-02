/** Global keyboard shortcuts. Ignored while typing in inputs. */
export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Move focus through elements marked [data-nav] with j/k. */
export function moveListFocus(dir: 1 | -1) {
  const items = [...document.querySelectorAll<HTMLElement>('[data-nav]')].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[Math.max(0, Math.min(items.length - 1, i < 0 ? 0 : i + dir))];
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}
