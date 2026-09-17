<script lang="ts">
  import type {Fields} from '../../workspaceArtifacts/model';
  import {getCell,getSheet} from './model';
  import {createCalculator} from './formula';
  let {fields,chart}=$props<{fields:Fields;chart:{title:string;type:'bar'|'line'|'pie';sheet:string;rows:string[];columns:string[]}}>();
  const data=$derived.by(()=>{
    try{const calc=createCalculator(fields),s=getSheet(fields,chart.sheet),label=chart.columns[0],value=chart.columns[1]||label;
      return chart.rows.filter(r=>s.rows.includes(r)).slice(0,40).map(r=>({label:String(calc.cell(chart.sheet,r,label)??''),value:Number(calc.cell(chart.sheet,r,value))})).filter(x=>Number.isFinite(x.value));
    }catch{return [];}
  });
  const max=$derived(Math.max(1,...data.map(x=>Math.abs(x.value))));
  const total=$derived(data.reduce((a,d)=>a+Math.max(0,d.value),0));
  function wedge(start:number,finish:number){const a=start*2*Math.PI-Math.PI/2,b=finish*2*Math.PI-Math.PI/2;return `M150 110 L${150+85*Math.cos(a)} ${110+85*Math.sin(a)} A85 85 0 ${finish-start>.5?1:0} 1 ${150+85*Math.cos(b)} ${110+85*Math.sin(b)} Z`;}
</script>
<figure>
  <figcaption>{chart.title}</figcaption>
  <svg viewBox="0 0 600 240" role="img" aria-label={chart.title||'Chart'}>
    {#if chart.type==='pie'&&total>0}
      {#each data as d,i}{@const start=data.slice(0,i).reduce((a,d)=>a+Math.max(0,d.value),0)/total}{#if d.value>0}{#if d.value===total}<circle cx="150" cy="110" r="85" fill="hsl(160 45% 45%)" />{:else}<path d={wedge(start,start+d.value/total)} fill={`hsl(${i*67%360} 45% 45%)`} />{/if}{/if}<text x="275" y={20+i*16}>{d.label}: {d.value}</text>{/each}
    {:else if chart.type==='line'}<polyline points={data.map((d,i)=>`${30+i*540/Math.max(1,data.length-1)},${115-d.value/max*95}`).join(' ')} fill="none" stroke="currentColor" stroke-width="3" />
    {:else}{#each data as d,i}{@const width=540/Math.max(1,data.length)}<rect x={30+i*width} y={d.value>=0?115-d.value/max*95:115} width={Math.max(1,width-4)} height={Math.abs(d.value)/max*95} fill="currentColor" /><text x={30+i*width} y="232" font-size="10">{d.label.slice(0,8)}</text>{/each}{/if}
    {#if chart.type!=='pie'}<line x1="25" y1="115" x2="585" y2="115" stroke="currentColor" opacity=".3" />{/if}
  </svg>
  <details><summary>Chart data</summary><table><tbody>{#each data as d}<tr><td>{d.label}</td><td>{d.value}</td></tr>{/each}</tbody></table></details>
</figure>
<style>figure{margin:12px;padding:14px;border:1px solid var(--border-color);border-radius:8px;max-width:650px}figcaption{font-weight:600;margin-bottom:10px}svg{width:100%;color:var(--accent,var(--text-primary))}text{fill:var(--text-primary)}td{padding:4px 12px}</style>
