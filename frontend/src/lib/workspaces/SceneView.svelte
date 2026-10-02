<script lang="ts">
    import { cleanDesign, scenePalette, tableRows, chartRows, type SlideDesign } from './scene';
    let { design }: { design: SlideDesign } = $props();
    const safe = $derived.by(() => { try { return cleanDesign(design); } catch { return null; } });
</script>
{#if safe}
    <div class="scene" style:background={scenePalette[safe.theme].background} aria-label="Slide canvas">
        {#each safe.objects as object (object.id)}
            <div class="object" style:left={`${object.x*100}%`} style:top={`${object.y*100}%`} style:width={`${object.w*100}%`} style:height={`${object.h*100}%`} style:background={object.fill} style:color={object.color} style:font-size={`${object.fontSize/10}cqw`} style:text-align={object.align} class:ellipse={object.kind==='ellipse'}>
                {#if object.kind==='text'}<div class="text">{object.text}</div>
                {:else if object.kind==='image' && object.image}<img src={object.image} alt={object.text} style:object-fit={object.fit} style:object-position={`${object.cropX*100}% ${object.cropY*100}%`} draggable="false"/>
                {:else if object.kind==='line'}<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={object.text || 'Line'}><line x1="0" y1="0" x2="100" y2="100" stroke={object.color} stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
                {:else if object.kind==='table'}
                    {@const rows=tableRows(object.text)}
                    {#if rows.length}<table><tbody>{#each rows as row,index}<tr>{#each row as cell}{#if index===0}<th scope="col">{cell}</th>{:else}<td>{cell}</td>{/if}{/each}</tr>{/each}</tbody></table>{:else}<p class="invalid">Table requires at most 20 rows and 8 tab-separated columns.</p>{/if}
                {:else if object.kind==='chart'}
                    {@const rows=chartRows(object.text)}{@const maximum=Math.max(1,...rows.map(row=>Math.abs(row.value)))}
                    {#if rows.length}<div class="chart" role="img" aria-label={rows.map(row=>`${row.label}: ${row.value}`).join(', ')}>{#each rows as row}<div class="chart-row"><span>{row.label}</span><div class="bar-space"><i class="axis"></i><i class="bar" style:left={`${row.value<0?50-Math.abs(row.value)/maximum*50:50}%`} style:width={`${Math.abs(row.value)/maximum*50}%`} style:background={scenePalette[safe.theme].accent}></i></div><span>{row.value}</span></div>{/each}</div>{:else}<p class="invalid">Chart requires label and numeric value columns separated by a tab.</p>{/if}
                {/if}
            </div>
        {/each}
    </div>
{:else}<p role="alert">This slide design is unavailable or exceeds its safety limits.</p>{/if}
<style>
    .scene {position:absolute;inset:0;overflow:hidden;container-type:inline-size;}
    .object {position:absolute;box-sizing:border-box;overflow:hidden;line-height:1.25;font-family:Arial,sans-serif;}
    .text {white-space:pre-wrap;overflow-wrap:anywhere;padding:.15em;}
    .ellipse {border-radius:50%;}
    img,svg {width:100%;height:100%;display:block;}
    table {width:100%;height:100%;border-collapse:collapse;table-layout:fixed;font-size:.72em;}
    th,td {border:1px solid currentColor;padding:.2em;overflow-wrap:anywhere;white-space:pre-wrap;}
    .chart {height:100%;display:flex;flex-direction:column;justify-content:space-around;gap:.15em;font-size:.72em;}
    .chart-row {display:grid;grid-template-columns:28% 1fr 18%;align-items:center;gap:2%;min-height:0;flex:1;}
    .chart-row span {overflow-wrap:anywhere;}
    .bar-space {height:70%;position:relative;}
    .bar {position:absolute;top:0;bottom:0;}
    .axis {position:absolute;left:50%;top:-10%;bottom:-10%;border-left:1px solid currentColor;opacity:.5;}
    .invalid {font-size:.65em;}
</style>
