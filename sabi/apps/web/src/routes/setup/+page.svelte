<script lang="ts">
  import { goto } from '$app/navigation';
  import { post } from '$lib/api.ts';
  import { T } from '$lib/state.svelte.ts';

  let company = $state('');
  let name = $state('');
  let username = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      await post('setup', { company, name, username, password });
      await goto('/settings?welcome=1', { replaceState: true });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{T('Set up', 'ตั้งค่าเริ่มต้น')} · Sabi</title></svelte:head>

<div class="wrap">
  <form class="card" onsubmit={submit}>
    <div class="brand"><span class="mark">S</span> Sabi</div>
    <h1>{T('Set up Sabi for your company', 'เริ่มใช้ Sabi สำหรับบริษัทของคุณ')}</h1>
    <p class="muted">{T('Everything stays on this server. You can add your team and company details next.', 'ข้อมูลทั้งหมดเก็บไว้บนเซิร์ฟเวอร์นี้ เพิ่มทีมงานและข้อมูลบริษัทได้ในขั้นตอนถัดไป')}</p>
    <label class="field"><span>{T('Company name', 'ชื่อบริษัท/ร้าน')}</span><input bind:value={company} required /></label>
    <label class="field"><span>{T('Your name', 'ชื่อของคุณ')}</span><input bind:value={name} required /></label>
    <label class="field"><span>{T('Username', 'ชื่อผู้ใช้')}</span><input bind:value={username} autocomplete="username" required pattern="[a-z0-9_.\-]+" /></label>
    <label class="field"><span>{T('Password (8+ characters)', 'รหัสผ่าน (8 ตัวขึ้นไป)')}</span><input type="password" bind:value={password} minlength="8" autocomplete="new-password" required /></label>
    {#if error}<p class="err-text">{error}</p>{/if}
    <button class="btn primary lg" disabled={busy}>{T('Start', 'เริ่มใช้งาน')}</button>
  </form>
</div>

<style>
  .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .card { width: min(420px, 100%); display: flex; flex-direction: column; gap: 14px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; margin-bottom: 18px; }
  .mark { width: 30px; height: 30px; border-radius: 7px; background: var(--accent); color: white; display: grid; place-items: center; }
</style>
