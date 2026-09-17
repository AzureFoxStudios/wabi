import { importWorkbookBytes, exportWorkbookBytes } from './fileCodec';
self.onmessage = async event => {
  try {
    const p=event.data;
    const result=p.action==='import'?await importWorkbookBytes(p.bytes,p.name):exportWorkbookBytes(p.fields,p.sheet,p.format);
    self.postMessage({result});
  } catch(error) { self.postMessage({error:error instanceof Error?error.message:String(error)}); }
};
