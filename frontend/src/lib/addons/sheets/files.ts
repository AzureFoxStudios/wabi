import type {Fields} from '../../workspaceArtifacts/model';
import {inWorker} from '../../workspaceArtifacts/formats/worker';
import type {WorkbookImport,WorkbookExport} from './fileCodec';
export {workbookFromRows} from './fileCodec';
export async function importWorkbook(file:File,signal?:AbortSignal):Promise<WorkbookImport>{
  const bytes=await file.arrayBuffer();
  return inWorker(new Worker(new URL('./files.worker.ts',import.meta.url),{type:'module'}),{action:'import',bytes,name:file.name},[bytes],signal);
}
export async function exportWorkbook(fields:Fields,sheet:string,format:'csv'|'tsv'|'xlsx'|'ods',signal?:AbortSignal):Promise<{name:string;blob:Blob;warnings:string[]}>{
  const result=await inWorker<WorkbookExport>(new Worker(new URL('./files.worker.ts',import.meta.url),{type:'module'}),{action:'export',fields,sheet,format},[],signal);
  return {name:result.name,blob:new Blob([result.bytes as Uint8Array<ArrayBuffer>],{type:result.mime}),warnings:result.warnings};
}
