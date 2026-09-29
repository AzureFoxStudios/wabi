<script lang="ts">
  import { command, upload, authUrl } from '$lib/api.ts';
  import { app, T, toast, roleLabel } from '$lib/state.svelte.ts';
  import { ago, initials, userName, L, mentionHtml } from '$lib/format.ts';

  let {
    subjectType, subjectId, messages, files = [], contextOf = null, onchange = () => {}, placeholder = '', lastRead = 0,
  }: {
    subjectType: string; subjectId: string; messages: any[]; files?: any[]; contextOf?: ((m: any) => { label: string; href: string } | null) | null;
    onchange?: () => void; placeholder?: string; lastRead?: number;
  } = $props();

  let body = $state('');
  let pending = $state<{ id: string; name: string }[]>([]);
  let busy = $state(false);
  let ta: HTMLTextAreaElement;
  let fileInput: HTMLInputElement;
  let mention = $state<{ q: string; at: number } | null>(null);
  let mSel = $state(0);

  const people = $derived([
    ...(app.boot?.users ?? []).filter((u: any) => u.active && u.id !== app.boot.user.id).map((u: any) => ({ handle: u.username, name: u.name, sub: roleLabel(u.role) })),
    ...(app.boot?.pack.roles ?? []).map((r: any) => ({ handle: r.id, name: `${L(r.label)}`, sub: T('everyone in this role', 'ทุกคนในตำแหน่งนี้') })),
  ]);
  const suggestions = $derived(mention ? people.filter((p: any) => p.handle.startsWith(mention!.q.toLowerCase()) || p.name.toLowerCase().includes(mention!.q.toLowerCase())).slice(0, 6) : []);
  const fileById = $derived(new Map(files.map((f: any) => [f.id, f])));
  const sorted = $derived([...messages].sort((a, b) => a.seq - b.seq));

  function onInput() {
    const pos = ta.selectionStart;
    const before = body.slice(0, pos);
    const m = /(^|\s)@([\w.-]*)$/.exec(before);
    mention = m ? { q: m[2], at: pos - m[2].length - 1 } : null;
    mSel = 0;
  }
  function pick(p: any) {
    if (!mention) return;
    const end = mention.at + 1 + mention.q.length;
    body = `${body.slice(0, mention.at)}@${p.handle} ${body.slice(end)}`;
    mention = null;
    queueMicrotask(() => ta.focus());
  }
  function onKey(e: KeyboardEvent) {
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), (mSel = (mSel + 1) % suggestions.length));
      if (e.key === 'ArrowUp') return (e.preventDefault(), (mSel = (mSel - 1 + suggestions.length) % suggestions.length));
      if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), pick(suggestions[mSel]));
      if (e.key === 'Escape') return (e.stopPropagation(), (mention = null));
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }
  async function attach(list: FileList | null) {
    if (!list) return;
    for (const f of Array.from(list)) {
      try {
        const r = await upload(subjectType, subjectId, f);
        pending.push({ id: r.result.id, name: f.name });
      } catch (e) {
        toast((e as Error).message, 'danger');
      }
    }
    fileInput.value = '';
  }
  async function send() {
    if (!body.trim() && !pending.length) return;
    busy = true;
    try {
      await command('message.post', { subjectType, subjectId, body: body.trim() || pending.map((p) => p.name).join(', '), fileIds: pending.map((p) => p.id) });
      body = '';
      pending = [];
      onchange();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      busy = false;
    }
  }
  const isImage = (f: any) => f?.mime?.startsWith('image/');
</script>

