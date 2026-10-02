import {test,expect} from 'bun:test';
import {createFileExporter,exportFileName,MAX_NATIVE_EXPORT_BYTES,type ExportPorts,type ExportState,type NativeExportInput} from './fileExportCore';

async function digest(bytes:ArrayBuffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
function fixture(overrides:Partial<ExportPorts>={}){
    const states:ExportState[]=[],downloads:{name:string;blob:Blob}[]=[],inputs:NativeExportInput[]=[];
    const ports:ExportPorts={desktop:()=>true,state:value=>states.push(value),digest,browser:(name,blob)=>downloads.push({name,blob}),native:async input=>{inputs.push(input);const bytes=Uint8Array.from(atob(input.bytesBase64),c=>c.charCodeAt(0));return {status:'saved',bytesWritten:bytes.length,directorySynced:true,sha256:await digest(bytes.buffer)};},...overrides};
    return {exporter:createFileExporter(ports),states,downloads,inputs};
}
test('native export receives exact immutable bytes and verifies its receipt',async()=>{
    const f=fixture(),source=new Uint8Array([0,255,1,13,10]),blob=new Blob([source]);
    const result=await f.exporter.save('workbook.xlsx',blob);
    expect(result.phase).toBe('saved');expect(f.downloads).toHaveLength(0);expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0].protocol).toBe(1);expect(f.inputs[0].byteLength).toBe(5);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(source));
    expect(f.states.map(s=>s.phase)).toEqual(['saving','saved']);expect(f.exporter.busy).toBe(false);
});
test('browser download is not reported as a disk-confirmed save',async()=>{
    const f=fixture({desktop:()=>false});const result=await f.exporter.save('lesson.txt','คน 🙂','text/plain');
    expect(result.phase).toBe('download-requested');expect(f.inputs).toHaveLength(0);expect(f.downloads).toHaveLength(1);expect(await f.downloads[0].blob.text()).toBe('คน 🙂');
});
test('native cancellation is terminal and never starts a fallback download',async()=>{
    const f=fixture({native:async()=>({status:'cancelled'})});expect((await f.exporter.save('deck.pptx','data')).phase).toBe('cancelled');expect(f.downloads).toHaveLength(0);expect(f.exporter.busy).toBe(false);
});
test('uncertain IPC failure does not expose paths, retry or create another file',async()=>{
    let calls=0;const f=fixture({native:async()=>{calls++;throw new Error('C:\\private\\user-name\\report.xlsx');}});
    const result=await f.exporter.save('sheet.xlsx','data');expect(result.phase).toBe('uncertain');expect(result.message).not.toContain('user-name');expect(calls).toBe(1);expect(f.downloads).toHaveLength(0);
});
test('malformed, stale or mismatched receipts cannot claim a verified save',async()=>{
    for(const reply of [null,{}, {status:'saved',bytesWritten:99,directorySynced:true,sha256:'wrong'}, {status:'saved',bytesWritten:4,directorySynced:true,sha256:'wrong'}]){
        const f=fixture({native:async()=>reply});expect((await f.exporter.save('x.txt','data')).phase).toBe('uncertain');expect(f.downloads).toHaveLength(0);
    }
});
test('directory durability warning is a committed save, not a failed write',async()=>{
    const f=fixture({native:async input=>({status:'saved',bytesWritten:input.byteLength,directorySynced:false,sha256:await digest(new TextEncoder().encode('data').buffer)})});
    const result=await f.exporter.save('x.txt','data');expect(result.phase).toBe('saved');expect(result.message).toContain('durability could not be confirmed');
});
test('oversized native export is rejected before allocating an IPC payload or opening a dialog',async()=>{
    const f=fixture();const blob=new Blob();Object.defineProperty(blob,'size',{value:MAX_NATIVE_EXPORT_BYTES+1});
    const result=await f.exporter.save('large.json',blob);expect(result.phase).toBe('error');expect(f.inputs).toHaveLength(0);expect(f.exporter.busy).toBe(false);
});
test('one export at a time without dropping or retaining an unbounded queue',async()=>{
    let release!:(value:unknown)=>void,entered!:(value:void)=>void;const ready=new Promise<void>(resolve=>entered=resolve);
    const f=fixture({native:()=>{entered();return new Promise(resolve=>release=resolve);}});
    const first=f.exporter.save('one.txt','one');await ready;
    await expect(f.exporter.save('two.txt','two')).rejects.toThrow('already in progress');
    release({status:'cancelled'});await first;expect(f.exporter.busy).toBe(false);expect(f.downloads).toHaveLength(0);
});
test('encoding failure clears busy state before another explicit attempt',async()=>{
    const f=fixture({digest:async()=>{throw new Error('Digest unavailable');}});expect((await f.exporter.save('x.txt','x')).phase).toBe('error');expect(f.exporter.busy).toBe(false);expect(f.inputs).toHaveLength(0);
});
test('suggested filenames do not include traversal, ADS or display-direction controls',()=>{
    expect(exportFileName('../evil:name\n.txt')).toBe('.._evil_name_.txt');expect(exportFileName('คน 🙂.xlsx')).toBe('คน 🙂.xlsx');expect(exportFileName('')).toBe('Wabi-export.bin');expect(exportFileName('a\u202eb.txt')).toBe('a_b.txt');
});
