import type {Fields} from '../../workspaceArtifacts/model';
import {inWorker} from '../../workspaceArtifacts/formats/worker';
import {fromMarkdown,newDeck,key,slideIds,normalizeImage} from './model';
import type {DeckImport,DeckExport} from './fileCodec';
export async function importDeck(file:File,signal?:AbortSignal):Promise<DeckImport>{
  if(file.size>32*1024*1024)throw new Error('Presentation input exceeds 32 MiB');
  if(/\.(md|txt)$/i.test(file.name))return {fields:fromMarkdown(await file.text(),file.name),warnings:['Slide breaks and headings were converted to an editable native deck; review the proposed slides.']};
  if(/\.(png|jpe?g|webp)$/i.test(file.name)){const fields=newDeck(),id=slideIds(fields)[0];fields.title=file.name;fields[key(id)]={title:file.name,body:'',layout:'image',image:await normalizeImage(file),hidden:false};return {fields,warnings:[]};}
  if(/\.pdf$/i.test(file.name)){const pdf=await import('./pdf');return pdf.importPdf(file,signal);}
  const bytes=await file.arrayBuffer();return inWorker(new Worker(new URL('./files.worker.ts',import.meta.url),{type:'module'}),{action:'import',bytes,name:file.name},[bytes],signal);
}
export async function exportDeck(fields:Fields,format:'pptx'|'odp'|'html',signal?:AbortSignal):Promise<{name:string;blob:Blob;warnings:string[]}>{
  // Convert browser-native WebP attachments to PNG only for Office exports.
  let source=fields;
  if(format!=='html'){
    source=structuredClone(fields);
    for(const id of slideIds(source)){const item=source[key(id)] as {image?:string};if(item.image?.startsWith('data:image/webp;')){
      const blob=await (await fetch(item.image)).blob(),image=await createImageBitmap(blob);try{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');if(!context)throw new Error('Raster export is unavailable');context.drawImage(image,0,0);item.image=canvas.toDataURL('image/png');}finally{image.close();}
    }}
  }
  const result=await inWorker<DeckExport>(new Worker(new URL('./files.worker.ts',import.meta.url),{type:'module'}),{action:'export',fields:source,format},[],signal);
  return {name:result.name,blob:new Blob([result.bytes as Uint8Array<ArrayBuffer>],{type:result.mime}),warnings:result.warnings};
}
