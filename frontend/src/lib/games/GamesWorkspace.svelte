<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { channels, currentUser } from '$lib/socket';
  import { getAuthToken, authSessionGeneration } from '$lib/authSession';
  import { getServerUrl } from '$lib/serverUrl';
  import BaseModal from '$lib/components/BaseModal.svelte';
  import { createGameClient } from './client';
  import { board, selections, privateSelection, safeAuthorizeUrl, steamAppId, steamLaunchUrl, steamStoreUrl,
    type GameBoard, type GameSelection, type GamePublicBoard, type SteamCapabilities, type LibraryGame, type LinkFlow, type Member } from './model';
  import type { GamesRequest } from './navigation';
  let { request, onclose }: { request: GamesRequest; onclose: () => void } = $props();
  const own = $derived(!request.profileId || request.profileId === request.owner);
  let tab = $state<'board'|'steam'|'match'>(untrack(()=>request.tab));
  let saved = $state<GameBoard|null>(null);
  let draft = $state<GameSelection[]>([]);
  let showLink = $state(false);
  let publicLink = $state<string|null>(null);
  let busy = $state(false), loading = $state(true), error = $state(''), notice = $state('');
  let capabilities = $state<SteamCapabilities|null>(null);
  let flow = $state<LinkFlow|null>(null), receipt = $state('');
  let library = $state<LibraryGame[]>([]), search = $state('');
  let newTitle = $state(''), newId = $state('');
  let channel = $state(untrack(()=>request.channelId));
  let members = $state<Member[]>([]), chosen = $state<string[]>(untrack(()=>[request.owner]));
  let matches = $state<LibraryGame[]|null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true, memberVersion=0;
  const client = createGameClient(() => ({ server:getServerUrl(),userId:String(get(currentUser)?.dbUserId||''),
    generation:authSessionGeneration(getServerUrl()),token:getAuthToken(getServerUrl()) }));
  const dirty = $derived(!!saved && (JSON.stringify(draft)!==JSON.stringify(saved.entries) || showLink!==saved.showSteamLink));
  const filtered = $derived(library.filter(g=>g.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).slice(0,100));
  const sharedCount = $derived(draft.filter(g=>g.visibility==='server').length);
  function fail(e: unknown) { if(alive && client.active()) error=e instanceof Error?e.message:'Could not complete this action.'; }
  function apply(next: GameBoard) {saved=next;draft=structuredClone(next.entries);showLink=next.showSteamLink;}
  async function reload() {
    if(busy || (dirty && !window.confirm('Discard your unsaved game edits and reload?'))) return;
    loading=true;error='';notice='';library=[];
    try {
      if(own) apply(board(await client.request('/games/me')));
      else {
        const value=await client.request<GamePublicBoard>(`/games/profile/${encodeURIComponent(request.profileId||'')}`);
        draft=selections(value.entries).filter(e=>e.visibility==='server');
        publicLink=typeof value.steamProfileUrl==='string' && /^https:\/\/steamcommunity\.com\/profiles\/[0-9]{17}\/$/.test(value.steamProfileUrl)?value.steamProfileUrl:null;
      }
    } catch(e) {fail(e);} finally {if(alive) loading=false;}
  }
  onMount(() => {
    void reload();
    if(own) void client.request<SteamCapabilities>('/steam/capabilities').then(v=>{capabilities=v;}).catch(fail);
    if(channel && own) void loadMembers();
    const hide=()=>{matches=null;};
    document.addEventListener('visibilitychange',hide);
    return ()=>{alive=false;client.dispose();flow=null;receipt='';library=[];clearTimeout(timer);document.removeEventListener('visibilitychange',hide);};
  });
  function close() {if(!dirty || window.confirm('Discard unsaved game changes?')) onclose();}
  async function act(work:()=>Promise<void>) {
    if(busy || !client.active()) return;busy=true;error='';notice='';
    try {await work();} catch(e) {fail(e);} finally {if(alive) busy=false;}
  }
  function add(game: LibraryGame) {
    if(draft.some(e=>e.key===game.key)) {notice='That game is already on your board.';return;}
    if(draft.length>=64) {error='Choose at most 64 games.';return;}
    try {draft=[...draft,privateSelection(game)];notice='Added to your private draft. Save when ready.';} catch(e) {fail(e);}
  }
  function addManual() {
    const code=newId.trim();
    const key=code?(/^[0-9]+$/.test(code)?`steam:${code}`:code):`local:${crypto.randomUUID()}`;
    const before=draft.length;add({key,title:newTitle.trim()});if(draft.length>before) {newTitle='';newId='';}
  }
  async function save() {
    if(!saved) return;
    await act(async()=>{const entries=selections($state.snapshot(draft));
      apply(board(await client.request('/games/me','PUT',{revision:saved!.revision,entries,showSteamLink:showLink})));
      notice='Game board saved.';matches=null;});
  }
  async function startLink() {
    if(!saved || dirty) {error='Save or discard game edits before connecting Steam.';return;}
    await act(async()=>{const next=await client.request<LinkFlow>('/steam/link/start','POST',{revision:saved!.revision});
      safeAuthorizeUrl(next.authorizeUrl);flow=next;receipt='';});
  }
  async function finishLink() {
    if(!flow) return;
    await act(async()=>{apply(board(await client.request('/steam/link/complete','POST',{ticket:flow!.ticket,proof:flow!.proof,receipt:receipt.trim()})));
      flow=null;receipt='';notice='Steam connected. Nothing is public until you choose to share it.';});
  }
  async function disconnect() {
    if(!saved || dirty || !window.confirm('Disconnect Steam? Your deliberately saved games stay on the board.')) return;
    await act(async()=>{apply(board(await client.request('/steam/unlink','POST',{revision:saved!.revision})));flow=null;library=[];notice='Steam disconnected.';});
  }
  async function loadLibrary() {
    await act(async()=>{const result=await client.request<{availability:string;games:LibraryGame[];reason?:string}>('/steam/library','POST');
      if(result.availability!=='available') {library=[];notice=result.reason||'Steam game details are unavailable. Manual entry works without them.';return;}
      if(!Array.isArray(result.games) || result.games.length>20000) throw new Error('Invalid Steam library response');
      library=result.games.filter(g=>typeof g?.title==='string' && !!steamAppId(g.key));
      notice=library.length?`${library.length} games available to select. This list is not published.`:'Steam returned an empty library.';});
  }
  async function loadMembers() {
    const version=++memberVersion;matches=null;members=[];chosen=[request.owner];
    if(!channel) return;
    try {const result=await client.request<{members:Member[]}>(`/games/members/${encodeURIComponent(channel)}`);
      if(version===memberVersion) members=result.members;
    } catch(e) {if(version===memberVersion) fail(e);}
  }
  async function compare() {
    await act(async()=>{const result=await client.request<{games:LibraryGame[]}>('/games/match','POST',{channelId:channel,participantIds:chosen});
      matches=result.games;clearTimeout(timer);timer=setTimeout(()=>{matches=null;notice='Comparison expired. Compare again for current shared choices.';},30000);});
  }
  async function copy(text: string) {try {await navigator.clipboard.writeText(text);notice='Copied.';} catch {error='Clipboard access failed. Select and copy the text instead.';}}
  function launch(key: string) {
    const url=steamLaunchUrl(key);if(!url) return;
    if(window.confirm('Ask Steam to launch this game? This does not join another player.')) {window.location.href=url;notice='Launch requested. A local Steam client is required; Wabi cannot confirm it launched.';}
  }
  function setTags(game: GameSelection, raw: string) {game.tags=[...new Set(raw.split(',').map(s=>s.trim()).filter(Boolean))];}
