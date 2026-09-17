import {importDeckBytes,exportDeckBytes} from './fileCodec';
self.onmessage=async event=>{try{const p=event.data,result=p.action==='import'?await importDeckBytes(p.bytes,p.name):exportDeckBytes(p.fields,p.format);self.postMessage({result});}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
