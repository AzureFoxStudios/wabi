<script lang="ts">
    import {onMount,onDestroy} from 'svelte';
    import {captureScope,request,targets,presentationLink,WorkspaceError,type AudienceState,type AudienceSlide,type Scope} from './bridge';
    import AudienceSlideView from './AudienceSlide.svelte';
    import './workspace.css';
    interface Question{id:string;slideId:string;authorUserId:number;authorName:string;body:string;createdAt:number;resolved:boolean;}
    type State=AudienceState&{artifactId?:string|null;controllerLost?:boolean;questions?:Question[]};
    let scope=$state<Scope|null>(null),sessionId=$state(''),presentationState=$state<State|null>(null),slides=$state<AudienceSlide[]>([]);
    let follow=$state(true),independentId=$state(''),error=$state(''),busy=$state(false),handoff=$state(''),address=$state('');
    let panel:HTMLDivElement,root:HTMLElement,slideFrame:HTMLDivElement;
    let timer:ReturnType<typeof setTimeout>|undefined,beatTimer:ReturnType<typeof setInterval>|undefined,clock:ReturnType<typeof setInterval>|undefined;
    let abort=new AbortController(),disposed=false,loading=false,epoch=0,previous:unknown,unsubscribe=()=>{},beatBusy=false,lastBeat=0;
    let pointer=$state<{x:number;y:number;slideId:string}|null>(null),pointerChanged=false,laser=$state(false);
    let elapsed=$state(0),started=Date.now(),stageWidth=$state(1000),stageHeight=$state(600),notes=$state<Record<string,string>>({}),notesFor='';
    let questionsOpen=$state(false),questionDraft=$state(''),questionSlide=$state('');let questionId:string=crypto.randomUUID();
    let draftWrites:Promise<void>=Promise.resolve(),privateError=$state('');
    const selected=$derived(slides.find(slide=>slide.id===(follow?presentationState?.slideId:independentId))||slides[0]||null);
    const selectedIndex=$derived(slides.findIndex(slide=>slide.id===selected?.id));
    const ratio=$derived(Math.max(.5,Math.min(3,presentationState?.aspect||16/9)));
    const frameWidth=$derived(Math.max(0,Math.min(stageWidth,stageHeight*ratio,1600)));
    const presenter=$derived(Boolean(presentationState?.canControl&&!presentationState.ended));
    const nextSlide=$derived(slides[selectedIndex+1]);
    const displayPointer=$derived(presenter&&laser?pointer:presentationState?.pointer);
    function current(own:number,owner:Scope,id:string){return own===epoch&&!disposed&&owner.isCurrent()&&sessionId===id;}
    function apply(next:State){
        if(next.id!==sessionId)throw new Error('Server returned a different presentation.');
        if(presentationState&&next.sequence<presentationState.sequence)return;
        if(presentationState&&next.edition!==presentationState.edition&&!next.slides)throw new Error('The presented revision changed; reload its approved slides.');
        if(next.slides)slides=next.slides;
        presentationState=next;if(!slides.some(slide=>slide.id===independentId))independentId=next.slideId;
        if(next.ended){slides=[];pointer=null;}
        if(next.canControl&&next.artifactId&&notesFor!==next.artifactId)void loadNotes(next.artifactId);
        if(!next.canControl){notes={};notesFor='';pointer=null;}
    }
    async function loadNotes(id:string){
        const owner=scope,own=epoch,room=sessionId;if(!owner)return;notesFor=id;
        try{const storage=await import('./privateNotes');const result=await storage.readPrivateNotes(owner,id);if(current(own,owner,room)&&presentationState?.artifactId===id&&presentationState.canControl)notes=result;}
        catch(e){if(current(own,owner,room))privateError=e instanceof Error?e.message:String(e);}
    }
    async function refresh(){
        const owner=scope,id=sessionId,own=epoch;if(!owner||!id||loading||disposed)return;loading=true;
        try{
            const suffix=presentationState?`?edition=${encodeURIComponent(presentationState.edition)}`:'';
            const next=await request<State>(owner,`/presentations/${id}${suffix}`,undefined,undefined,abort.signal);
            if(!current(own,owner,id))return;apply(next);error='';
        }catch(e){if(current(own,owner,id))error=e instanceof Error?e.message:String(e);}
        finally{if(current(own,owner,id)){loading=false;if(timer)clearTimeout(timer);if(!presentationState?.ended)timer=setTimeout(()=>void refresh(),document.hidden?4000:1200);}}
    }
    function open(id:string){
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)){error='Invalid presentation ID';return;}
        epoch++;if(timer)clearTimeout(timer);abort.abort();abort=new AbortController();loading=false;busy=false;beatBusy=false;lastBeat=0;
        presentationState=null;slides=[];follow=true;sessionId=id;notes={};notesFor='';pointer=null;questionDraft='';questionId=crypto.randomUUID();started=Date.now();elapsed=0;
        void refresh();const owner=scope,own=epoch;
        if(owner)void import('./privateNotes').then(storage=>storage.readPrivateNotes(owner,`session:${id}`)).then(saved=>{if(current(own,owner,id)){questionDraft=saved.question||'';questionSlide=saved.slide||'';questionId=saved.id||crypto.randomUUID();}}).catch(e=>{if(current(own,owner,id))privateError=e.message;});
    }
    function fromAddress(){try{let id=address.trim();if(id.includes('://')){const url=new URL(id);if(!scope||new URL(scope.server).origin!==url.origin)throw new Error('Switch to the server in this link first.');id=url.searchParams.get('workspaceSession')||'';}open(id);}catch(e){error=e instanceof Error?e.message:String(e);}}
    async function command(action:string,extra:Record<string,unknown>={}){
        const owner=scope,state=presentationState,id=sessionId,own=epoch;if(!owner||!state||busy)return;busy=true;
        try{const result=await request<State>(owner,`/presentations/${id}`,{action,generation:state.generation,sequence:state.sequence,...extra},undefined,abort.signal);if(current(own,owner,id)){apply(result);error='';lastBeat=0;}}
        catch(e){if(current(own,owner,id)){error=e instanceof Error?e.message:String(e);if(timer)clearTimeout(timer);void refresh();}}
        finally{if(current(own,owner,id))busy=false;}
    }
    async function heartbeat(){
        const owner=scope,state=presentationState,id=sessionId,own=epoch;
        if(!owner||!state?.canControl||state.ended||state.controllerLost||beatBusy||disposed)return;
        if(!pointerChanged&&Date.now()-lastBeat<3000)return;beatBusy=true;pointerChanged=false;lastBeat=Date.now();
        try{await request(owner,`/presentations/${id}/heartbeat`,{generation:state.generation,pointer:laser&&follow?pointer:null},undefined,abort.signal);}
        catch(e){if(current(own,owner,id)){error=e instanceof Error?e.message:String(e);if(e instanceof WorkspaceError&&e.status===409)void refresh();}}
        finally{if(current(own,owner,id))beatBusy=false;}
    }
    function point(event:PointerEvent){if(!presenter||!laser||!follow||!selected)return;const bounds=slideFrame.getBoundingClientRect();if(!bounds.width||!bounds.height)return;pointer={x:Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(event.clientY-bounds.top)/bounds.height)),slideId:selected.id};pointerChanged=true;}
    function move(direction:number){const index=Math.max(0,Math.min(slides.length-1,selectedIndex+direction)),slide=slides[index];if(!slide)return;if(presenter&&follow)void command('slide',{slideId:slide.id});else{follow=false;independentId=slide.id;}}
    function key(event:KeyboardEvent){
        if(!root?.contains(document.activeElement)&&!document.fullscreenElement)return;
        if(event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLTextAreaElement||(event.target instanceof HTMLElement&&event.target.isContentEditable))return;
        if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();move(1);}else if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();move(-1);}
    }
    async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await panel.requestFullscreen();}catch{error='Fullscreen was not permitted; the presentation remains available in this panel.';}}
    function stageQuestion(text:string){
        if(!scope||!selected)return;if(!questionDraft)questionSlide=selected.id;questionDraft=text;
        const owner=scope,id=sessionId,own=epoch,slide=questionSlide,draftId=questionId;
        draftWrites=draftWrites.catch(()=>{}).then(async()=>{const storage=await import('./privateNotes');await storage.savePrivateNote(owner,`session:${id}`,'question',text);await storage.savePrivateNote(owner,`session:${id}`,'slide',slide);await storage.savePrivateNote(owner,`session:${id}`,'id',draftId);}).catch(e=>{if(current(own,owner,id))privateError=e.message;});
    }
    async function ask(){
        const owner=scope,id=sessionId,own=epoch;if(!owner||busy||!questionDraft.trim())return;busy=true;
        try{
            await draftWrites;const next=await request<State>(owner,`/presentations/${id}/questions`,{action:'add',id:questionId,slideId:questionSlide||selected?.id,body:questionDraft},undefined,abort.signal);
            if(current(own,owner,id)){apply(next);stageQuestion('');questionId=crypto.randomUUID();error='';}
        }catch(e){if(current(own,owner,id))error=e instanceof Error?e.message:String(e);}finally{if(current(own,owner,id))busy=false;}
    }
    async function resolveQuestion(question:Question){const owner=scope,id=sessionId,own=epoch;if(!owner||busy)return;busy=true;try{const next=await request<State>(owner,`/presentations/${id}/questions`,{action:question.resolved?'reopen':'resolve',id:question.id},undefined,abort.signal);if(current(own,owner,id))apply(next);}catch(e){if(current(own,owner,id))error=e instanceof Error?e.message:String(e);}finally{if(current(own,owner,id))busy=false;}}
    onMount(()=>{
        const resize=new ResizeObserver(entries=>{const rect=entries[0]?.contentRect;if(rect){stageWidth=Math.max(0,rect.width-32);stageHeight=Math.max(0,rect.height-32);}});resize.observe(panel);
        void captureScope().then(owner=>{if(disposed||!owner.isCurrent())return;scope=owner;unsubscribe=targets.subscribe(value=>{if(value.audience&&value.audience!==previous){previous=value.audience;if(value.audience.sessionId)open(value.audience.sessionId);}});}).catch(e=>{if(!disposed)error=e.message;});
        beatTimer=setInterval(()=>void heartbeat(),250);clock=setInterval(()=>elapsed=Math.floor((Date.now()-started)/1000),1000);
        return()=>resize.disconnect();
    });
    onDestroy(()=>{disposed=true;epoch++;unsubscribe();abort.abort();if(timer)clearTimeout(timer);if(beatTimer)clearInterval(beatTimer);if(clock)clearInterval(clock);});
