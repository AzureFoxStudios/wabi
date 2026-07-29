let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (!container || !document.body.contains(container)) {
    container = document.createElement('div');
    container.id = 'wabi-toast-container';
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message: string, type: 'error' | 'warning' | 'info' = 'error', duration = 6000): void {
  const c = ensureContainer();
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText = `pointer-events:auto;max-width:400px;padding:12px 16px;border-radius:8px;font-size:14px;line-height:1.4;box-shadow:0 4px 16px rgba(0,0,0,0.3);animation:wabi-toast-in 0.25s ease-out;transition:opacity 0.3s,transform 0.3s;${
    type === 'error' ? 'background:#e74c3c;color:#fff;' :
    type === 'warning' ? 'background:#f39c12;color:#000;' :
    'background:#2c3e50;color:#fff;'
  }`;
  c.appendChild(el);

  const styleId = 'wabi-toast-style';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = `@keyframes wabi-toast-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(s);
  }

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(16px)';
    setTimeout(() => el.remove(), 350);
  }, duration);
}
