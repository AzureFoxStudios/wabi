/** Optional, lazy PDF-to-audience-raster adapter. It never opens URLs from a PDF
 * or enables scripting, XFA, forms, attachments, or annotation interaction. */
import {getDocument,PDFWorker,AnnotationMode,type RenderTask} from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type {Fields,Json} from '../../workspaceArtifacts/model';
import type {DeckImport} from './fileCodec';
import {key} from './model';
export async function importPdf(file:File,signal?:AbortSignal):Promise<DeckImport>{
  if(file.size>32*1024*1024)throw new Error('PDF exceeds 32 MiB');
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const port=new PdfWorker(),worker=PDFWorker.create({port}),data=new Uint8Array(await file.arrayBuffer());
  const task=getDocument({data,worker,enableXfa:false,useWasm:false,useWorkerFetch:false,stopAtErrors:true,maxImageSize:40_000_000,canvasMaxAreaInBytes:32*1024*1024,useSystemFonts:true,disableRange:true,disableStream:true,disableAutoFetch:true});
  let rendering:RenderTask|undefined,cancelled=false;
  const cancel=()=>{cancelled=true;rendering?.cancel();void task.destroy().catch(()=>{});worker.destroy();port.terminate();};
  const timer=setTimeout(cancel,45_000);signal?.addEventListener('abort',cancel,{once:true});
  try{
    const document=await task.promise;if(document.numPages>100)throw new Error('PDF presentation import is limited to 100 pages. Split the PDF first.');
    const fields:Fields={title:file.name.replace(/\.pdf$/i,''),slides:[],theme:'paper',aspect:16/9};let size=0;const ratios=new Set<string>();
    for(let n=1;n<=document.numPages;n++){
      if(cancelled||signal?.aborted)throw new DOMException('PDF rendering cancelled or timed out','AbortError');
      const page=await document.getPage(n),original=page.getViewport({scale:1});
      if(![original.width,original.height].every(v=>Number.isFinite(v)&&v>0))throw new Error('Invalid PDF page dimensions');
      const ratio=original.width/original.height;if(ratio<.5||ratio>3)throw new Error('PDF page aspect ratio is outside the supported 0.5–3 range');ratios.add(ratio.toFixed(2));if(n===1)fields.aspect=ratio;
      const viewport=page.getViewport({scale:Math.min(1600/original.width,1600/original.height)}),canvas=window.document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      try{
        rendering=page.render({canvas,viewport,annotationMode:AnnotationMode.DISABLE});await rendering.promise;rendering=undefined;
        const content=await page.getTextContent(),accessible=content.items.map(item=>'str' in item?item.str:'').join(' ').slice(0,50000),image=canvas.toDataURL('image/png');size+=image.length;
        if(image.length>4*1024*1024||size>30*1024*1024)throw new Error('Rendered PDF exceeds the presentation limit; split the PDF or reduce its image content');
        const id=crypto.randomUUID();(fields.slides as Json[]).push(id);fields[key(id)]={title:`Page ${n}`,body:accessible,layout:'image',image,hidden:false};
      }finally{canvas.width=canvas.height=0;page.cleanup();}
    }
    const warnings=['PDF pages are static rasters. Annotations, forms, attachments, and scripting are not included. Review fonts and pages before publishing. Non-embedded fonts use this device’s fallback fonts.'];
    if(ratios.size>1)warnings.push('The PDF contains mixed page sizes. Pages are fitted inside the first page’s aspect ratio without stretching.');
    return {fields,warnings};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);rendering?.cancel();await task.destroy().catch(()=>{});worker.destroy();port.terminate();}
}
