<script lang="ts">
  import { page } from '$app/state';
  import { get, post } from '$lib/api.ts';
  import { app, T, setLocale } from '$lib/state.svelte.ts';

  let username = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);
  let session = $state<any>(null);
  $effect(() => {
    get('session').then((s) => (session = s));
  });

  async function submit(e?: Event) {
    e?.preventDefault();
    busy = true;
    error = '';
    try {
      await post('login', { username, password });
      const next = page.url.searchParams.get('next');
      location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
  function as(u: string) {
    username = u;
    password = session.demoPassword;
    submit();
  }
</script>

<svelte:head><title>{T('Sign in', 'เข้าสู่ระบบ')} · Sabi</title></svelte:head>

<div class="wrap">
  <form class="card" onsubmit={submit}>
    <div class="brand"><span class="mark">S</span> Sabi</div>
    <h1>{T('Sign in', 'เข้าสู่ระบบ')}</h1>
    <label class="field"><span>{T('Username', 'ชื่อผู้ใช้')}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={username} autocomplete="username" autofocus required /></label>
    <label class="field"><span>{T('Password', 'รหัสผ่าน')}</span>
      <input type="password" bind:value={password} autocomplete="current-password" required /></label>
    {#if error}<p class="err-text">{error}</p>{/if}
    <button class="btn primary lg" disabled={busy}>{T('Sign in', 'เข้าสู่ระบบ')}</button>
    <div class="langs small">
      <button type="button" class:on={app.locale === 'th'} onclick={() => setLocale('th')}>ไทย</button> ·
      <button type="button" class:on={app.locale === 'en'} onclick={() => setLocale('en')}>English</button>
    </div>
  </form>

  {#if session?.demo}
    <div class="demo">
      <p class="eyebrow">{T('Demo workspace — sign in as', 'เวิร์กสเปซตัวอย่าง — เข้าใช้ในฐานะ')}</p>
      <div class="accounts">
        {#each session.demoAccounts as acc (acc.username)}
          <button class="btn" onclick={() => as(acc.username)}><strong>{acc.username}</strong> <span class="muted small">{acc.role}</span></button>
        {/each}
      </div>
      <p class="tiny muted">{T('Password for all demo users:', 'รหัสผ่านของผู้ใช้ตัวอย่างทุกคน:')} <span class="mono">{session.demoPassword}</span></p>
    </div>
  {/if}
</div>

<style>
  .wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; padding: 24px; }
  .card { width: min(380px, 100%); display: flex; flex-direction: column; gap: 14px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; margin-bottom: 18px; }
  .mark { width: 30px; height: 30px; border-radius: 7px; background: var(--accent); color: white; display: grid; place-items: center; }
  .langs { color: var(--muted); }
  .langs button { background: none; border: 0; font: inherit; color: var(--muted); cursor: pointer; padding: 0; }
  .langs button.on { color: var(--accent); font-weight: 500; }
  .demo { width: min(560px, 100%); border-top: 1px solid var(--line); padding-top: 18px; display: flex; flex-direction: column; gap: 10px; }
  .accounts { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
