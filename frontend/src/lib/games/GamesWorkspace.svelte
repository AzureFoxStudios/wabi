<script lang="ts">
	import { _ } from '$lib/i18n';
  import { onMount, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { channels, currentUser } from '$lib/socket';
  import { getAuthToken, authSessionGeneration } from '$lib/authSession';
  import { getServerUrl } from '$lib/serverUrl';
  import BaseModal from '$lib/components/BaseModal.svelte';
  import { manualGame } from './manualGame';
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
  const titleSuggestions = $derived(newTitle.trim().length >= 2 ? library.filter(game=>game.title.toLocaleLowerCase().includes(newTitle.trim().toLocaleLowerCase())).slice(0,12) : []);
  const sharedCount = $derived(draft.filter(g=>g.visibility==='server').length);
  function fail(e: unknown) { if(alive && client.active()) error=e instanceof Error?e.message:$_('games_ws.could_not_complete'); }
  function apply(next: GameBoard) {saved=next;draft=structuredClone($state.snapshot(next.entries));showLink=next.showSteamLink;}
  async function reload() {
    if(busy || (dirty && !window.confirm($_('games_ws.confirm_discard_reload')))) return;
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
  function close() {if(!dirty || window.confirm($_('games_ws.confirm_discard'))) onclose();}
  async function act(work:()=>Promise<void>) {
    if(busy || !client.active()) return;busy=true;error='';notice='';
    try {await work();} catch(e) {fail(e);} finally {if(alive) busy=false;}
  }
  function add(game: LibraryGame) {
    if(draft.some(e=>e.key===game.key)) {notice=$_('games_ws.already_on_board');return;}
    if(draft.length>=64) {error=$_('games_ws.max_games');return;}
    try {draft=[...draft,privateSelection(game)];notice=$_('games_ws.added_private');} catch(e) {fail(e);}
  }
  function addManual() {
    try {
      const game=manualGame(newTitle,newId,library);
      const before=draft.length;add(game);if(draft.length>before) {newTitle='';newId='';}
    } catch(e) {fail(e);}
  }
  async function save() {
    if(!saved) return;
    await act(async()=>{const entries=selections($state.snapshot(draft));
      apply(board(await client.request('/games/me','PUT',{revision:saved!.revision,entries,showSteamLink:showLink})));
      notice=$_('games_ws.board_saved');matches=null;});
  }
  async function startLink() {
    if(!saved || dirty) {error=$_('games_ws.save_or_discard');return;}
    await act(async()=>{const next=await client.request<LinkFlow>('/steam/link/start','POST',{revision:saved!.revision});
      safeAuthorizeUrl(next.authorizeUrl);flow=next;receipt='';});
  }
  async function finishLink() {
    if(!flow) return;
    await act(async()=>{apply(board(await client.request('/steam/link/complete','POST',{ticket:flow!.ticket,proof:flow!.proof,receipt:receipt.trim()})));
      flow=null;receipt='';notice=$_('games_ws.steam_connected_notice');});
  }
  async function disconnect() {
    if(!saved || dirty || !window.confirm($_('games_ws.confirm_disconnect'))) return;
    await act(async()=>{apply(board(await client.request('/steam/unlink','POST',{revision:saved!.revision})));flow=null;library=[];notice=$_('games_ws.steam_disconnected');});
  }
  async function loadLibrary() {
    await act(async()=>{const result=await client.request<{availability:string;games:LibraryGame[];reason?:string}>('/steam/library','POST');
      if(result.availability!=='available') {library=[];notice=result.reason||$_('games_ws.library_unavailable');return;}
      if(!Array.isArray(result.games) || result.games.length>20000) throw new Error($_('games_ws.invalid_library'));
      library=result.games.filter(g=>typeof g?.title==='string' && !!steamAppId(g.key));
      notice=library.length?$_('games_ws.library_available', { values: { count: library.length } }):$_('games_ws.library_empty');});
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
  async function copy(text: string) {try {await navigator.clipboard.writeText(text);notice=$_('games_ws.copied');} catch {error=$_('games_ws.clipboard_failed');}}
  function launch(key: string) {
    const url=steamLaunchUrl(key);if(!url) return;
    if(window.confirm($_('games_ws.confirm_launch'))) {window.location.href=url;notice=$_('games_ws.launch_requested');}
  }
  function setTags(game: GameSelection, raw: string) {game.tags=[...new Set(raw.split(',').map(s=>s.trim()).filter(Boolean))];}
</script>

<BaseModal isOpen={true} onClose={close} width="1000px" overlayZIndex="var(--z-settings-nested, 10000)" title={own?$_('games_ws.title_own'):$_('games_ws.title_other', { values: { label: request.label } })} subtitle={$_('games_ws.subtitle')}>
  <section class="games-workspace">
    {#if own}
      <nav aria-label={$_('games_ws.nav_label')}>
        <button class:active={tab==='board'} onclick={()=>{tab='board';error='';}}>{$_('games_ws.tab_board')}</button>
        <button class:active={tab==='steam'} onclick={()=>{tab='steam';error='';}}>{$_('games_ws.tab_steam')}</button>
        <button class:active={tab==='match'} onclick={()=>{tab='match';error='';}}>{$_('games_ws.tab_match')}</button>
      </nav>
    {/if}
    {#if error}<p role="alert" class="message error">{error}</p>{/if}
    {#if notice}<p role="status" class="message">{notice}</p>{/if}
    {#if loading}<p role="status">{$_('games_ws.loading_board')}</p>
    {:else if own && !saved}<p>{$_('games_ws.board_load_failed')}</p><button onclick={reload}>{$_('games_ws.retry')}</button>
    {:else if tab==='board' || !own}
      <div class="section-heading"><div><h3>{own?$_('games_ws.your_games'):$_('games_ws.game_board')}</h3><p>{own?$_('games_ws.shared_count', { values: { count: sharedCount } }):$_('games_ws.member_shared_only')}</p></div>
        {#if own}<button onclick={reload} disabled={busy}>{$_('games_ws.reload')}</button>{/if}
        {#if publicLink}<a href={publicLink} target="_blank" rel="noopener noreferrer">{$_('games_ws.steam_profile')} ↗</a>{/if}
      </div>
      <fieldset class="editor-fields" disabled={busy}>
      {#if own}
        <form class="manual-entry" onsubmit={(e)=>{e.preventDefault();addManual();}}>
          <label>{$_('games_ws.game_title')}<input required maxlength="120" bind:value={newTitle} placeholder={$_('games_ws.add_any_game')} list="available-game-titles" /></label>
          <label>{$_('games_ws.game_identifier')} <span>{$_('games_ws.optional')}</span><input bind:value={newId} placeholder={$_('games_ws.paste_link')} /></label>
          <button class="primary" type="submit" disabled={busy || draft.length>=64}>{$_('games_ws.add_game')}</button>
        </form>
        <datalist id="available-game-titles">{#each titleSuggestions as game (game.key)}<option value={game.title}></option>{/each}</datalist>
        <p class="muted">{$_('games_ws.manual_hint')}</p>
      {/if}
      <div class="game-grid">
        {#each draft as game (game.key)}
          <article class="game-card">
            <header><span class="game-monogram" aria-hidden="true">{game.title.slice(0,2).toUpperCase()}</span><div><h4>{game.title}</h4><small>{game.key.startsWith('steam:')?$_('games_ws.steam_game'):$_('games_ws.custom_game')} · {game.platform||$_('games_ws.platform_unspecified')}</small></div></header>
            {#if own}
              <div class="choices">
                <label><input type="checkbox" bind:checked={game.rotation} /> {$_('games_ws.in_rotation')}</label>
                <label><input type="checkbox" bind:checked={game.favorite} /> {$_('games_ws.favorite')}</label>
              </div>
              <label>{$_('games_ws.platform_edition')}<input maxlength="40" bind:value={game.platform} placeholder={$_('games_ws.platform_ph')} /></label>
              <label>{$_('games_ws.play_prefs')}<input value={game.tags.join(', ')} onchange={(e)=>setTags(game,e.currentTarget.value)} placeholder={$_('games_ws.play_prefs_ph')} /></label>
              <label>{$_('games_ws.note')}<textarea rows="2" maxlength="300" bind:value={game.note} placeholder={$_('games_ws.note_ph')}></textarea></label>
              <div class="sharing-row"><label>{$_('games_ws.who_can_see')}<select bind:value={game.visibility}><option value="private">{$_('games_ws.only_me')}</option><option value="server">{$_('games_ws.server_members')}</option></select></label></div>
              <label class="invite-choice"><input type="checkbox" bind:checked={game.invitations} /> {$_('games_ws.open_invitations')}</label>
              {#if game.invitations && game.visibility==='private'}<small>{$_('games_ws.private_no_match')}</small>{/if}
              <button class="remove" onclick={()=>{draft=draft.filter(e=>e.key!==game.key);}}>{$_('games_ws.remove_from_board')}</button>
            {:else}
              <div class="chips">{#if game.rotation}<span>{$_('games_ws.in_rotation')}</span>{/if}{#if game.favorite}<span>{$_('games_ws.favorite')}</span>{/if}{#if game.invitations}<span>{$_('games_ws.open_invitations')}</span>{/if}{#each game.tags as tag}<span>{tag}</span>{/each}</div>
              {#if game.note}<p class="game-note">{game.note}</p>{/if}
            {/if}
            <footer>{#if steamStoreUrl(game.key)}<a href={steamStoreUrl(game.key)!} target="_blank" rel="noopener noreferrer">{$_('games_ws.view_on_steam')} ↗</a><button onclick={()=>launch(game.key)}>{$_('games_ws.launch_game')}</button>{/if}<button onclick={()=>copy(game.key)}>{$_('games_ws.copy_game_code')}</button></footer>
          </article>
        {/each}
      </div>
      </fieldset>
      {#if draft.length===0}<div class="empty"><h4>{own?$_('games_ws.start_with_game'):$_('games_ws.no_shared_games')}</h4><p>{own?$_('games_ws.empty_own_hint'):$_('games_ws.empty_other_hint')}</p></div>{/if}
    {:else if tab==='steam'}
      <div class="connection"><h3>{$_('games_ws.connection_title')}</h3><p>{$_('games_ws.connection_desc')}</p>
        {#if saved?.steamId}
          <div class="linked"><strong>{$_('games_ws.steam_connected')}</strong><code>{saved.steamId}</code><button onclick={disconnect} disabled={busy || dirty}>{$_('games_ws.disconnect')}</button></div>
          <label class="invite-choice"><input type="checkbox" disabled={busy} bind:checked={showLink} /> {$_('games_ws.show_profile')}</label>
          <button class="primary" disabled={busy || !capabilities?.library} onclick={loadLibrary}>{$_('games_ws.load_library')}</button>
          {#if !capabilities?.library}<p class="muted">{$_('games_ws.library_needs_addon')}</p>{/if}
        {:else}
          <button class="primary" onclick={startLink} disabled={busy || !capabilities?.linking || dirty}><img src="/steam-sign-in.png" alt={$_('games_ws.steam_sign_in_alt')} width="180" height="35" /></button>
          {#if !capabilities?.linking}<p class="muted">{$_('games_ws.steam_not_ready')}</p>
          {#if $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin'}<button onclick={() => { if (dirty && !window.confirm($_('games_ws.discard_before_settings'))) return; onclose(); window.dispatchEvent(new CustomEvent('wabi:open-settings',{detail:{tab:'addons'}})); }}>{$_('games_ws.set_up_steam')}</button><p class="muted">{$_('games_ws.enable_steam_hint')}</p>{/if}{/if}
        {/if}
        {#if flow}
          <div class="handoff"><h4>{$_('games_ws.finish_browser')}</h4><p>{$_('games_ws.finish_browser_desc')}</p>
            <a class="button" href={safeAuthorizeUrl(flow.authorizeUrl)} target="_blank" rel="noopener noreferrer">{$_('games_ws.continue_steam')} ↗</a>
            <label>{$_('games_ws.connection_code')}<input autocomplete="off" spellcheck="false" bind:value={receipt} placeholder={$_('games_ws.connection_code_ph')} /></label>
            <button class="primary" disabled={busy || !receipt.trim()} onclick={finishLink}>{$_('games_ws.finish_connecting')}</button>
          </div>
        {/if}
        <p class="muted">{$_('games_ws.steam_limits')}</p>
      </div>
      {#if library.length}
        <label class="library-search">{$_('games_ws.search_label')}<input type="search" bind:value={search} placeholder={$_('games_ws.search_ph')} /></label>
        <div class="library-grid">{#each filtered as game (game.key)}<button class="library-item" disabled={busy || draft.some(e=>e.key===game.key) || draft.length>=64} onclick={()=>add(game)}><strong>{game.title}</strong><small>{draft.some(e=>e.key===game.key)?$_('games_ws.on_board'):$_('games_ws.add_privately')}</small></button>{/each}</div>
        <p class="muted">{$_('games_ws.library_limit')}</p>
      {/if}
    {:else}
      <div class="connection"><h3>{$_('games_ws.find_common_title')}</h3><p>{$_('games_ws.find_common_desc')}</p>
        <label>{$_('games_ws.conversation_label')}<select bind:value={channel} onchange={loadMembers} disabled={busy}><option value="">{$_('games_ws.choose_conversation')}</option>{#each $channels as ch (ch.id)}<option value={ch.id}>{ch.name || $_('games_ws.conversation_label')}</option>{/each}</select></label>
        <fieldset disabled={busy}><legend>{$_('games_ws.members_legend')}</legend><div class="member-grid">{#each members as member (member.id)}<label><input type="checkbox" value={member.id} bind:group={chosen} onchange={()=>{matches=null;}} disabled={member.id===request.owner || (chosen.length>=12 && !chosen.includes(member.id))} />{member.name}{member.id===request.owner?$_('games_ws.you'):''}</label>{/each}</div></fieldset>
        <button class="primary" onclick={compare} disabled={busy || !channel || chosen.length<2}>{$_('games_ws.compare')}</button>
      </div>
      {#if matches}<div class="match-results" aria-live="polite"><h4>{matches.length?$_('games_ws.games_in_common', { values: { count: matches.length } }):$_('games_ws.no_common')}</h4><p class="muted">{$_('games_ws.results_expire')}</p>
        {#each matches as game (game.key)}<div class="match-row"><strong>{game.title}</strong><button onclick={()=>copy($_('games_ws.suggestion', { values: { title: game.title, link: steamStoreUrl(game.key)||game.key } }))}>{$_('games_ws.copy_suggestion')}</button></div>{/each}</div>{/if}
    {/if}
    {#if own && saved && dirty}<div class="save-bar"><span>{dirty?$_('games_ws.unsaved'):$_('games_ws.all_saved')}</span><button onclick={()=>{apply(saved!);error='';notice=$_('games_ws.changes_discarded');}} disabled={!dirty || busy}>{$_('games_ws.discard')}</button><button class="primary" onclick={save} disabled={!dirty || busy}>{busy?$_('games_ws.working'):$_('games_ws.save_changes')}</button></div>{/if}
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
  .empty {margin:.6rem 0;padding:.6rem 0;}.empty h4,.empty p {margin:.25rem 0;}
  .connection,.match-results {margin:1.2rem 0;padding:1.3rem;border:1px solid var(--border-subtle);border-radius:14px;background:var(--surface-raised);display:grid;gap:.8rem;}.connection>.primary {justify-self:start;}
  .linked {display:flex;align-items:center;gap:1rem;flex-wrap:wrap;}.handoff {display:grid;gap:.7rem;padding:1rem;border:1px solid var(--border-subtle);border-radius:10px;}.handoff .button {justify-self:start;}
  .library-search {margin:1rem 0;}.library-grid {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;}.library-item {display:flex;flex-direction:column;align-items:flex-start;text-align:left;overflow-wrap:anywhere;}
  .editor-fields {border:0;padding:0;margin:0;min-width:0;}
  fieldset {border:1px solid var(--border-subtle);border-radius:9px;padding:1rem;}.member-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem;}.match-row {display:flex;justify-content:space-between;gap:1rem;align-items:center;}
  .save-bar {position:sticky;bottom:-1.4rem;background:var(--surface-modal);border:1px solid var(--border-subtle);padding:.8rem;margin:1.2rem -.3rem -.3rem;border-radius:10px;display:flex;align-items:center;gap:.7rem;box-shadow:0 -4px 12px var(--shadow-sm,transparent);}.save-bar span {flex:1;font-size:.8rem;}
  .message {padding:.7rem 1rem;border:1px solid var(--border-subtle);border-radius:8px;margin-top:1rem;}.error {border-color:var(--status-busy);}
  @media(max-width:620px) {.games-workspace{padding:0 .8rem .8rem;max-height:78dvh;}.game-grid,.manual-entry,.member-grid{grid-template-columns:1fr;}.library-grid{grid-template-columns:repeat(2,minmax(0,1fr));}.save-bar{flex-wrap:wrap;bottom:-.8rem;}.save-bar span{flex-basis:100%;}.section-heading{align-items:start;}nav button{flex:1;}code{overflow-wrap:anywhere;}}
</style>
