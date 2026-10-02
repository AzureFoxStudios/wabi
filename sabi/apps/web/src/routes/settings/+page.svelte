<script lang="ts">
  import { page } from '$app/state';
  import { get, post, command, authUrl } from '$lib/api.ts';
  import { local } from '$lib/storage.ts';
  import { app, T, toast, can, roleLabel, loadBoot } from '$lib/state.svelte.ts';
  import { resource } from '$lib/resource.svelte.ts';
  import { L, date } from '$lib/format.ts';
  import ImportCsv from '$lib/components/ImportCsv.svelte';
  import IntegrationsSettings from '$lib/components/IntegrationsSettings.svelte';
  import SystemInfo from '$lib/components/SystemInfo.svelte';

  const welcome = page.url.searchParams.get('welcome') === '1';
  const owner = can('all');
  const boot = $derived(app.boot);
  let section = $state(page.url.hash.slice(1) || 'company');
  const sections = $derived([
    { id: 'company', label: T('Company', 'บริษัท') },
    ...(can('settings.write') ? [{ id: 'users', label: T('People who can log in', 'คนที่เข้าระบบได้') }] : []),
    { id: 'me', label: T('My account', 'บัญชีของฉัน') },
    { id: 'config', label: T('How this business is set up', 'รูปแบบธุรกิจที่ตั้งไว้') },
    ...(can('parties.write') || can('items.write') ? [{ id: 'import', label: T('Bring in lists from Excel', 'นำเข้ารายชื่อจาก Excel') }] : []),
    ...(owner ? [{ id: 'integrations', label: T('Connect other apps', 'เชื่อมต่อแอปอื่น') }] : []),
    ...(owner ? [{ id: 'controls', label: T('Safety & checks', 'ความปลอดภัยและการตรวจสอบ') }] : []),
    ...(owner ? [{ id: 'data', label: T('Backup (keep a copy)', 'สำรองข้อมูล (เก็บสำเนา)') }] : []),
  ]);
  // Follow the address when it changes without a remount (links to /settings#users from elsewhere, back/forward).
  $effect(() => {
    const h = page.url.hash.slice(1);
    if (h) section = h;
  });
  $effect(() => {
    const onHash = () => location.hash.length > 1 && (section = location.hash.slice(1));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
  function go(id: string) {
    section = id;
    history.replaceState(history.state, '', `#${id}`);
  }

  // ── Company ──
  const c0 = app.boot.company;
  let co = $state({
    name: c0.name ?? '', taxId: c0.taxId ?? '', phone: c0.phone ?? '', email: c0.email ?? '',
    address: { line1: '', district: '', province: '', postcode: '', ...(c0.address ?? {}) }, fields: { ...(c0.fields ?? {}) } as Record<string, any>,
  });
  let busy = $state(false);
  async function saveCompany(e: Event) {
    e.preventDefault();
    busy = true;
    try {
      await command('company.update', co);
      await loadBoot();
      toast(T('Company saved', 'บันทึกข้อมูลบริษัทแล้ว'), 'success');
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }

  // ── Users ──
  const users = resource(() => (can('settings.write') ? get('users') : Promise.resolve([])));
  let nu = $state({ name: '', username: '', role: 'sales', password: '' });
  async function addUser(e: Event) {
    e.preventDefault();
    try {
      const u = await command('user.create', { name: nu.name, username: nu.username, role: nu.role });
      if (nu.password) await post('password', { userId: u.id, password: nu.password });
      nu = { name: '', username: '', role: nu.role, password: '' };
      toast(T('User added', 'เพิ่มผู้ใช้แล้ว'), 'success');
      users.reload();
      loadBoot();
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
  async function setRole(id: string, role: string) {
    try {
      await command('user.update', { id, role });
      users.reload();
      loadBoot();
    } catch (err) {
      toast((err as Error).message, 'danger');
      users.reload();
    }
  }
  async function setActive(id: string, active: boolean) {
    try {
      await command('user.update', { id, active });
      users.reload();
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
  let resetFor = $state<string | null>(null);
  let resetPw = $state('');
  async function resetPassword(id: string) {
    try {
      await post('password', { userId: id, password: resetPw });
      resetFor = null;
      resetPw = '';
      toast(T('Password set', 'ตั้งรหัสผ่านแล้ว'), 'success');
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }

  // ── Me ──
  let pw = $state({ current: '', password: '' });
  async function changePw(e: Event) {
    e.preventDefault();
    try {
      await post('password', pw);
      pw = { current: '', password: '' };
      toast(T('Password changed', 'เปลี่ยนรหัสผ่านแล้ว'), 'success');
    } catch (err) {
      toast((err as Error).message, 'danger');
    }
  }
  async function setLocale(locale: 'th' | 'en') {
    await command('user.update', { id: app.boot.user.id, locale });
    app.locale = locale;
    local.set('sabi.locale', locale);
    await loadBoot();
  }
  // Plain words for what a role may do (the capability ids are for configuration files, not people).
  const capLabel = (c: string) => ({
    'jobs.write': T('open and update jobs', 'เปิดและแก้ไขงาน'), 'documents.write': T('write quotes, orders and invoices', 'ทำใบเสนอราคา ใบสั่ง ใบแจ้งหนี้'),
    'documents.issue': T('issue documents to customers', 'ออกเอกสารให้ลูกค้า'), 'documents.void': T('cancel issued documents', 'ยกเลิกเอกสารที่ออกแล้ว'),
    'money.write': T('record money in and out', 'บันทึกรับ–จ่ายเงิน'), 'stock.write': T('move and correct stock', 'เบิก ย้าย และแก้ยอดของในคลัง'),
    'parties.write': T('add and edit customers & suppliers', 'เพิ่มและแก้ไขลูกค้าและผู้ขาย'), 'items.write': T('add and edit products', 'เพิ่มและแก้ไขสินค้า'),
    'settings.write': T('change settings and people', 'เปลี่ยนการตั้งค่าและผู้ใช้'), 'ledger.write': T('make accounting entries', 'ลงรายการบัญชี'),
    'reports.read': T('see money, tax and reports', 'ดูการเงิน ภาษี และรายงาน'), approve: T('approve discounts and orders', 'อนุมัติส่วนลดและใบสั่ง'),
  } as Record<string, string>)[c] ?? c;
  const effectLabel = (e: string) => ({
    reserve: T('reserves stock', 'จองของในคลัง'), stock_out: T('takes goods out of stock', 'ตัดของออกจากคลัง'), stock_in: T('adds goods to stock', 'เพิ่มของเข้าคลัง'),
    receivable: T('customer now owes us', 'ลูกค้าต้องจ่ายเรา'), payable: T('we now owe the supplier', 'เราต้องจ่ายผู้ขาย'),
  } as Record<string, string>)[e] ?? e;
  const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;
  function rateText(rates: { rate: number; from: string; to?: string | null }[]): string {
    if (rates.length === 1 && !rates[0].to) return pct(rates[0].rate);
    return rates.map((r, i) => r.to ? T(`${pct(r.rate)} until ${date(r.to)}`, `${pct(r.rate)} ถึง ${date(r.to)}`) : i > 0 ? T(`then ${pct(r.rate)} from ${date(r.from)} — Sabi warns you; check the law nearer the time`, `แล้วเป็น ${pct(r.rate)} ตั้งแต่ ${date(r.from)} — ระบบจะเตือน ควรตรวจกฎหมายอีกครั้งเมื่อใกล้ถึง`) : pct(r.rate)).join(', ');
  }
  const phaseLabel: Record<string, string> = { open: T('open', 'เปิด'), done: T('done', 'เสร็จ'), cancelled: T('cancelled', 'ยกเลิก'), draft: T('draft', 'ร่าง'), issued: T('issued', 'ออกแล้ว'), closed: T('closed', 'ปิด'), void: T('void', 'ยกเลิก') };
</script>

<svelte:head><title>{T('Settings', 'ตั้งค่า')} · Sabi</title></svelte:head>

<div class="page">
  <header class="page-head"><div><h1>{T('Settings', 'ตั้งค่า')}</h1><p class="hint">{T('Company details, who can log in, your password, and backups. Most people only need “My account”.', 'ข้อมูลบริษัท ใครเข้าระบบได้บ้าง รหัสผ่าน และการสำรองข้อมูล คนส่วนใหญ่ใช้แค่ “บัญชีของฉัน”')}</p></div></header>
  {#if welcome}
    <div class="callout success welcome">
      <strong>{T('Welcome to Sabi.', 'ยินดีต้อนรับสู่ Sabi')}</strong>
      {T('Three steps to start: 1. Check the company details below (they are printed on every document). 2. Add your team under “People who can log in”. 3. Add your first customer and open a job.', 'เริ่มต้น 3 ขั้นตอน: 1. ตรวจข้อมูลบริษัทด้านล่าง (พิมพ์บนเอกสารทุกใบ) 2. เพิ่มทีมงานที่ “คนที่เข้าระบบได้” 3. เพิ่มลูกค้ารายแรก แล้วเปิดงาน')}
    </div>
  {/if}
  <div class="layout">
    <nav class="side" aria-label={T('Settings sections', 'หมวดการตั้งค่า')}>
      {#each sections as s (s.id)}<button class:on={section === s.id} onclick={() => go(s.id)}>{s.label}</button>{/each}
    </nav>
    <div class="body">
      {#if section === 'company'}
        <form class="stack narrowform" onsubmit={saveCompany}>
          <p class="small muted">{T('These details are printed at the top of every quotation, tax invoice and receipt. Check they are exactly right — the Revenue Department requires it.', 'ข้อมูลนี้พิมพ์อยู่ด้านบนของใบเสนอราคา ใบกำกับภาษี และใบเสร็จทุกใบ ต้องถูกต้องตรงตามทะเบียน เพราะกรมสรรพากรกำหนด')}</p>
          <fieldset class="stack" disabled={!can('settings.write')}>
            <label class="field"><span>{T('Registered name', 'ชื่อจดทะเบียน')}</span><input bind:value={co.name} required /></label>
            <div class="g2">
              <label class="field"><span>{T('Tax ID', 'เลขประจำตัวผู้เสียภาษี')}</span><input bind:value={co.taxId} class="mono" inputmode="numeric" /></label>
              <label class="field"><span>{T('Phone', 'โทรศัพท์')}</span><input bind:value={co.phone} /></label>
            </div>
            <label class="field"><span>{T('Email', 'อีเมล')}</span><input bind:value={co.email} type="email" /></label>
            <label class="field"><span>{T('Address', 'ที่อยู่')}</span><input bind:value={co.address.line1} /></label>
            <div class="g3">
              <input bind:value={co.address.district} placeholder={T('District', 'อำเภอ/เขต')} aria-label={T('District', 'อำเภอ/เขต')} />
              <input bind:value={co.address.province} placeholder={T('Province', 'จังหวัด')} aria-label={T('Province', 'จังหวัด')} />
              <input bind:value={co.address.postcode} placeholder={T('Postcode', 'รหัสไปรษณีย์')} aria-label={T('Postcode', 'รหัสไปรษณีย์')} />
            </div>
            {#each boot.jurisdiction.companyFields as f (f.key)}
              {#if f.type === 'boolean'}
                <label class="row small"><input type="checkbox" bind:checked={co.fields[f.key]} /> {L(f.label)}</label>
              {:else}
                <label class="field"><span>{L(f.label)}</span><input bind:value={co.fields[f.key]} placeholder={L(f.placeholder)} /></label>
              {/if}
            {/each}
            <div class="row"><button class="btn primary" disabled={busy}>{T('Save', 'บันทึก')}</button></div>
          </fieldset>
        </form>
      {:else if section === 'users'}
        <table class="data">
          <thead><tr><th>{T('Name', 'ชื่อ')}</th><th>{T('Username', 'ชื่อผู้ใช้')}</th><th>{T('Job role', 'ตำแหน่ง')}</th><th></th></tr></thead>
          <tbody>
            {#each (users.data as any[]) ?? [] as u (u.id)}
              <tr class:inactive={!u.active}>
                <td>{u.name}{#if u.id === boot.user.id} <span class="tiny muted">({T('you', 'คุณ')})</span>{/if}</td>
                <td class="mono small">{u.username}</td>
                <td><select value={u.role} onchange={(e) => setRole(u.id, (e.currentTarget as HTMLSelectElement).value)} disabled={u.id === boot.user.id} style="width:auto">{#each boot.pack.roles as r (r.id)}<option value={r.id}>{L(r.label)}</option>{/each}</select></td>
                <td class="nowrap">
                  {#if resetFor === u.id}
                    <input type="password" bind:value={resetPw} placeholder={T('New password (8+)', 'รหัสใหม่ (8 ตัวขึ้นไป)')} style="width:180px;height:28px" />
                    <button class="btn sm" disabled={resetPw.length < 8} onclick={() => resetPassword(u.id)}>{T('Set', 'ตั้ง')}</button>
                    <button class="btn ghost sm" onclick={() => (resetFor = null)}>×</button>
                  {:else if owner && u.id !== boot.user.id}
                    <button class="btn ghost sm" onclick={() => { resetFor = u.id; resetPw = ''; }}>{T('Set password', 'ตั้งรหัสผ่าน')}</button>
                  {/if}
                  {#if u.id !== boot.user.id}<button class="btn ghost sm" onclick={() => setActive(u.id, !u.active)}>{u.active ? T('Block login (left the company)', 'ปิดการเข้าระบบ (ลาออกแล้ว)') : T('Allow login again', 'เปิดให้เข้าระบบอีกครั้ง')}</button>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <form class="adduser" onsubmit={addUser}>
          <h3>{T('Give someone a login', 'เพิ่มคนเข้าระบบ')}</h3>
          <div class="g4">
            <input bind:value={nu.name} placeholder={T('Full name', 'ชื่อ-นามสกุล')} required aria-label={T('Full name', 'ชื่อ-นามสกุล')} />
            <input bind:value={nu.username} placeholder={T('username (a–z, 0–9)', 'ชื่อผู้ใช้ (a–z, 0–9)')} required pattern="[a-z0-9_.\-]{'{2,40}'}" aria-label={T('Username', 'ชื่อผู้ใช้')} />
            <select bind:value={nu.role} aria-label={T('Role', 'บทบาท')}>{#each boot.pack.roles as r (r.id)}<option value={r.id}>{L(r.label)}</option>{/each}</select>
            {#if owner}<input type="password" bind:value={nu.password} placeholder={T('Password (8+)', 'รหัสผ่าน (8 ตัวขึ้นไป)')} minlength="8" aria-label={T('Password', 'รหัสผ่าน')} />{/if}
          </div>
          <button class="btn primary">{T('Add', 'เพิ่ม')}</button>
        </form>
        <h3 class="rolehdr">{T('What each job role is allowed to do', 'แต่ละตำแหน่งทำอะไรได้บ้าง')}</h3>
        <dl class="roles">
          {#each boot.pack.roles as r (r.id)}<dt>{L(r.label)}</dt><dd class="small muted">{r.capabilities.includes('all') ? T('Everything, including settings and approvals', 'ทุกอย่าง รวมถึงการตั้งค่าและอนุมัติ') : T('Can ', 'ทำได้: ') + r.capabilities.map(capLabel).join(', ')}</dd>{/each}
        </dl>
      {:else if section === 'me'}
        <div class="stack narrowform">
          <p>{boot.user.name} · <span class="mono">{boot.user.username}</span> · {roleLabel(boot.user.role)}</p>
          <div class="row"><span class="small muted">{T('Language', 'ภาษา')}</span>
            <button class="btn sm" class:primary={app.locale === 'th'} onclick={() => setLocale('th')}>ไทย</button>
            <button class="btn sm" class:primary={app.locale === 'en'} onclick={() => setLocale('en')}>English</button>
          </div>
          <form class="stack" onsubmit={changePw}>
            <h3>{T('Change password', 'เปลี่ยนรหัสผ่าน')}</h3>
            <label class="field"><span>{T('Current password', 'รหัสผ่านปัจจุบัน')}</span><input type="password" bind:value={pw.current} autocomplete="current-password" required /></label>
            <label class="field"><span>{T('New password (8+ characters)', 'รหัสผ่านใหม่ (8 ตัวขึ้นไป)')}</span><input type="password" bind:value={pw.password} autocomplete="new-password" minlength="8" required /></label>
            <div class="row"><button class="btn">{T('Change', 'เปลี่ยน')}</button></div>
          </form>
        </div>
      {:else if section === 'config'}
        <div class="stack">
          <p class="small muted cfgnote">{T(
            `This workspace runs the “${L(boot.pack.label)}” business pack (v${boot.pack.version}) with the ${L(boot.jurisdiction.label)} tax adapter. Job types, workflows, document types, fields and roles below come from configuration, not from the core — a different business uses a different pack.`,
            `ระบบนี้ใช้ชุดตั้งค่าธุรกิจ “${L(boot.pack.label)}” (v${boot.pack.version}) และตัวปรับภาษี ${L(boot.jurisdiction.label)} ประเภทงาน ขั้นตอน เอกสาร ฟิลด์ และบทบาทด้านล่างมาจากการตั้งค่า ไม่ได้ฝังในระบบหลัก`,
          )}</p>
          {#each boot.pack.jobTypes as jt (jt.id)}
            <section class="section">
              <header><h2>{L(jt.label)}</h2><span class="tiny muted">{T('Job numbers start with', 'เลขที่งานขึ้นต้นด้วย')} <span class="mono">{jt.numbering?.prefix ?? ''}</span></span></header>
              {#if jt.description}<p class="hint">{L(jt.description)}</p>{/if}
              <p class="tiny muted">{T('The steps, in order. Under each step: whose turn it is.', 'ขั้นตอนตามลำดับ ใต้แต่ละขั้นบอกว่าถึงตาใคร')}</p>
              <ol class="flow">
                {#each jt.workflow.states as s (s.id)}<li class={`tone-${s.tone ?? 'neutral'}`}><strong>{L(s.label)}</strong><span class="tiny muted">{s.phase === 'done' ? T('finished', 'จบงาน') : s.phase === 'cancelled' ? T('stopped / lost', 'ยกเลิก / ไม่ได้งาน') : s.ownerRole ? roleLabel(s.ownerRole) : (phaseLabel[s.phase] ?? s.phase)}</span></li>{/each}
              </ol>
              <p class="small muted">{T('Details we write down for this job', 'ข้อมูลที่จดไว้ในงานนี้')}: {jt.fields.map((f: any) => L(f.label)).join(', ') || '—'}</p>
              <p class="small muted">{T('Paperwork used', 'เอกสารที่ใช้')}: {jt.documentTypes.map((d: string) => L(boot.pack.documentTypes.find((x: any) => x.id === d)?.label)).join(' → ')}</p>
            </section>
          {/each}
          <section class="section">
            <header><h2>{T('Document types', 'ประเภทเอกสาร')}</h2></header>
            <table class="data">
              <thead><tr><th>{T('Document', 'เอกสาร')}</th><th>{T('Number starts with', 'เลขที่ขึ้นต้นด้วย')}</th><th>{T('What it does', 'มีผลอะไร')}</th><th>{T('Next document', 'เอกสารถัดไป')}</th><th>{T('Needs approval when', 'ต้องอนุมัติเมื่อ')}</th></tr></thead>
              <tbody>
                {#each boot.pack.documentTypes as d (d.id)}
                  <tr>
                    <td>{L(d.label)}{#if d.description}<br /><span class="tiny muted">{L(d.description)}</span>{/if}</td><td class="mono small">{d.numbering.prefix}</td>
                    <td class="small">{d.effects.map(effectLabel).join(', ') || T('nothing — just paper', 'ไม่มี — เป็นเอกสารอย่างเดียว')}</td>
                    <td class="small">{d.convertsTo.map((t: string) => L(boot.pack.documentTypes.find((x: any) => x.id === t)?.label)).join(', ') || '—'}</td>
                    <td class="small">{d.workflow.transitions.filter((t: any) => t.requires?.approval).map((t: any) => `${L(t.label)} → ${roleLabel(t.requires.approval.role)}${t.requires.approval.reason ? ` (${L(t.requires.approval.reason)})` : t.requires.approval.when ? ` (${t.requires.approval.when})` : ''}`).join('; ') || '—'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </section>
          <section class="section">
            <header><h2>{T('VAT choices on products', 'ตัวเลือก VAT ของสินค้า')}</h2></header>
            <p class="hint">{T('These come from the Thai tax rules built into Sabi. When the rate changes by law, the new rate starts on its date by itself.', 'มาจากกฎภาษีไทยที่อยู่ในระบบ เมื่อกฎหมายเปลี่ยนอัตรา ระบบจะใช้อัตราใหม่เองตามวันที่')}</p>
            <ul class="small plain">
              {#each boot.jurisdiction.taxCodes as t (t.code)}<li><strong class="w500">{L(t.label)}</strong>{' — '}{rateText(t.rates)} <span class="ref">{t.code}</span></li>{/each}
            </ul>
          </section>
        </div>
      {:else if section === 'import'}
        <ImportCsv />
      {:else if section === 'integrations'}
        <IntegrationsSettings />
      {:else if section === 'controls'}
        <SystemInfo />
      {:else if section === 'data'}
        <div class="stack narrowform">
          <p>{T('Your data belongs to you. Download a full copy any time and keep it somewhere safe (a USB drive or another computer). With this file, everything can be rebuilt.', 'ข้อมูลเป็นของคุณ ดาวน์โหลดสำเนาทั้งหมดได้ทุกเมื่อ แล้วเก็บไว้ในที่ปลอดภัย (แฟลชไดรฟ์ หรือคอมพิวเตอร์อีกเครื่อง) ไฟล์นี้ใช้สร้างข้อมูลทั้งหมดขึ้นมาใหม่ได้')}</p>
          <div class="row"><a class="btn primary" href={authUrl('/api/export')} download>{T('Download a full copy of everything', 'ดาวน์โหลดสำเนาข้อมูลทั้งหมด')}</a></div>
          <p class="small muted">{T('Reports for Excel can be downloaded on the “Tax & reports” page.', 'ดาวน์โหลดรายงานสำหรับ Excel ได้ที่หน้า “ภาษีและรายงาน”')}</p>
          <h3>{T('Automatic backups (for the person who installed Sabi)', 'สำรองอัตโนมัติ (สำหรับคนที่ติดตั้งระบบ)')}</h3>
          <p class="small">{T('On the machine running Sabi, schedule:', 'บนเครื่องที่รัน Sabi ให้ตั้งเวลารัน:')}</p>
          <pre class="mono small">sabi backup /path/to/backups --data /var/lib/sabi
sabi verify --data /var/lib/sabi</pre>
          <p class="small muted">{T('A backup folder holds a SQLite snapshot, the journal as JSON lines and all attachments. `sabi restore` rebuilds a database from the journal. Keep tax documents for at least 5 years.', 'โฟลเดอร์สำรองมีสแนปช็อต SQLite บันทึกเหตุการณ์ และไฟล์แนบทั้งหมด ใช้ `sabi restore` เพื่อสร้างฐานข้อมูลใหม่ เก็บเอกสารภาษีอย่างน้อย 5 ปี')}</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .welcome { margin-bottom: 20px; }
  .layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 36px; }
  .side { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 20px; align-self: start; }
  .side button { font: inherit; text-align: left; background: none; border: 0; padding: 7px 10px; border-radius: var(--radius-sm); cursor: pointer; color: var(--ink-2); }
  .side button:hover { background: var(--sunken); }
  .side button.on { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
  .narrowform { max-width: 620px; }
  fieldset { border: 0; padding: 0; margin: 0; }
  .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .g3 { display: grid; grid-template-columns: 1fr 1fr 120px; gap: 8px; }
  .g4 { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 8px; margin: 8px 0; }
  .adduser { margin-top: 22px; }
  .inactive td { opacity: 0.5; }
  .rolehdr { margin-top: 28px; }
  .roles { display: grid; grid-template-columns: 140px 1fr; gap: 6px 14px; }
  .roles dd { margin: 0; }
  .flow { list-style: none; padding: 0; margin: 0 0 10px; display: flex; flex-wrap: wrap; gap: 6px; }
  .flow li { display: flex; flex-direction: column; padding: 6px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); font-size: 0.88rem; }
  .plain { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  pre { background: var(--sunken); padding: 10px 12px; border-radius: var(--radius-sm); overflow-x: auto; }
  .cfgnote { max-width: 75ch; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .side { flex-direction: row; overflow-x: auto; position: static; } .g4 { grid-template-columns: 1fr 1fr; } }
</style>
