<script lang="ts">
  import {safeImage,type Page} from './presentation';
  let {page,blank=false,pointer=null}=$props<{page:Page;blank?:boolean;pointer?:{x:number;y:number}|null}>();
</script>
<section class="slide" class:night={page.theme==='night'} class:sage={page.theme==='sage'} class:title-layout={page.layout==='title'} class:split={page.layout==='split'} style:aspect-ratio={page.aspect||16/9} aria-label={blank?'Presentation blanked':page.title||'Slide'}>
  {#if !blank}
    {#if page.image&&safeImage(page.image)}<img src={page.image} alt={page.body||page.title||'Presentation image'} />{/if}
    {#if page.layout!=='image'||!page.image}<div class="text"><h2>{page.title}</h2><div class="body">{page.body}</div></div>{/if}
    {#if pointer}<span class="pointer" aria-hidden="true" style:left={`${Math.max(0,Math.min(1,pointer.x))*100}%`} style:top={`${Math.max(0,Math.min(1,pointer.y))*100}%`}></span>{/if}
  {/if}
</section>
<style>
.slide{--paper:#f5f2e8;--ink:#192532;position:relative;background:var(--paper);color:var(--ink);width:100%;overflow:hidden;display:flex;align-items:stretch;container-type:inline-size;box-shadow:0 2px 18px #0002}
.slide.night{--paper:#172231;--ink:#f7f6ef}.slide.sage{--paper:#e8efe8;--ink:#1d342b}.text{padding:6%;box-sizing:border-box;min-width:0;width:100%;overflow:hidden}.text h2{font-size:clamp(16px,4cqw,48px);line-height:1.15;margin:0 0 5%;overflow-wrap:anywhere}.body{font-size:clamp(12px,2.5cqw,30px);line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}.title-layout{align-items:center;text-align:center}.title-layout h2{font-size:clamp(20px,6cqw,64px)}.slide img{width:100%;height:100%;object-fit:contain;position:absolute;inset:0}.split img{width:48%;position:relative;object-fit:contain}.split .text{width:52%;padding:5%}.pointer{width:16px;height:16px;position:absolute;border:3px solid #fff;border-radius:50%;background:#ca3341;box-shadow:0 0 3px #000;transform:translate(-50%,-50%);pointer-events:none}
</style>