</script>
<svelte:window onkeydown={key}/>
<section class="wabi-workspace" bind:this={root} aria-label="Presentation audience workspace">
    <header class="workspace-bar"><strong>Presentation</strong>{#if presentationState}<span>{slides.length?selectedIndex+1:0} / {slides.length}</span><button disabled={presentationState.ended} onclick={()=>{follow=!follow;independentId=presentationState!.slideId;}}>{follow?'Browse independently':'Back to presenter'}</button><button disabled={!selected} onclick={()=>void fullscreen()}>Fullscreen</button><button onclick={()=>{if(scope)void navigator.clipboard.writeText(presentationLink(scope.server,sessionId)).catch(()=>error='Clipboard access was denied.');}}>Copy presentation link</button><button onclick={()=>questionsOpen=!questionsOpen}>Slide questions {presentationState.questions?.filter(question=>!question.resolved).length||''}</button><span role="status">{presentationState.ended?'Ended':presentationState.controllerLost?'Presenter disconnected — paused':presentationState.paused?'Paused':follow?'Following presenter':'Browsing independently'}</span>{/if}</header>
    {#if !sessionId}<form class="workspace-home-note workspace-toolbar" onsubmit={event=>{event.preventDefault();fromAddress();}}><input aria-label="Presentation link or ID" placeholder="Presentation link or ID" bind:value={address}/><button disabled={!scope}>Join presentation</button></form>{/if}
    {#if error}<div class="workspace-notice" role="alert">{error} — cached slides remain available and may not match the presenter.<button onclick={()=>void refresh()}>Reconnect</button></div>{/if}
    {#if privateError}<p class="workspace-notice" role="alert">{privateError} Keep a copy of any unsent question before leaving.</p>{/if}
    <div class="audience-body"><div class="audience-display" bind:this={panel}>
        {#if selected}<div class="slide-frame" bind:this={slideFrame} style:width={`${frameWidth}px`} style:aspect-ratio={String(ratio)} onpointermove={point} onpointerleave={()=>{pointer=null;pointerChanged=true;}} role="img" aria-label="Presented slide">
            <AudienceSlideView slide={selected} aspect={ratio} blank={follow&&presentationState?.blank}/>
            {#if displayPointer&&follow&&displayPointer.slideId===selected.id&&!presentationState?.blank}<span class="laser-dot" style:left={`${displayPointer.x*100}%`} style:top={`${displayPointer.y*100}%`} aria-hidden="true"></span>{/if}
        </div>{:else if presentationState?.ended}<p role="status">This presentation has ended. Your call remains connected.</p>{:else if sessionId}<p role="status">Loading approved presentation slides…</p>{/if}
    </div>
    {#if presenter}<aside class="presenter-notes" aria-label="Presenter notes"><strong>Presenter view</strong><p>Elapsed {Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</p><h3>Private notes</h3><p class="notes-text">{selected&&notes[selected.id]?notes[selected.id]:'No private notes available on this device. Handoff does not share notes.'}</p>{#if nextSlide}<h3>Next slide</h3><p>{nextSlide.title||'Untitled'}</p><small>{nextSlide.body.slice(0,200)}</small>{/if}</aside>{/if}
    {#if questionsOpen&&presentationState}<aside class="workspace-reviews" aria-label="Slide questions"><h2>Slide questions</h2><button onclick={()=>questionsOpen=false}>Close questions</button>
        {#if !presentationState.ended}<textarea aria-label="Question about this slide" value={questionDraft} maxlength="2000" oninput={event=>stageQuestion(event.currentTarget.value)} placeholder="Ask about the selected slide…"></textarea><button disabled={busy||!questionDraft.trim()} onclick={()=>void ask()}>Post question</button>{/if}
        {#each presentationState.questions||[] as question(question.id)}<article><strong>{question.authorName}</strong><button onclick={()=>{follow=false;independentId=question.slideId;}}>{slides.find(slide=>slide.id===question.slideId)?.title||'Earlier slide revision'}</button><p>{question.body}</p><small>{question.resolved?'Resolved':'Open'}</small>{#if presenter}<button disabled={busy} onclick={()=>void resolveQuestion(question)}>{question.resolved?'Reopen':'Resolve'}</button>{/if}</article>{/each}
    </aside>{/if}</div>
    {#if presentationState}<footer class="workspace-bar"><button disabled={busy||selectedIndex<=0||presentationState.ended} onclick={()=>move(-1)}>Previous</button><button disabled={busy||selectedIndex>=slides.length-1||presentationState.ended} onclick={()=>move(1)}>Next</button><select aria-label="Browse a slide" value={selected?.id||''} disabled={presentationState.ended} onchange={event=>{follow=false;independentId=event.currentTarget.value;}}>{#each slides as slide,index(slide.id)}<option value={slide.id}>{index+1}. {slide.title||'Untitled slide'}</option>{/each}</select>
        {#if presenter}<button disabled={busy||presentationState.controllerLost} onclick={()=>void command('blank')}>{presentationState.blank?'Show slides':'Blank screen'}</button><button disabled={busy} onclick={()=>void command(presentationState!.paused?'resume':'pause')}>{presentationState.paused?'Resume':'Pause'}</button><button aria-pressed={laser} onclick={()=>{laser=!laser;pointer=null;pointerChanged=true;}}>{laser?'Pointer on':'Pointer off'}</button><input aria-label="New presenter account ID" placeholder="Account ID for handoff" inputmode="numeric" bind:value={handoff}/><button disabled={busy||!/^[1-9]\d*$/.test(handoff)} onclick={()=>void command('handoff',{targetUserId:Number(handoff)})}>Pass control</button><button disabled={busy} onclick={()=>void command('end')}>End presentation</button>{/if}
    </footer><p class="audience-note">Viewing slides does not join or end a voice call. Presentation control does not grant access to private notes.</p>{/if}
</section>
<style>
.audience-body{display:flex;flex:1;min-height:0}.audience-display{flex:1;min-width:0;min-height:200px;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:1rem;background:#0d1019}.slide-frame{position:relative;flex-shrink:0;max-width:100%}.slide-frame :global(.audience-slide){width:100%;height:100%;max-height:none}.audience-display:fullscreen{padding:0}.laser-dot{position:absolute;width:13px;height:13px;border-radius:50%;background:#ffed85;box-shadow:0 0 4px 2px #e22b30;transform:translate(-50%,-50%);pointer-events:none}.presenter-notes{width:240px;max-width:30%;overflow:auto;padding:1rem;border-left:1px solid var(--border-subtle,#35384c)}.notes-text{white-space:pre-wrap}.audience-note{font-size:.75rem;margin:.4rem 1rem;color:var(--text-secondary,#b5bad0)}footer input{max-width:150px}@media(max-width:700px){.audience-body{flex-direction:column}.presenter-notes{width:auto;max-width:none;max-height:140px;border-left:0;border-top:1px solid var(--border-subtle,#35384c)}}
</style>
