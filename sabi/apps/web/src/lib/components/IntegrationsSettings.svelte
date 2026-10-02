<script lang="ts">
  /** Owner-level settings kept in the journal: outgoing webhook and the sign-in notice. */
  import { command } from '$lib/api.ts';
  import { app, T, toast, loadBoot } from '$lib/state.svelte.ts';

  const cur = app.boot.settings ?? {};
  let hook = $state({ url: cur.webhook?.url ?? '', secret: cur.webhook?.secret ?? '' });
  let notice = $state<string>(cur.signInNotice ?? '');
  let saving = $state('');

  async function save(key: 'webhook' | 'signInNotice', value: unknown) {
    saving = key;
    try {
      await command('settings.update', { key, value });
      await loadBoot();
      toast(T('Saved', 'บันทึกแล้ว'), 'success');
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      saving = '';
    }
  }
  function newSecret() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    hook.secret = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
</script>

<div class="stack narrowform">
  <form class="stack" onsubmit={(e) => { e.preventDefault(); save('webhook', hook.url.trim() ? { url: hook.url.trim(), secret: hook.secret.trim() || undefined } : null); }}>
    <h3>{T('Send updates to another app (webhook)', 'ส่งข้อมูลไปแอปอื่น (Webhook)')}</h3>
    <p class="small muted">{T('After every change Sabi POSTs a short JSON summary (event type, what it is about, who, when) to this address — for LINE bots, spreadsheets, n8n or your own scripts. With a secret, the body is signed: header x-sabi-signature = sha256=HMAC(secret, body). Delivery is best-effort; the journal export is the complete record.', 'หลังทุกการเปลี่ยนแปลง ระบบจะส่ง JSON สรุปสั้น ๆ (ประเภท เรื่อง ใคร เมื่อไร) ไปยังที่อยู่นี้ ใช้กับบอท LINE สเปรดชีต n8n หรือสคริปต์ของคุณ ถ้าตั้งรหัสลับ จะมีลายเซ็นในเฮดเดอร์ x-sabi-signature การส่งเป็นแบบพยายามส่ง ข้อมูลครบถ้วนอยู่ในไฟล์ส่งออกบันทึกเหตุการณ์')}</p>
    <label class="field"><span>URL</span><input type="url" bind:value={hook.url} placeholder="https://example.com/sabi-hook" /></label>
    <label class="field"><span>{T('Signing secret (optional)', 'รหัสลับสำหรับลงลายเซ็น (ไม่บังคับ)')}</span>
      <div class="row"><input class="mono grow" bind:value={hook.secret} autocomplete="off" /><button type="button" class="btn sm" onclick={newSecret}>{T('Generate', 'สร้าง')}</button></div></label>
    <div class="row"><button class="btn" disabled={saving === 'webhook'}>{hook.url.trim() ? T('Save webhook', 'บันทึกเว็บฮุก') : T('Turn off webhook', 'ปิดเว็บฮุก')}</button></div>
  </form>

  <form class="stack" onsubmit={(e) => { e.preventDefault(); save('signInNotice', notice.trim() || null); }}>
    <h3>{T('Sign-in notice', 'ข้อความหน้าเข้าสู่ระบบ')}</h3>
    <p class="small muted">{T('Shown on the first screen, above the sign-in form — for example a house rule, or a software statement if a tax authority has registered your installation. Do not claim a registration you do not hold (see docs/08-certification.md).', 'แสดงที่หน้าจอแรกเหนือช่องเข้าสู่ระบบ เช่น ระเบียบภายใน หรือข้อความรับรองซอฟต์แวร์หากกรมสรรพากรได้ขึ้นทะเบียนแล้ว ห้ามอ้างการขึ้นทะเบียนที่ยังไม่ได้รับ (ดู docs/08-certification.md)')}</p>
    <textarea rows="4" bind:value={notice} maxlength="1000"></textarea>
    <div class="row"><button class="btn" disabled={saving === 'signInNotice'}>{T('Save notice', 'บันทึกข้อความ')}</button><span class="tiny muted">{notice.length}/1000</span></div>
  </form>
</div>

<style>
  .narrowform { max-width: 640px; }
  textarea { font: inherit; width: 100%; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--surface); }
  form + form { margin-top: 18px; }
</style>
