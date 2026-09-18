<script lang="ts">
    import { onDestroy } from 'svelte';
    import AudienceSlideView from '../AudienceSlide.svelte';
    import type { ArtifactSession } from '../session';
    import type { AudienceSlide } from '../bridge';
    import { type SceneObject, type SceneKind, type SceneTheme } from '../scene';
    import { readDesign, presetDesign, setDesign, addSceneObject, patchSceneObject, removeSceneObject, setSceneTheme, type ScenePreset } from './nativeScene';
    let {session,slide,aspect,selectedObjectId=null,onselect=()=>{}}:{session:ArtifactSession;slide:AudienceSlide;aspect:number;selectedObjectId?:string|null;onselect?:(id:string|null)=>void}=$props();
    let tick=$state(0),selected=$state(''),error=$state(''),busy=$state(false),preset=$state<ScenePreset>('body');
    let stage=$state<HTMLDivElement>(),imageInput=$state<HTMLInputElement>();
    const abort=new AbortController();let disposed=false;
    const design=$derived.by(()=>{tick;try{return slide.layout==='canvas'?readDesign(session.data,slide.id):null;}catch{return null;}});
    const chosen=$derived(design?.objects.find(object=>object.id===selected)||null);
    const editable=$derived.by(()=>{tick;return session.editable&&!session.isClosed;});
    $effect(()=>{if(selectedObjectId&&design?.objects.some(object=>object.id===selectedObjectId))selected=selectedObjectId;});
    $effect(()=>session.state.subscribe(value=>tick=value.tick));
    $effect(()=>{if(selected&&!design?.objects.some(object=>object.id===selected)){selected='';onselect(null);}});
    onDestroy(()=>{disposed=true;abort.abort();});
    function choose(id:string){selected=id;onselect(id);}
    function run(fn:()=>void){error='';try{if(!session.scope.isCurrent())throw new Error('Account changed');fn();}catch(e){error=e instanceof Error?e.message:String(e);}}
    function apply(){run(()=>{if(!editable)return;session.doc.transact(()=>setDesign(session.data,slide.id,presetDesign(preset,slide.title,slide.body,design?.theme||'paper')),session.origin);selected='';onselect(null);});}
    function add(kind:SceneKind){run(()=>choose(addSceneObject(session,slide.id,kind)));}
    function patch(value:Partial<SceneObject>){if(chosen)run(()=>patchSceneObject(session,slide.id,chosen!.id,value));}
    function number(field:'x'|'y'|'w'|'h'|'fontSize'|'cropX'|'cropY',value:number){if(!chosen||!Number.isFinite(value))return;const limit=field==='x'?1-chosen.w:field==='y'?1-chosen.h:field==='w'?1-chosen.x:field==='h'?1-chosen.y:field==='fontSize'?72:1;const min=field==='w'||field==='h'?.02:field==='fontSize'?12:0;patch({[field]:Math.max(min,Math.min(limit,value))});}
    async function image(file:File){if(!chosen||busy||!editable)return;const id=chosen.id,slideId=slide.id,captured=session;busy=true;error='';try{const value=await(await import('./files')).rasterImage(file,abort.signal);if(disposed||session!==captured||!captured.scope.isCurrent()||slide.id!==slideId)return;patchSceneObject(captured,slideId,id,{image:value});}catch(e){if(!disposed)error=e instanceof Error?e.message:String(e);}finally{if(!disposed)busy=false;}}
    async function finishCrop(){
        if(!chosen||busy||!editable)return;
        const object={...chosen},id=slide.id,captured=session,ratio=aspect;
        busy=true;error='';
        try{
            const image=await(await import('./finalizeCrop')).finalizeCrop(object,ratio,abort.signal);
            if(disposed||session!==captured||!captured.scope.isCurrent()||slide.id!==id)return;
            const latest=readDesign(captured.data,id)?.objects.find(item=>item.id===object.id);
            if(!latest||JSON.stringify(latest)!==JSON.stringify(object))throw new Error('The image changed while cropping. Review the latest object and try again.');
            patchSceneObject(captured,id,object.id,{image,fit:'contain',cropX:.5,cropY:.5});
        }catch(e){if(!disposed)error=e instanceof Error?e.message:String(e);}
        finally{if(!disposed)busy=false;}
    }
    function move(event:KeyboardEvent,object:SceneObject){if(!editable||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const distance=event.shiftKey?.05:.01;run(()=>patchSceneObject(session,slide.id,object.id,{x:Math.max(0,Math.min(1-object.w,object.x+(event.key==='ArrowRight'?distance:event.key==='ArrowLeft'?-distance:0))),y:Math.max(0,Math.min(1-object.h,object.y+(event.key==='ArrowDown'?distance:event.key==='ArrowUp'?-distance:0)))}));}
    let drag:{id:string;slideId:string;x:number;y:number;px:number;py:number;width:number;height:number;target:HTMLElement;pointer:number}|null=null;
    function startDrag(event:PointerEvent,object:SceneObject){choose(object.id);if(!editable||event.button!==0||!stage)return;const rect=stage.getBoundingClientRect();const target=event.currentTarget as HTMLElement;target.setPointerCapture(event.pointerId);drag={id:object.id,slideId:slide.id,x:object.x,y:object.y,px:event.clientX,py:event.clientY,width:rect.width,height:rect.height,target,pointer:event.pointerId};}
    function dragMove(event:PointerEvent){if(drag&&event.pointerId===drag.pointer)drag.target.style.transform=`translate(${event.clientX-drag.px}px,${event.clientY-drag.py}px)`;}
    function finishDrag(event:PointerEvent,cancel=false){const previous=drag;drag=null;if(!previous)return;previous.target.style.transform='';if(previous.target.hasPointerCapture(previous.pointer))previous.target.releasePointerCapture(previous.pointer);if(cancel||previous.slideId!==slide.id||!session.scope.isCurrent())return;const current=design?.objects.find(o=>o.id===previous.id);if(!current)return;if(current.x!==previous.x||current.y!==previous.y){error='Another editor moved this object. Your drag was not applied over their move; try from its new position.';return;}run(()=>patchSceneObject(session,slide.id,current.id,{x:Math.max(0,Math.min(1-current.w,current.x+(event.clientX-previous.px)/previous.width)),y:Math.max(0,Math.min(1-current.h,current.y+(event.clientY-previous.py)/previous.height))}));}
</script>
<div class="designer-stage" bind:this={stage}>
    <AudienceSlideView {slide} {aspect}/>
    {#if design}{#each design.objects as object (object.id)}<button class="object-handle" class:chosen={selected===object.id} style:left={`${object.x*100}%`} style:top={`${object.y*100}%`} style:width={`${object.w*100}%`} style:height={`${object.h*100}%`} aria-label={`Select ${object.kind} object ${design.objects.indexOf(object)+1}`} aria-pressed={selected===object.id} onclick={()=>choose(object.id)} onkeydown={event=>move(event,object)} onpointerdown={event=>startDrag(event,object)} onpointermove={dragMove} onpointerup={event=>finishDrag(event)} onpointercancel={event=>finishDrag(event,true)}></button>{/each}{/if}
</div>
<details class="designer-controls" open={!!design}>
    <summary>Native layout and object controls</summary>
    <div class="workspace-toolbar"><select aria-label="Native slide preset" bind:value={preset} disabled={!editable}><option value="blank">Blank</option><option value="title">Title</option><option value="body">Title and body</option><option value="caption">Image and caption</option><option value="comparison">Two-column comparison</option><option value="grid">Image grid</option><option value="table">Table</option><option value="chart">Pinned chart</option></select><button disabled={!editable} onclick={apply}>Apply native layout</button></div>
    <p class="hint">Applying a layout replaces the current object arrangement; Undo restores it. Charts use copied values, never a live private workbook.</p>
    {#if design}<div class="workspace-toolbar"><select aria-label="Slide theme" value={design.theme} disabled={!editable} onchange={event=>run(()=>setSceneTheme(session,slide.id,event.currentTarget.value as SceneTheme))}><option value="paper">Paper</option><option value="night">Night</option><option value="ocean">Ocean</option></select>{#each ['text','image','rect','ellipse','line','table','chart'] as kind}<button disabled={!editable} onclick={()=>add(kind as SceneKind)}>Add {kind}</button>{/each}</div>{/if}
    {#if chosen}<div class="object-fields">
        <label>Object<select aria-label="Selected slide object" value={chosen.id} onchange={event=>choose(event.currentTarget.value)}>{#each design?.objects||[] as object (object.id)}<option value={object.id}>{object.kind} · {object.text.slice(0,24)||object.id.slice(0,6)}</option>{/each}</select></label>
        {#each ['x','y','w','h'] as field}<label>{field.toUpperCase()}<input aria-label={`Object ${field}`} type="number" min="0" max="1" step="0.01" value={chosen[field as 'x'|'y'|'w'|'h']} disabled={!editable} onchange={event=>number(field as 'x'|'y'|'w'|'h',Number(event.currentTarget.value))}/></label>{/each}
        <label>Size<input aria-label="Object font size" type="number" min="12" max="72" value={chosen.fontSize} disabled={!editable} onchange={event=>number('fontSize',Number(event.currentTarget.value))}/></label>
        <label>Text color<input aria-label="Object text color" type="color" value={chosen.color} disabled={!editable} onchange={event=>patch({color:event.currentTarget.value})}/></label>
        <label>Fill<input aria-label="Object fill color" type="color" value={chosen.fill==='transparent'?'#FFFFFF':chosen.fill} disabled={!editable} onchange={event=>patch({fill:event.currentTarget.value})}/></label>
        <button disabled={!editable} onclick={()=>patch({fill:'transparent'})}>Clear fill</button>
        <label>Text alignment<select aria-label="Object text alignment" value={chosen.align} disabled={!editable} onchange={event=>patch({align:event.currentTarget.value as SceneObject['align']})}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
    </div><label>Object text / image description / tab-separated data<textarea aria-label="Object text or data" value={chosen.text} maxlength="6000" disabled={!editable} oninput={event=>patch({text:event.currentTarget.value})}></textarea></label>
    <div class="workspace-toolbar"><button disabled={!editable} onclick={()=>patch({x:0})}>Align left</button><button disabled={!editable} onclick={()=>patch({x:(1-chosen!.w)/2})}>Center horizontally</button><button disabled={!editable} onclick={()=>patch({x:1-chosen!.w})}>Align right</button><button disabled={!editable} onclick={()=>patch({y:(1-chosen!.h)/2})}>Center vertically</button><button disabled={!editable} onclick={()=>patch({z:Math.min(999999,Math.max(0,...design!.objects.map(o=>o.z))+1)})}>Bring forward</button><button disabled={!editable} onclick={()=>patch({z:Math.max(-999999,Math.min(0,...design!.objects.map(o=>o.z))-1)})}>Send behind</button><button disabled={!editable} onclick={()=>run(()=>removeSceneObject(session,slide.id,chosen!.id))}>Remove object</button></div>
    {#if chosen.kind==='image'}<div class="workspace-toolbar"><button disabled={!editable||busy} onclick={()=>imageInput?.click()}>Replace object image</button>{#if chosen.image&&chosen.fit==='cover'}<button disabled={!editable||busy} onclick={()=>void finishCrop()}>Finalize image crop</button><span>Finalize before presenting: only the visible pixels will enter the audience image. Undo restores the authoring original.</span>{/if}<select aria-label="Image fit or crop" value={chosen.fit} disabled={!editable} onchange={event=>patch({fit:event.currentTarget.value as SceneObject['fit']})}><option value="contain">Fit whole image</option><option value="cover">Crop to object</option></select><label>Crop horizontal<input aria-label="Image crop horizontal" type="range" min="0" max="1" step="0.01" value={chosen.cropX} disabled={!editable} oninput={event=>number('cropX',Number(event.currentTarget.value))}/></label><label>Crop vertical<input aria-label="Image crop vertical" type="range" min="0" max="1" step="0.01" value={chosen.cropY} disabled={!editable} oninput={event=>number('cropY',Number(event.currentTarget.value))}/></label></div>{/if}
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}{#if busy}<p role="status">Preparing the object image…</p>{/if}
</details>
<input class="workspace-file-input" bind:this={imageInput} type="file" accept="image/png,image/jpeg,image/webp" onchange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void image(file);}}/>
<style>
.designer-stage{position:relative;width:100%;max-width:900px;margin:auto;}.object-handle{position:absolute;z-index:2;background:transparent!important;border:1px dashed transparent;border-radius:0;padding:0;touch-action:none;cursor:move;}.object-handle:hover,.object-handle:focus-visible{border-color:currentColor;}.object-handle.chosen{outline:2px solid #498DCF;outline-offset:1px;}.designer-controls{padding:.6rem;border:1px solid var(--border-color,#777);margin:.7rem 0;}.object-fields{display:flex;flex-wrap:wrap;gap:.5rem;}.object-fields label{display:grid;gap:.2rem;max-width:10rem;}input[type=number]{width:5rem;}textarea{width:100%;min-height:5rem;box-sizing:border-box;}.hint{font-size:.85rem;opacity:.85;}
</style>
