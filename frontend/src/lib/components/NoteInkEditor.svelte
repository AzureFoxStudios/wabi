<script lang="ts">
 import { onMount } from 'svelte';
 import { emptyInk, checkedInk, strokeTouches, type NoteInk, type InkStroke } from '$lib/notes/ink';
 let { initial = null, initialTool = 'pen', embedded = false, onsave, oncancel }: { initial?: NoteInk | null; initialTool?: 'pen'|'eraser'|'line'; embedded?: boolean; onsave: (ink: NoteInk, png: string) => void; oncancel: () => void } = $props();
 let ink = $state<NoteInk>(structuredClone($state.snapshot(initial || emptyInk())));
 let canvas = $state<HTMLCanvasElement>();
 let tool = $state<'pen'|'eraser'|'scroll'|'line'|'rect'|'ellipse'>(initialTool);
 $effect(() => { tool = initialTool; });
 let shapeStart: [number, number] | null = null;
 let color = $state(initial?.paper === 'dark' ? '#ffffff' : '#172326'), width = $state(3), error = $state('');
 let undo = $state<NoteInk[]>([]), redo = $state<NoteInk[]>([]);
 let drawing: InkStroke | null = null, pointer: number | null = null;
 function repaint() {
  const ctx = canvas?.getContext('2d'); if (!ctx) return;
  ctx.fillStyle = ink.paper === 'dark' ? '#172326' : ink.paper === 'gray' ? '#e5e7eb' : '#ffffff';ctx.fillRect(0,0,800,1000);
  ctx.strokeStyle = ink.paper === 'dark' ? '#ffffff33' : '#17232622';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=1;
  if(ink.guide==='lines'){ctx.beginPath();for(let y=32;y<1000;y+=32){ctx.moveTo(0,y);ctx.lineTo(800,y);}ctx.stroke();}
  if(ink.guide==='dots')for(let y=24;y<1000;y+=24)for(let x=24;x<800;x+=24){ctx.beginPath();ctx.arc(x,y,1,0,Math.PI*2);ctx.fill();}
  ctx.lineCap='round';ctx.lineJoin='round';
  for(const stroke of ink.strokes){ctx.strokeStyle=stroke.color;ctx.fillStyle=stroke.color;ctx.lineWidth=stroke.width;ctx.beginPath();const first=stroke.points[0];ctx.moveTo(...first);for(const point of stroke.points.slice(1))ctx.lineTo(...point);if(stroke.points.length===1){ctx.arc(first[0],first[1],stroke.width/2,0,Math.PI*2);ctx.fill();}else ctx.stroke();}
 }
 onMount(repaint);
 function snapshot(){undo=[...undo.slice(-29),structuredClone($state.snapshot(ink))];redo=[];}
 function point(event:PointerEvent):[number,number]{const rect=canvas!.getBoundingClientRect();return[Math.max(0,Math.min(800,(event.clientX-rect.left)*800/rect.width)),Math.max(0,Math.min(1000,(event.clientY-rect.top)*1000/rect.height))];}
 function erase(at:[number,number]){ink.strokes=ink.strokes.filter(stroke=>!strokeTouches(stroke, at));}
 function start(event:PointerEvent){if(event.button!==0||pointer!==null||tool==='scroll')return;if(ink.strokes.length>=1000&&tool!=='eraser'){error='This sheet is full. Erase a stroke before adding more.';return;}event.preventDefault();error='';pointer=event.pointerId;canvas!.setPointerCapture(pointer);snapshot();const at=point(event);if(tool!=='eraser'){shapeStart=at;drawing={color,width,points:[at]};ink.strokes=[...ink.strokes,drawing];drawing=ink.strokes.at(-1)!;}else erase(at);repaint();}
 function move(event:PointerEvent){if(pointer!==event.pointerId)return;event.preventDefault();if(tool==='eraser')erase(point(event));else if(drawing && shapeStart && ['line','rect','ellipse'].includes(tool)){const at=point(event),[x,y]=shapeStart;if(tool==='line')drawing.points=[shapeStart,at];else if(tool==='rect')drawing.points=[[x,y],[at[0],y],at,[x,at[1]],[x,y]];else {const cx=(x+at[0])/2,cy=(y+at[1])/2,rx=Math.abs(x-at[0])/2,ry=Math.abs(y-at[1])/2;drawing.points=Array.from({length:49},(_,i)=>[cx+rx*Math.cos(i*Math.PI/24),cy+ry*Math.sin(i*Math.PI/24)] as [number,number]);}}else if(drawing){for(const next of event.getCoalescedEvents?.() || [event]){const at=point(next),previous=drawing.points.at(-1)!;if(drawing.points.length<60000&&Math.hypot(at[0]-previous[0],at[1]-previous[1])>1)drawing.points.push(at);}}repaint();}
 function finish(event:PointerEvent){if(pointer!==event.pointerId)return;pointer=null;drawing=null;shapeStart=null;repaint();}
 function history(back:boolean){const list=back?undo:redo;if(!list.length)return;const next=list.at(-1)!;if(back){redo=[...redo,structuredClone($state.snapshot(ink))];undo=undo.slice(0,-1);}else{undo=[...undo,structuredClone($state.snapshot(ink))];redo=redo.slice(0,-1);}ink=structuredClone($state.snapshot(next));repaint();}
 function paperChange(value:NoteInk['paper']){snapshot();ink.paper=value;if(value==='dark'&&color==='#172326')color='#ffffff';else if(value!=='dark'&&color==='#ffffff')color='#172326';repaint();}
 function guideChange(value:NoteInk['guide']){snapshot();ink.guide=value;repaint();}
 function save(){try{checkedInk(ink);repaint();onsave(structuredClone($state.snapshot(ink)),canvas!.toDataURL('image/png'));}catch(failure){error=(failure as Error).message;}}