</script>

<BaseModal isOpen={true} onClose={close} width="1000px" overlayZIndex="var(--z-settings-nested, 10000)" title={own?'Games & Steam':`${request.label} · Games`} subtitle="Shared interests, not an activity timeline">
  <section class="games-workspace">
    {#if own}
      <nav aria-label="Game sections">
        <button class:active={tab==='board'} onclick={()=>{tab='board';error='';}}>My game board</button>
        <button class:active={tab==='steam'} onclick={()=>{tab='steam';error='';}}>Steam connection</button>
        <button class:active={tab==='match'} onclick={()=>{tab='match';error='';}}>What can we play?</button>
      </nav>
    {/if}
    {#if error}<p role="alert" class="message error">{error}</p>{/if}
    {#if notice}<p role="status" class="message">{notice}</p>{/if}
    {#if loading}<p role="status">Loading game board…</p>
    {:else if own && !saved}<p>Your game board could not be loaded.</p><button onclick={reload}>Retry</button>
    {:else if tab==='board' || !own}
      <div class="section-heading"><div><h3>{own?'Your games':'Game board'}</h3><p>{own?`${sharedCount} shared with this server · all other choices are private`:'Only this member’s shared selections are shown.'}</p></div>
        {#if own}<button onclick={reload} disabled={busy}>Reload</button>{/if}
        {#if publicLink}<a href={publicLink} target="_blank" rel="noopener noreferrer">Steam profile ↗</a>{/if}
      </div>
      <fieldset class="editor-fields" disabled={busy}>
      {#if own}
        <form class="manual-entry" onsubmit={(e)=>{e.preventDefault();addManual();}}>
          <label>Game title<input required maxlength="120" bind:value={newTitle} placeholder="Add any game" /></label>
          <label>Shared game code / Steam AppID <span>(optional)</span><input bind:value={newId} placeholder="Paste a friend’s game code, or a Steam AppID" /></label>
          <button class="primary" type="submit" disabled={busy || draft.length>=64}>Add game</button>
        </form>
      {/if}
      <div class="game-grid">
        {#each draft as game (game.key)}
          <article class="game-card">
            <header><span class="game-monogram" aria-hidden="true">{game.title.slice(0,2).toUpperCase()}</span><div><h4>{game.title}</h4><small>{game.key.startsWith('steam:')?'Steam game':'Custom game'} · {game.platform||'Platform not specified'}</small></div></header>
            {#if own}
              <div class="choices">
                <label><input type="checkbox" bind:checked={game.rotation} /> In rotation</label>
                <label><input type="checkbox" bind:checked={game.favorite} /> Favorite</label>
              </div>
              <label>Platform / edition<input maxlength="40" bind:value={game.platform} placeholder="PC, console, edition…" /></label>
              <label>My play preferences<input value={game.tags.join(', ')} onchange={(e)=>setTags(game,e.currentTarget.value)} placeholder="Casual, learning, happy to teach" /></label>
              <label>Note<textarea rows="2" maxlength="300" bind:value={game.note} placeholder="A conversation starter, or a private reminder"></textarea></label>
              <div class="sharing-row"><label>Who can see this?<select bind:value={game.visibility}><option value="private">Only me</option><option value="server">Members of this server</option></select></label></div>
              <label class="invite-choice"><input type="checkbox" bind:checked={game.invitations} /> Open to invitations</label>
              {#if game.invitations && game.visibility==='private'}<small>Private games never participate in group matching.</small>{/if}
              <button class="remove" onclick={()=>{draft=draft.filter(e=>e.key!==game.key);}}>Remove from board</button>
            {:else}
              <div class="chips">{#if game.rotation}<span>In rotation</span>{/if}{#if game.favorite}<span>Favorite</span>{/if}{#if game.invitations}<span>Open to invitations</span>{/if}{#each game.tags as tag}<span>{tag}</span>{/each}</div>
              {#if game.note}<p class="game-note">{game.note}</p>{/if}
            {/if}
            <footer>{#if steamStoreUrl(game.key)}<a href={steamStoreUrl(game.key)!} target="_blank" rel="noopener noreferrer">View on Steam ↗</a><button onclick={()=>launch(game.key)}>Launch game</button>{/if}<button onclick={()=>copy(game.key)}>Copy game code</button></footer>
          </article>
        {/each}
      </div>
      </fieldset>
      {#if draft.length===0}<div class="empty"><h4>{own?'Start with a game you love':'No shared games yet'}</h4><p>{own?'Add a title above, or select games from your Steam library. A Steam connection is optional.':'There is no activity history or hidden-game count to browse.'}</p></div>{/if}
    {:else if tab==='steam'}
      <div class="connection"><h3>Bring your games, not your history</h3><p>Linking proves control of a Steam account. It does not expose private Steam data or automatically publish anything in Wabi.</p>
        {#if saved?.steamId}
          <div class="linked"><strong>Steam connected</strong><code>{saved.steamId}</code><button onclick={disconnect} disabled={busy || dirty}>Disconnect</button></div>
          <label class="invite-choice"><input type="checkbox" disabled={busy} bind:checked={showLink} /> Show my verified Steam profile link to members of this server</label>
          <button class="primary" disabled={busy || !capabilities?.library} onclick={loadLibrary}>Load my Steam library</button>
          {#if !capabilities?.library}<p class="muted">Library import needs the addon enabled and a server-side Steam API key. Your game board still works.</p>{/if}
        {:else}
          <button class="primary" onclick={startLink} disabled={busy || !capabilities?.linking || dirty}>Connect Steam</button>
          {#if !capabilities?.linking}<p class="muted">The server operator needs to enable Steam and configure its public callback origin. Manual games work without Steam.</p>{/if}
        {/if}
        {#if flow}
          <div class="handoff"><h4>Finish in your browser</h4><p>Sign in with Steam, then copy the returned connection code here. Wabi never asks for your Steam password.</p>
            <a class="button" href={safeAuthorizeUrl(flow.authorizeUrl)} target="_blank" rel="noopener noreferrer">Continue on Steam ↗</a>
            <label>Connection code<input autocomplete="off" spellcheck="false" bind:value={receipt} placeholder="Paste the code returned after Steam sign-in" /></label>
            <button class="primary" disabled={busy || !receipt.trim()} onclick={finishLink}>Finish connecting</button>
          </div>
        {/if}
        <p class="muted">Live activity, friends, playtime and achievements are not imported by this release. Disconnecting removes the active link, not historical server backups.</p>
      </div>
      {#if library.length}
        <label class="library-search">Search your available games<input type="search" bind:value={search} placeholder="Search titles…" /></label>
        <div class="library-grid">{#each filtered as game (game.key)}<button class="library-item" disabled={busy || draft.some(e=>e.key===game.key) || draft.length>=64} onclick={()=>add(game)}><strong>{game.title}</strong><small>{draft.some(e=>e.key===game.key)?'On your board':'+ Add privately'}</small></button>{/each}</div>
        <p class="muted">Showing at most 100 matching titles. Selected games begin private; save your board to keep them.</p>
      {/if}
    {:else}
      <div class="connection"><h3>Find common ground</h3><p>Compare saved, server-visible games marked open to invitations. This does not inspect anyone’s full library or guarantee platform compatibility.</p>
        <label>Conversation<select bind:value={channel} onchange={loadMembers} disabled={busy}><option value="">Choose a conversation</option>{#each $channels as ch (ch.id)}<option value={ch.id}>{ch.name || 'Conversation'}</option>{/each}</select></label>
        <fieldset disabled={busy}><legend>Choose 2–12 current members</legend><div class="member-grid">{#each members as member (member.id)}<label><input type="checkbox" value={member.id} bind:group={chosen} onchange={()=>{matches=null;}} disabled={member.id===request.owner || (chosen.length>=12 && !chosen.includes(member.id))} />{member.name}{member.id===request.owner?' (you)':''}</label>{/each}</div></fieldset>
        <button class="primary" onclick={compare} disabled={busy || !channel || chosen.length<2}>Compare shared choices</button>
      </div>
      {#if matches}<div class="match-results" aria-live="polite"><h4>{matches.length?`${matches.length} games in common`:'No common invitation choices'}</h4><p class="muted">Results expire after 30 seconds. Unshared games do not influence this result.</p>
        {#each matches as game (game.key)}<div class="match-row"><strong>{game.title}</strong><button onclick={()=>copy(`Anyone up for ${game.title}? ${steamStoreUrl(game.key)||game.key}`)}>Copy suggestion</button></div>{/each}</div>{/if}
    {/if}
    {#if own && saved}<div class="save-bar"><span>{dirty?'You have unsaved changes.':'All game choices are saved.'}</span><button onclick={()=>{apply(saved!);error='';notice='Changes discarded.';}} disabled={!dirty || busy}>Discard</button><button class="primary" onclick={save} disabled={!dirty || busy}>{busy?'Working…':'Save changes'}</button></div>{/if}
  </section>
</BaseModal>
<style>
  .games-workspace {padding:0 1.4rem 1.4rem;color:var(--text-primary);line-height:1.5;max-height:75dvh;overflow:auto;}
  nav {display:flex;gap:.5rem;border-bottom:1px solid var(--border-subtle);padding-bottom:1rem;flex-wrap:wrap;}
  button,.button {border:1px solid var(--border-subtle);border-radius:9px;padding:.55rem .8rem;background:var(--surface-raised);color:var(--text-primary);font:inherit;font-size:.86rem;cursor:pointer;text-decoration:none;min-height:40px;}
  button:hover:not(:disabled),nav button.active {border-color:var(--accent-primary-color);background:var(--surface-hover);}
  button:disabled {opacity:.5;cursor:default;}.primary {background:var(--accent-primary-color);color:var(--text-on-accent,white);font-weight:650;}
  :is(button,a,input,select,textarea):focus-visible {outline:2px solid var(--accent-primary-color);outline-offset:3px;}
  h3,h4,p {margin:.3rem 0 .7rem;}h3 {font-size:1.2rem;}h4 {font-size:1rem;}small,.muted,.section-heading p {color:var(--text-secondary);font-size:.8rem;}
  .section-heading {display:flex;justify-content:space-between;gap:1rem;align-items:center;margin:1.2rem 0;}
  .manual-entry {display:grid;grid-template-columns:1.2fr 1fr auto;gap:.7rem;align-items:end;margin:1rem 0;}
  label {display:flex;flex-direction:column;gap:.3rem;font-size:.8rem;}label span {color:var(--text-secondary);}
  input:not([type=checkbox]),select,textarea {box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--border-subtle);border-radius:8px;padding:.65rem;background:var(--surface-base);color:var(--text-primary);font:inherit;}
  .game-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;}
  .game-card {background:var(--surface-raised);border:1px solid var(--border-subtle);border-radius:14px;padding:1.1rem;display:grid;gap:.7rem;min-width:0;}
  .game-card header {display:flex;gap:.8rem;align-items:center;}.game-card h4 {overflow-wrap:anywhere;margin:0;}.game-monogram {display:grid;place-items:center;min-width:52px;height:64px;background:var(--surface-hover);color:var(--accent-primary-color);font-size:1.3rem;font-weight:800;border-radius:8px;}
  .choices {display:flex;gap:1rem;flex-wrap:wrap;}.choices label,.invite-choice,.member-grid label {flex-direction:row;align-items:center;gap:.5rem;}
  .game-card footer {display:flex;gap:.5rem;flex-wrap:wrap;border-top:1px solid var(--border-subtle);padding-top:.8rem;align-items:center;}.game-card footer button {font-size:.75rem;padding:.3rem .55rem;}
  a {color:var(--accent-primary-color);font-size:.85rem;}.remove {justify-self:start;background:transparent;color:var(--text-secondary);}
  .chips {display:flex;gap:.35rem;flex-wrap:wrap;}.chips span {background:var(--surface-base);padding:.2rem .5rem;border-radius:6px;font-size:.8rem;}.game-note {white-space:pre-wrap;overflow-wrap:anywhere;}
  .connection,.empty,.match-results {margin:1.2rem 0;padding:1.3rem;border:1px solid var(--border-subtle);border-radius:14px;background:var(--surface-raised);display:grid;gap:.8rem;}.connection>.primary {justify-self:start;}
  .linked {display:flex;align-items:center;gap:1rem;flex-wrap:wrap;}.handoff {display:grid;gap:.7rem;padding:1rem;border:1px solid var(--border-subtle);border-radius:10px;}.handoff .button {justify-self:start;}
  .library-search {margin:1rem 0;}.library-grid {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;}.library-item {display:flex;flex-direction:column;align-items:flex-start;text-align:left;overflow-wrap:anywhere;}
  .editor-fields {border:0;padding:0;margin:0;min-width:0;}
  fieldset {border:1px solid var(--border-subtle);border-radius:9px;padding:1rem;}.member-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;}.match-row {display:flex;justify-content:space-between;gap:1rem;align-items:center;}
  .save-bar {position:sticky;bottom:-1.4rem;background:var(--surface-modal);border:1px solid var(--border-subtle);padding:.8rem;margin:1.2rem -.3rem -.3rem;border-radius:10px;display:flex;align-items:center;gap:.7rem;box-shadow:0 -4px 12px var(--shadow-sm,transparent);}.save-bar span {flex:1;font-size:.8rem;}
  .message {padding:.7rem 1rem;border:1px solid var(--border-subtle);border-radius:8px;margin-top:1rem;}.error {border-color:var(--status-busy);}
  @media(max-width:620px) {.games-workspace{padding:0 .8rem .8rem;max-height:78dvh;}.game-grid,.manual-entry,.member-grid{grid-template-columns:1fr;}.library-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.save-bar{flex-wrap:wrap;bottom:-.8rem;}.save-bar span{flex-basis:100%;}.section-heading{align-items:start;}nav button{flex:1;}code{overflow-wrap:anywhere;}}
</style>
