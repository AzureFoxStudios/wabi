export class SheetWorker {
    private worker:Worker|null=null;
    private sequence=0;
    private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
    private get(){if(this.worker)return this.worker;const worker=new Worker(new URL('./engine.worker.ts',import.meta.url),{type:'module'});worker.onmessage=event=>{const item=this.pending.get(event.data.id);if(!item)return;clearTimeout(item.timer);this.pending.delete(event.data.id);if(event.data.error)item.reject(new Error(event.data.error));else item.resolve(event.data.result);};worker.onerror=()=>this.close('Spreadsheet engine failed; the original and saved work are retained.');this.worker=worker;return worker;}
    run<T>(type:'calculate'|'import'|'export',payload:unknown):Promise<T>{const id=++this.sequence;return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>this.close('Spreadsheet operation exceeded its time limit. Nothing was published.'),30000);this.pending.set(id,{resolve:resolve as (v:unknown)=>void,reject,timer});try{this.get().postMessage({id,type,payload});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});}
    close(reason='Spreadsheet operation cancelled'){this.worker?.terminate();this.worker=null;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error(reason));}this.pending.clear();}
}
