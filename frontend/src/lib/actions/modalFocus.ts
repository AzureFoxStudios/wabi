/** Shared modal focus ownership. Nested dialogs dismiss one layer at a time. */
const stack: HTMLElement[] = [];
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), details > summary:first-of-type, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

export function modalFocus(node: HTMLElement, close: () => void) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  stack.push(node);
  const targets = () => Array.from(node.querySelectorAll<HTMLElement>(focusable))
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert]'));
  queueMicrotask(() => {
    if (stack.at(-1) === node && node.isConnected) node.focus({ preventScroll: true });
  });
  function keydown(event: KeyboardEvent) {
    if (stack.at(-1) !== node || event.defaultPrevented) return;
    // A nested custom dialog may own focus without using this action.
    const focusedDialog = (document.activeElement as HTMLElement | null)?.closest('[role="dialog"], [role="alertdialog"]');
    if (focusedDialog && focusedDialog !== node && !node.contains(focusedDialog)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === 'Tab') {
      const items = targets();
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus();
        if (!items.length) node.focus();
      }
    }
  }
  document.addEventListener('keydown', keydown);
  return {
    update(next: () => void) { close = next; },
    destroy() {
      const wasTop = stack.at(-1) === node;
      stack.splice(stack.indexOf(node), 1);
      document.removeEventListener('keydown', keydown);
      if (wasTop) queueMicrotask(() => {
        if (opener?.isConnected && opener.getClientRects().length && !opener.closest('[inert]') &&
            (!stack.length || stack.at(-1)?.contains(opener))) opener.focus({ preventScroll: true });
      });
    }
  };
}