</script>
<div class="ink-editor" class:embedded>

 <div class="ink-tools" role="toolbar" aria-label="Handwriting tools">
  {#if !embedded}<button aria-pressed={tool==='pen'} onclick={()=>tool='pen'}>Pen</button><button aria-pressed={tool==='eraser'} onclick={()=>tool='eraser'}>Eraser</button>{/if}<label>Shape<select aria-label="Drawing shape" value={['line','rect','ellipse'].includes(tool) ? tool : ''} onchange={event=> { if(event.currentTarget.value) tool=event.currentTarget.value as 'line'|'rect'|'ellipse'; }}><option value="" disabled>Choose…</option><option value="line">Line</option><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select></label><button aria-pressed={tool==='scroll'} onclick={()=>tool='scroll'}>Scroll</button><button disabled={!undo.length} onclick={()=>history(true)}>Undo</button><button disabled={!redo.length} onclick={()=>history(false)}>Redo</button>
  <label>Size<select aria-label="Pen width" bind:value={width}><option value={2}>Fine</option><option value={3}>Medium</option><option value={6}>Thick</option></select></label>
  <label>Ink<input type="color" aria-label="Pen color" bind:value={color}/></label>
  <label>Paper<select aria-label="Sketch paper" value={ink.paper} onchange={event=>paperChange(event.currentTarget.value as NoteInk['paper'])}><option value="white">White</option><option value="gray">Gray</option><option value="dark">Dark</option></select></label>
  <label>Guides<select aria-label="Sketch guides" value={ink.guide} onchange={event=>guideChange(event.currentTarget.value as NoteInk['guide'])}><option value="none">None</option><option value="lines">Lines</option><option value="dots">Dots</option></select></label>
 </div>
 <div class="ink-sheet"><canvas bind:this={canvas} width="800" height="1000" aria-label="Handwriting canvas" class:scroll-sheet={tool==='scroll'} onpointerdown={start} onpointermove={move} onpointerup={finish} onpointercancel={finish}></canvas></div>
 {#if error}<p role="alert">{error}</p>{/if}
 <div class="ink-actions"><button onclick={oncancel}>Cancel</button><button class="save-ink" onclick={save}>Save drawing to note</button></div>
</div>
<style>
 .ink-editor{flex:1;min-height:0;overflow:auto;padding:16px;color:var(--w-text)}p{font-size:13px;line-height:1.5;color:var(--w-mute);margin:0 0 12px}.ink-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}button,select,input{min-height:40px;font:inherit;font-size:13px;color:var(--w-text);background:var(--bg-secondary);border:1px solid var(--w-line);border-radius:8px;padding:6px 10px}button{cursor:pointer}button[aria-pressed='true'],.save-ink{background:var(--w-accent);color:var(--w-on-accent)}button:disabled{opacity:.45}label{display:flex;align-items:center;gap:6px;font-size:12px}input[type='color']{width:40px;padding:3px}.ink-sheet{max-height:50vh;overflow:auto;border:1px solid var(--w-line);border-radius:8px;background:var(--bg-secondary)}canvas{display:block;width:100%;height:auto;touch-action:none;cursor:crosshair}.ink-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}canvas.scroll-sheet{touch-action:pan-y;cursor:grab}@media(max-width:600px){.ink-editor{padding:12px}.ink-sheet{max-height:32vh;min-height:180px}.ink-tools{gap:6px}.ink-editor>p{font-size:12px;margin-bottom:8px}}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--w-accent);outline-offset:2px}
.ink-editor.embedded{display:flex;flex-direction:column;overflow:hidden}.embedded .ink-tools,.embedded .ink-actions{flex-shrink:0}.embedded .ink-sheet{flex:1;min-height:120px;max-height:none}
</style>
