<script lang="ts">
    import type { AudienceSlide } from './bridge';
    let {slide,aspect=16/9,blank=false}:{slide:AudienceSlide|null;aspect?:number;blank?:boolean}=$props();
    const safeImage=$derived(slide?.image&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(slide.image)&&slide.image.length<=2*1024*1024?slide.image:null);
    const ratio=$derived(Number.isFinite(aspect)?Math.max(.5,Math.min(3,aspect)):16/9);
</script>
<section class="audience-slide" class:blank class:title-slide={slide?.layout==='title'} class:split={slide?.layout==='split'} class:image-slide={slide?.layout==='image'} class:quote={slide?.layout==='quote'} style:aspect-ratio={ratio} aria-label={blank?'Screen blanked by presenter':slide?.title||'Slide'}>
    {#if !blank&&slide}<div class="slide-text"><h1>{slide.title}</h1>{#if slide.body}<p>{slide.body}</p>{/if}</div>{#if safeImage}<img src={safeImage} alt={slide.title||'Presentation image'} draggable="false"/>{/if}{/if}
</section>
<style>
.audience-slide{box-sizing:border-box;container-type:inline-size;position:relative;width:100%;max-height:100%;overflow:hidden;background:#f4f1e9;color:#242836;display:flex;flex-direction:column;justify-content:center;padding:5%;border-radius:3px;font-family:system-ui,sans-serif}.audience-slide.blank{background:#000}.slide-text{position:relative;z-index:1;min-width:0;max-height:100%;overflow:auto}h1{font-size:clamp(20px,4.1cqw,64px);line-height:1.14;margin:0 0 .55em;overflow-wrap:anywhere}p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:clamp(14px,2.25cqw,36px);line-height:1.5;margin:0}img{display:block;min-height:0;max-width:100%;max-height:70%;object-fit:contain;margin-top:3%}.title-slide{text-align:center}.title-slide h1{font-size:clamp(24px,5.5cqw,84px)}.split{flex-direction:row;align-items:center;gap:4%}.split .slide-text{width:48%;flex:1}.split img{width:48%;max-height:100%;margin:0}.image-slide{padding:2%}.image-slide .slide-text{position:absolute;left:4%;right:4%;bottom:3%;padding:1.2%;background:#f4f1e9e8}.image-slide h1{font-size:clamp(16px,2.8cqw,42px);margin:0}.image-slide p{font-size:clamp(13px,1.7cqw,24px)}.image-slide img{height:100%;max-height:100%;width:100%;margin:0}.quote p{font-size:clamp(18px,3.2cqw,48px);font-style:italic}.quote h1{font-size:clamp(14px,1.8cqw,26px)}
</style>
