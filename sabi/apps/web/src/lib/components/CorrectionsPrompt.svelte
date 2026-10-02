<script lang="ts">
  /** Asks for the corrections password when the server requires it (see api.ts). */
  import { onMount } from 'svelte';
  import { setCorrectionsAsker } from '$lib/api.ts';
  import { T } from '$lib/state.svelte.ts';

  let dlg = $state<HTMLDialogElement | null>(null);
  let pw = $state('');
  let wrong = $state(false);
  let resolve: ((v: string | null) => void) | null = null;

  onMount(() => {
    setCorrectionsAsker((why) => new Promise((res) => {
      resolve = res;
      pw = '';
      wrong = why === 'wrong';
      dlg?.showModal();
    }));
    return () => setCorrectionsAsker(null);
  });
  function done(v: string | null) {
    dlg?.close();
    resolve?.(v);
    resolve = null;
  }
</script>

<dialog bind:this={dlg} onclose={() => resolve && done(null)} aria-labelledby="corr-title">
  <form method="dialog" onsubmit={(e) => (e.preventDefault(), done(pw || null))}>
    <h2 id="corr-title">{T('Corrections password', 'รหัสผ่านสำหรับการแก้ไข')}</h2>
    <p class="small muted">{T('This changes something already issued or posted. It is recorded in the corrections report with your name.', 'การดำเนินการนี้แก้ไขรายการที่ออกหรือบันทึกบัญชีแล้ว และจะถูกบันทึกในรายงานการแก้ไขพร้อมชื่อของคุณ')}</p>
    {#if wrong}<p class="small text-danger">{T('That password was not accepted.', 'รหัสผ่านไม่ถูกต้อง')}</p>{/if}
    <!-- svelte-ignore a11y_autofocus -->
    <input type="password" bind:value={pw} autocomplete="off" autofocus aria-label={T('Corrections password', 'รหัสผ่านสำหรับการแก้ไข')} />
    <div class="row">
      <button class="btn primary" disabled={!pw}>{T('Continue', 'ดำเนินการต่อ')}</button>
      <button type="button" class="btn ghost" onclick={() => done(null)}>{T('Cancel', 'ยกเลิก')}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 22px; width: min(420px, 92vw); background: var(--surface); color: var(--ink); }
  dialog::backdrop { background: rgba(20, 30, 28, 0.25); }
  form { display: flex; flex-direction: column; gap: 10px; }
  h2 { font-size: 1.05rem; }
</style>
