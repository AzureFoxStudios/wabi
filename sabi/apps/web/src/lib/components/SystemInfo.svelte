<script lang="ts">
  /**
   * Controls an auditor asks about, on one page: how data flows, who can do what,
   * the corrections password, the state of the journal, and the sign-in / password log.
   */
  import { get, post } from '$lib/api.ts';
  import { app, T, toast, loadBoot } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L } from '$lib/format.ts';

  const sys = resource(() => get('system'));
  let cp = $state({ current: '', password: '' });
  async function saveCp(e: Event, remove = false) {
    e.preventDefault();
    try {
      await post('corrections-password', { current: cp.current, password: remove ? '' : cp.password });
      cp = { current: '', password: '' };
      await loadBoot();
      sys.reload();
      toast(remove ? T('Corrections password removed', 'ยกเลิกรหัสผ่านการแก้ไขแล้ว') : T('Corrections password set', 'ตั้งรหัสผ่านการแก้ไขแล้ว'), 'success');
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
  const capLabel: Record<string, [string, string]> = {
    all: ['Everything', 'ทั้งหมด'], 'jobs.write': ['Jobs', 'งาน'], 'documents.write': ['Draft documents', 'ร่างเอกสาร'],
    'documents.issue': ['Issue documents', 'ออกเอกสาร'], 'documents.void': ['Void documents', 'ยกเลิกเอกสาร'],
    'money.write': ['Record payments', 'บันทึกรับ/จ่าย'], 'stock.write': ['Stock', 'สต็อก'], 'parties.write': ['Customers & suppliers', 'ลูกค้า/ผู้ขาย'],
    'items.write': ['Items', 'สินค้า'], 'settings.write': ['Settings', 'ตั้งค่า'], 'ledger.write': ['Journal entries', 'บันทึกบัญชี'],
    'reports.read': ['Read reports', 'ดูรายงาน'], approve: ['Approve', 'อนุมัติ'],
  };
  const has = (r: any, c: string) => r.capabilities.includes('all') || r.capabilities.includes(c);
  const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const when = (iso: string) => new Intl.DateTimeFormat(app.locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(iso));
  const kindLabel = (k: string) => ({ login: T('Signed in', 'เข้าสู่ระบบ'), login_failed: T('Failed sign-in', 'เข้าสู่ระบบไม่สำเร็จ'), correction: T('Correction (password used)', 'แก้ไข (ใช้รหัสผ่าน)'), corrections_password: T('Corrections password changed', 'เปลี่ยนรหัสผ่านการแก้ไข') } as Record<string, string>)[k] ?? k;

  // System flowchart: boxes laid out left→right, arrows between them.
  const boxes = [
    { x: 10, y: 60, w: 130, t: ['Browser', 'เบราว์เซอร์'], s: ['screens, print', 'หน้าจอ งานพิมพ์'] },
    { x: 170, y: 60, w: 150, t: ['Commands', 'คำสั่ง'], s: ['sign-in, role, workflow', 'สิทธิ์ ขั้นตอนงาน'] },
    { x: 350, y: 60, w: 150, t: ['Event journal', 'บันทึกเหตุการณ์'], s: ['append-only, hash chain', 'ต่อท้าย เชื่อมแฮช'] },
    { x: 530, y: 60, w: 140, t: ['Projector', 'ตัวประมวลผล'], s: ['same transaction', 'ธุรกรรมเดียวกัน'] },
    { x: 700, y: 10, w: 150, t: ['Records', 'ข้อมูลงาน'], s: ['jobs, documents, stock', 'งาน เอกสาร สต็อก'] },
    { x: 700, y: 110, w: 150, t: ['General ledger', 'บัญชีแยกประเภท'], s: ['double entry', 'บัญชีคู่'] },
    { x: 170, y: 170, w: 150, t: ['Tax adapter', 'ตัวปรับภาษี'], s: ['VAT, WHT, checks', 'VAT หัก ณ ที่จ่าย'] },
    { x: 350, y: 170, w: 150, t: ['Backup / export', 'สำรอง/ส่งออก'], s: ['JSONL, verify', 'ตรวจสอบได้'] },
    { x: 530, y: 170, w: 140, t: ['Live updates', 'อัปเดตสด'], s: ['SSE, webhook', 'SSE เว็บฮุก'] },
  ];
  const arrows = [[140, 85, 170, 85], [320, 85, 350, 85], [500, 85, 530, 85], [670, 78, 700, 42], [670, 92, 700, 135], [245, 110, 245, 170], [425, 110, 425, 170], [600, 110, 600, 170], [775, 60, 775, 110]];
</script>

<div class="stack">
  <section class="section">
    <header><h2>{T('Corrections password', 'รหัสผ่านสำหรับการแก้ไข')}</h2>
      <span class="pill" class:tone-success={app.boot.correctionsProtected} class:tone-warning={!app.boot.correctionsProtected}>{app.boot.correctionsProtected ? T('on', 'เปิดใช้') : T('off', 'ปิด')}</span></header>
    <p class="small muted narrow">{T('A second password, separate from sign-in, that anyone must enter to void an issued document or payment, reverse a journal entry or post a manual entry. Every use is logged below with the user and time.', 'รหัสผ่านที่สอง แยกจากรหัสเข้าสู่ระบบ ต้องใส่ทุกครั้งที่ยกเลิกเอกสารที่ออกแล้วหรือการรับ/จ่ายเงิน กลับรายการบัญชี หรือบันทึกบัญชีด้วยมือ ทุกครั้งที่ใช้จะถูกบันทึกพร้อมผู้ใช้และเวลา')}</p>
    <form class="g3" onsubmit={(e) => saveCp(e)}>
      <label class="field"><span>{T('Your sign-in password', 'รหัสเข้าสู่ระบบของคุณ')}</span><input type="password" bind:value={cp.current} autocomplete="current-password" required /></label>
      <label class="field"><span>{T('New corrections password', 'รหัสผ่านการแก้ไขใหม่')}</span><input type="password" bind:value={cp.password} autocomplete="new-password" minlength="8" required /></label>
      <div class="row end"><button class="btn">{app.boot.correctionsProtected ? T('Change', 'เปลี่ยน') : T('Turn on', 'เปิดใช้')}</button>
        {#if app.boot.correctionsProtected}<button type="button" class="btn ghost" disabled={!cp.current} onclick={(e) => saveCp(e, true)}>{T('Turn off', 'ปิด')}</button>{/if}</div>
    </form>
  </section>

  <section class="section">
    <header><h2>{T('How data flows', 'การไหลของข้อมูล')}</h2></header>
    <svg viewBox="0 0 860 225" class="flowchart" role="img" aria-label={T('System flowchart', 'ผังระบบ')}>
      <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker></defs>
      {#each arrows as [x1, y1, x2, y2], i (i)}<line {x1} {y1} {x2} {y2} stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)" />{/each}
      {#each boxes as b, i (i)}
        <g><rect x={b.x} y={b.y} width={b.w} height="50" rx="6" class:key={i === 2} />
          <text x={b.x + b.w / 2} y={b.y + 21} text-anchor="middle" class="t">{T(b.t[0], b.t[1])}</text>
          <text x={b.x + b.w / 2} y={b.y + 38} text-anchor="middle" class="s">{T(b.s[0], b.s[1])}</text></g>
      {/each}
    </svg>
    <p class="small muted narrow">{T('Every change is a command. A command is checked (signed-in user, role, workflow rules, tax rules) and, if accepted, appended to the journal; records and ledger postings are derived from the journal in the same transaction. Nothing in the journal is updated or deleted — corrections are new events.', 'ทุกการเปลี่ยนแปลงคือคำสั่ง คำสั่งถูกตรวจ (ผู้ใช้ บทบาท ขั้นตอนงาน กฎภาษี) หากผ่านจะต่อท้ายในบันทึกเหตุการณ์ ข้อมูลงานและรายการบัญชีสร้างจากบันทึกในธุรกรรมเดียวกัน ไม่มีการแก้ไขหรือลบบันทึก การแก้ไขคือเหตุการณ์ใหม่')}</p>
  </section>

  {#if sys.error}<p class="err-text">{sys.error.message}</p>{/if}
  {#if sys.data}
    {@const s = sys.data}
    <section class="section">
      <header><h2>{T('Who can do what', 'ใครทำอะไรได้บ้าง')}</h2><span class="tiny muted">{s.counts.users} {T('active users', 'ผู้ใช้ที่ใช้งาน')}</span></header>
      <div class="scroll">
        <table class="data matrix">
          <thead><tr><th>{T('Role', 'บทบาท')}</th><th class="num">{T('People', 'คน')}</th>{#each s.capabilities.filter((c: string) => c !== 'all') as c (c)}<th class="cap"><span>{T(capLabel[c]?.[0] ?? c, capLabel[c]?.[1])}</span></th>{/each}</tr></thead>
          <tbody>
            {#each s.roles as r (r.id)}
              <tr><td><strong>{L(r.label)}</strong><div class="tiny muted">{r.users.map((u: any) => u.name).join(', ') || '—'}</div></td>
                <td class="num">{r.users.length}</td>
                {#each s.capabilities.filter((c: string) => c !== 'all') as c (c)}<td class="dot">{has(r, c) ? '●' : ''}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <header><h2>{T('Journal', 'บันทึกเหตุการณ์')}</h2></header>
      <dl class="facts small">
        <dt>{T('Events', 'เหตุการณ์')}</dt><dd>{s.head?.seq ?? 0}</dd>
        <dt>{T('Last change', 'เปลี่ยนแปลงล่าสุด')}</dt><dd>{s.head ? when(s.head.at) : '—'}</dd>
        <dt>{T('Chain head', 'แฮชล่าสุด')}</dt><dd class="mono tiny">{s.head?.hash ?? '—'}</dd>
        <dt>{T('Documents / ledger entries', 'เอกสาร / รายการบัญชี')}</dt><dd>{s.counts.documents} / {s.counts.entries}</dd>
        <dt>{T('Database', 'ฐานข้อมูล')}</dt><dd>{s.dbBytes ? kb(s.dbBytes) : '—'} · schema v{s.schemaVersion}</dd>
        <dt>{T('Configuration', 'การตั้งค่า')}</dt><dd>{L(s.pack.label)} · {L(s.jurisdiction.label)} · {s.jurisdiction.accounts} {T('accounts', 'บัญชี')}</dd>
      </dl>
      <details><summary class="small">{T('Events by type', 'เหตุการณ์แยกตามประเภท')}</summary>
        <table class="data compact"><tbody>{#each s.events as e (e.type)}<tr><td class="mono small">{e.type}</td><td class="num">{e.n}</td></tr>{/each}</tbody></table>
      </details>
      <p class="tiny muted">{T('Check the whole chain on the server with: sabi verify', 'ตรวจทั้งสายที่เซิร์ฟเวอร์ด้วยคำสั่ง: sabi verify')}</p>
    </section>

    <section class="section">
      <header><h2>{T('Sign-in and password log', 'บันทึกการเข้าระบบและการใช้รหัสผ่าน')}</h2><span class="tiny muted">{T('latest', 'ล่าสุด')} {s.authLog.length}</span></header>
      <table class="data">
        <thead><tr><th>{T('When', 'เมื่อ')}</th><th>{T('What', 'รายการ')}</th><th>{T('User', 'ผู้ใช้')}</th><th>IP</th><th>{T('Detail', 'รายละเอียด')}</th></tr></thead>
        <tbody>
          {#each s.authLog.slice(0, 100) as a (a.id)}
            <tr class:warn={a.kind === 'login_failed'}><td class="small nowrap">{when(a.at)}</td><td class="small">{kindLabel(a.kind)}</td><td class="small">{a.username}</td><td class="mono tiny">{a.ip ?? ''}</td><td class="small">{a.detail ?? ''}</td></tr>
          {:else}<tr><td colspan="5" class="muted small">—</td></tr>{/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>

<style>
  .narrow { max-width: 75ch; }
  .g3 { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; max-width: 760px; }
  .end { align-self: end; }
  .flowchart { width: 100%; max-width: 860px; color: var(--muted); margin: 6px 0 8px; }
  .flowchart rect { fill: var(--surface); stroke: var(--line-strong); }
  .flowchart rect.key { stroke: var(--accent); stroke-width: 2; }
  .flowchart .t { fill: var(--ink); font-size: 13px; font-weight: 600; }
  .flowchart .s { fill: var(--muted); font-size: 11px; }
  .scroll { overflow-x: auto; }
  .matrix th.cap { vertical-align: bottom; height: 110px; white-space: nowrap; padding: 0 2px; }
  .matrix th.cap span { writing-mode: vertical-rl; transform: rotate(180deg); display: inline-block; }
  .matrix td.dot { text-align: center; color: var(--accent); }
  .facts { display: grid; grid-template-columns: 220px 1fr; gap: 4px 14px; margin: 0 0 10px; }
  .facts dd { margin: 0; word-break: break-all; }
  .compact td { padding: 3px 8px; }
  .warn td { color: var(--t-danger); }
  @media (max-width: 900px) { .g3, .facts { grid-template-columns: 1fr; } }
</style>
