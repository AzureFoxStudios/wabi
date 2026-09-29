<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { app, T, setLocale, roleLabel, can } from '$lib/state.svelte.ts';
  import { post } from '$lib/api.ts';
  import { initials } from '$lib/format.ts';
  import { isTyping, moveListFocus } from '$lib/keys.ts';
  import Palette from './Palette.svelte';
  import CreateMenu from './CreateMenu.svelte';

  let { children } = $props();

  const nav = $derived([
    { href: '/', label: T('Today', 'วันนี้'), key: 'h' },
    { href: '/jobs', label: T('Jobs', 'งาน'), key: 'j' },
    { href: '/documents', label: T('Documents', 'เอกสาร'), key: 'd' },
    { href: '/parties', label: T('Customers & suppliers', 'ลูกค้าและผู้ขาย'), key: 'p' },
    { href: '/items', label: T('Items & stock', 'สินค้าและสต็อก'), key: 'i' },
    ...(can('money.write') || can('reports.read') ? [{ href: '/money', label: T('Money', 'การเงิน'), key: 'm' }] : []),
    ...(can('reports.read') ? [{ href: '/reports', label: T('Tax & reports', 'ภาษีและรายงาน'), key: 'r' }] : []),
  ]);
  const active = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));

  let gPending = false;
  let gTimer: ReturnType<typeof setTimeout>;
  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      app.paletteOpen = !app.paletteOpen;
      return;
    }
    if (e.key === 'Escape') {
      app.paletteOpen = false;
      app.createOpen = false;
      app.helpOpen = false;
      return;
    }
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (gPending) {
      gPending = false;
      const target = nav.find((n) => n.key === e.key) ?? (e.key === 's' ? { href: '/settings' } : null);
      if (target) {
        e.preventDefault();
        goto(target.href);
      }
      return;
    }
    if (e.key === 'g') {
      gPending = true;
      clearTimeout(gTimer);
      gTimer = setTimeout(() => (gPending = false), 1200);
    } else if (e.key === '/') {
      e.preventDefault();
      app.paletteOpen = true;
    } else if (e.key === 'c') {
      e.preventDefault();
      app.createOpen = true;
    } else if (e.key === '?') {
      app.helpOpen = !app.helpOpen;
    } else if (e.key === 'j') {
      moveListFocus(1);
    } else if (e.key === 'k') {
      moveListFocus(-1);
    }
  }

  async function logout() {
    await post('logout');
    location.href = '/login';
  }
  let menuOpen = $state(false);
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <aside class="rail" aria-label={T('Main navigation', 'เมนูหลัก')}>
    <a class="brand" href="/">
      <span class="mark" aria-hidden="true">S</span>
      <span class="grow ellipsis">
        <strong>{app.boot.company.name || 'Sabi'}</strong>
      </span>
    </a>
    <button class="search" onclick={() => (app.paletteOpen = true)}>
      <span>{T('Search or jump to…', 'ค้นหาหรือไปที่…')}</span><kbd>⌘K</kbd>
    </button>
    <nav>
      {#each nav as n (n.href)}
        <a href={n.href} class:on={active(n.href)} title={`g ${n.key}`}>{n.label}</a>
      {/each}
    </nav>
    <button class="btn primary new" onclick={() => (app.createOpen = true)}>
      + {T('New', 'สร้างใหม่')} <kbd>C</kbd>
    </button>
    <div class="grow"></div>
    {#if !app.online}
      <p class="offline tiny">{T('Reconnecting… changes by others may be delayed.', 'กำลังเชื่อมต่อใหม่…')}</p>
    {/if}
    <div class="me">
      <button class="who" onclick={() => (menuOpen = !menuOpen)} aria-expanded={menuOpen}>
        <span class="avatar">{initials(app.boot.user.name)}</span>
        <span class="grow ellipsis left">
          <span class="small">{app.boot.user.name}</span><br />
          <span class="tiny muted">{roleLabel(app.boot.user.role)}</span>
        </span>
      </button>
      {#if menuOpen}
        <div class="menu" role="menu">
          <div class="langs">
            <button class:on={app.locale === 'th'} onclick={() => setLocale('th')}>ไทย</button>
            <button class:on={app.locale === 'en'} onclick={() => setLocale('en')}>English</button>
          </div>
          <a href="/settings" onclick={() => (menuOpen = false)}>{T('Settings', 'ตั้งค่า')}</a>
          <button onclick={() => ((app.helpOpen = true), (menuOpen = false))}>{T('Keyboard shortcuts', 'คีย์ลัด')} <kbd>?</kbd></button>
          <button onclick={logout}>{T('Sign out', 'ออกจากระบบ')}</button>
        </div>
      {/if}
    </div>
  </aside>

  <main>
    {@render children()}
  </main>
</div>

{#if app.paletteOpen}<Palette />{/if}
{#if app.createOpen}<CreateMenu />{/if}

{#if app.helpOpen}
  <div class="scrim" role="presentation" onclick={() => (app.helpOpen = false)}></div>
  <div class="help panel" role="dialog" aria-label="Keyboard shortcuts">
    <h2>{T('Keyboard', 'คีย์ลัด')}</h2>
    <dl>
      <dt><kbd>⌘</kbd> <kbd>K</kbd> / <kbd>/</kbd></dt><dd>{T('Search, jump, run a command', 'ค้นหา/ไปที่/สั่งงาน')}</dd>
      <dt><kbd>C</kbd></dt><dd>{T('Create something new', 'สร้างใหม่')}</dd>
      <dt><kbd>G</kbd> then <kbd>H</kbd> <kbd>J</kbd> <kbd>D</kbd> <kbd>P</kbd> <kbd>I</kbd> <kbd>M</kbd> <kbd>R</kbd> <kbd>S</kbd></dt><dd>{T('Go to Today, Jobs, Documents, Parties, Items, Money, Reports, Settings', 'ไปยังหน้า วันนี้ งาน เอกสาร ลูกค้า สินค้า การเงิน รายงาน ตั้งค่า')}</dd>
      <dt><kbd>J</kbd> / <kbd>K</kbd></dt><dd>{T('Move down / up in lists', 'เลื่อนลง/ขึ้นในรายการ')}</dd>
      <dt><kbd>Enter</kbd></dt><dd>{T('Open the focused row', 'เปิดรายการที่เลือก')}</dd>
      <dt><kbd>⌘</kbd> <kbd>Enter</kbd></dt><dd>{T('Send message / save form', 'ส่งข้อความ/บันทึก')}</dd>
      <dt><kbd>Esc</kbd></dt><dd>{T('Close', 'ปิด')}</dd>
    </dl>
  </div>
{/if}

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast tone-{t.tone}">
      <span>{t.text}</span>
      {#if t.action}<a class="link" href={t.action.href}>{t.action.label}</a>{/if}
    </div>
  {/each}
</div>

<style>
  .shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
  .rail {
    position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 6px;
    padding: 16px 12px; border-right: 1px solid var(--line); background: var(--bg);
  }
  .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 10px; }
  .brand strong { font-size: 0.9rem; font-weight: 600; }
  .mark {
    width: 28px; height: 28px; border-radius: 7px; background: var(--accent); color: white; display: grid; place-items: center;
    font-weight: 600; flex: none;
  }
  .search {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
    font: inherit; font-size: 0.86rem; color: var(--muted); background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--radius-sm); padding: 6px 8px 6px 10px; cursor: text; margin-bottom: 8px;
  }
  nav { display: flex; flex-direction: column; gap: 1px; }
  nav a { padding: 7px 10px; border-radius: var(--radius-sm); color: var(--ink-2); font-size: 0.92rem; }
  nav a:hover { background: var(--sunken); }
  nav a.on { background: var(--surface); color: var(--ink); font-weight: 500; box-shadow: inset 2px 0 0 var(--accent); }
  .new { margin-top: 12px; justify-content: space-between; }
  .offline { color: var(--t-warning); padding: 0 8px; }
  .me { position: relative; }
  .who { display: flex; align-items: center; gap: 10px; width: 100%; background: none; border: 0; padding: 6px 8px; border-radius: var(--radius-sm); font: inherit; text-align: left; cursor: pointer; line-height: 1.25; }
  .who:hover { background: var(--sunken); }
  .left { text-align: left; }
  .menu {
    position: absolute; bottom: 52px; left: 0; right: 0; background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--radius); box-shadow: var(--shadow-pop); padding: 6px; display: flex; flex-direction: column; z-index: 20;
  }
  .menu a, .menu > button { text-align: left; background: none; border: 0; font: inherit; font-size: 0.9rem; padding: 7px 10px; border-radius: 5px; cursor: pointer; display: flex; justify-content: space-between; }
  .menu a:hover, .menu > button:hover { background: var(--sunken); }
  .langs { display: flex; gap: 4px; padding: 4px; }
  .langs button { flex: 1; font: inherit; font-size: 0.85rem; border: 1px solid var(--line); background: var(--surface); border-radius: 5px; padding: 4px; cursor: pointer; }
  .langs button.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  main { min-width: 0; }
  .scrim { position: fixed; inset: 0; background: rgba(28, 34, 32, 0.25); z-index: 40; }
  .help { position: fixed; top: 12vh; left: 50%; transform: translateX(-50%); width: min(560px, 92vw); padding: 22px 24px; z-index: 41; box-shadow: var(--shadow-pop); }
  .help dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 18px; margin: 16px 0 0; font-size: 0.9rem; }
  .help dt { white-space: nowrap; }
  .help dd { margin: 0; color: var(--ink-2); }
  .toasts { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 60; }
  .toast { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-radius: var(--radius); box-shadow: var(--shadow-pop); font-size: 0.9rem; border: 1px solid var(--line); background: var(--surface); }
  .toast.tone-success { border-color: color-mix(in srgb, var(--t-success) 30%, var(--line)); }
  .toast.tone-danger { background: var(--t-danger-bg); }

  @media (max-width: 900px) {
    .shell { grid-template-columns: 1fr; }
    .rail { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 8px 12px; border-right: 0; border-bottom: 1px solid var(--line); }
    .brand { padding: 0; }
    .brand .grow, .search, .rail > .grow, .me { display: none; }
    nav { flex-direction: row; overflow-x: auto; flex: 1; }
    .new { margin: 0; }
  }
</style>