<div class="disc">
  {#if !sorted.length}
    <p class="muted small empty">{T('No messages yet. Write questions, decisions and site photos here — everyone working on this sees the same thing, so nothing gets lost in LINE.', 'ยังไม่มีข้อความ เขียนคำถาม สิ่งที่ตกลงกัน หรือส่งรูปหน้างานไว้ที่นี่ ทุกคนที่ทำงานนี้จะเห็นเหมือนกัน ไม่หายในไลน์')}</p>
  {/if}
  <ol class="msgs">
    {#each sorted as m (m.id)}
      {@const ctx = contextOf?.(m)}
      {#if m.label}
        <li class="sys small">
          <span class="avatar sys">S</span>
          <span class="grow">{L(m.label)}{#if ctx} · <a class="link" href={ctx.href}>{ctx.label}</a>{/if}</span>
          <time class="faint tiny">{ago(m.createdAt)}</time>
        </li>
      {:else}
        <li class="msg" class:unread={lastRead && m.seq > lastRead && m.authorId !== app.boot.user.id} class:me={m.authorId === app.boot.user.id}>
          <span class="avatar">{initials(userName(m.authorId))}</span>
          <div class="grow">
            <div class="meta">
              <strong class="small">{userName(m.authorId)}</strong>
              <time class="faint tiny">{ago(m.createdAt)}</time>
              {#if ctx}<a class="tiny link" href={ctx.href}>{ctx.label}</a>{/if}
            </div>
            <p class="body">{@html mentionHtml(m.body)}</p>
            {#if m.fileIds?.length}
              <div class="files">
                {#each m.fileIds as fid (fid)}
                  {@const f = fileById.get(fid)}
                  {#if f && isImage(f)}
                    <a href={authUrl(`/api/files/${fid}`)} target="_blank" rel="noopener"><img src={authUrl(`/api/files/${fid}`)} alt={f.name} loading="lazy" /></a>
                  {:else}
                    <a class="chip small" href={authUrl(`/api/files/${fid}`)} target="_blank" rel="noopener">{f?.name ?? T('attachment', 'ไฟล์แนบ')}</a>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        </li>
      {/if}
    {/each}
  </ol>

  <div class="composer">
    <textarea
      bind:this={ta} bind:value={body} oninput={onInput} onkeydown={onKey} rows="2"
      placeholder={placeholder || T('Write a message to the team… type @ and pick a name to make sure that person sees it', 'เขียนข้อความถึงทีม… พิมพ์ @ แล้วเลือกชื่อ เพื่อให้คนนั้นเห็นข้อความนี้')}
      aria-label={T('Message', 'ข้อความ')}
    ></textarea>
    {#if suggestions.length}
      <ul class="mentions panel">
        {#each suggestions as p, i (p.handle)}
          <li><button class:sel={i === mSel} onmousedown={(e) => (e.preventDefault(), pick(p))}><strong>{p.name}</strong> <span class="muted small">{p.sub}</span></button></li>
        {/each}
      </ul>
    {/if}
    <div class="spread">
      <div class="row">
        <button class="btn ghost sm" onclick={() => fileInput.click()}>{T('Attach photo / file', 'แนบรูป/ไฟล์')}</button>
        <input bind:this={fileInput} type="file" multiple hidden onchange={(e) => attach((e.target as HTMLInputElement).files)} accept="image/*,application/pdf,.xlsx,.xls,.doc,.docx,.dwg" />
        {#each pending as p (p.id)}<span class="chip small">{p.name}</span>{/each}
      </div>
      <button class="btn primary sm" disabled={busy || (!body.trim() && !pending.length)} onclick={send}>{T('Post', 'ส่ง')} <kbd>⌘↵</kbd></button>
    </div>
  </div>
</div>

<style>
  .disc { display: flex; flex-direction: column; gap: 14px; }
  .empty { padding: 4px 0; }
  .msgs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .msg, .sys { display: flex; gap: 10px; align-items: flex-start; }
  .sys { align-items: center; color: var(--muted); }
  .msg.unread .body { background: var(--t-warning-bg); border-radius: 4px; box-shadow: -6px 0 0 var(--t-warning-bg), 6px 0 0 var(--t-warning-bg); }
  .meta { display: flex; gap: 8px; align-items: baseline; }
  .body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 1px; }
  .body :global(mark) { background: var(--accent-soft); color: var(--accent); border-radius: 3px; padding: 0 2px; }
  .files { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .files img { max-width: 220px; max-height: 160px; border-radius: 6px; border: 1px solid var(--line); display: block; object-fit: cover; }
  .chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; background: var(--surface); }
  .composer { position: relative; display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--line-strong); border-radius: var(--radius); padding: 8px; background: var(--surface); }
  .composer textarea { border: 0; padding: 4px 6px; min-height: 48px; box-shadow: none; }
  .mentions { position: absolute; left: 8px; bottom: 100%; margin: 0 0 4px; padding: 4px; list-style: none; min-width: 280px; box-shadow: var(--shadow-pop); z-index: 5; }
  .mentions button { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 6px 8px; border-radius: 5px; font: inherit; cursor: pointer; }
  .mentions button.sel { background: var(--accent-soft); }
</style>
