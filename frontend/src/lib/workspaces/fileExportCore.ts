export const MAX_NATIVE_EXPORT_BYTES = 32 * 1024 * 1024;
export interface NativeExportInput { protocol: 1; suggestedName: string; bytesBase64: string; byteLength: number; }
export type NativeExportReply = { status:'cancelled' } | { status:'saved'; bytesWritten:number; directorySynced:boolean; sha256:string };
export type ExportState = { phase:'idle'|'saving'|'saved'|'cancelled'|'download-requested'|'error'|'uncertain'; message:string };
export interface ExportPorts {
    desktop:()=>boolean;
    native:(input:NativeExportInput)=>Promise<unknown>;
    browser:(name:string,blob:Blob)=>void;
    digest:(bytes:ArrayBuffer)=>Promise<string>;
    state:(state:ExportState)=>void;
}
export function exportFileName(name:string):string {
    const value=name.replace(/[\u0000-\u001f\u007f/\\:<>"|?*\u202a-\u202e\u2066-\u2069]/gu,'_').trim();
    return value || 'Wabi-export.bin';
}
function encode(bytes:Uint8Array):string {
    const chunks:string[]=[];
    for(let at=0;at<bytes.length;at+=16384) chunks.push(String.fromCharCode(...bytes.subarray(at,at+16384)));
    return btoa(chunks.join(''));
}
/** One explicit user action; never retry, auto-download or retain export bytes. */
export function createFileExporter(ports:ExportPorts) {
    let busy=false;
    return {
        get busy(){return busy;},
        async save(name:string,source:string|Blob,type='application/json'):Promise<ExportState> {
            if(busy) throw new Error('Another export is already in progress. Finish or cancel its dialog first.');
            busy=true;
            const finish=(phase:ExportState['phase'],message:string)=>{const result={phase,message};ports.state(result);return result;};
            let invoked=false;
            try {
                const blob=typeof source==='string'?new Blob([source],{type}):source;
                const filename=exportFileName(name);
                if(!ports.desktop()) {
                    ports.browser(filename,blob);
                    return finish('download-requested','Download requested. Check your browser downloads; Wabi cannot confirm that the file reached disk.');
                }
                if(blob.size>MAX_NATIVE_EXPORT_BYTES) throw new Error('This native export exceeds 32 MiB. Your document and original file are unchanged.');
                finish('saving','Preparing local export and waiting for the native Save As dialog…');
                const buffer=await blob.arrayBuffer();
                const expectedDigest=await ports.digest(buffer);
                const input:NativeExportInput={protocol:1,suggestedName:filename,bytesBase64:encode(new Uint8Array(buffer)),byteLength:blob.size};
                invoked=true;
                const result=await ports.native(input) as NativeExportReply;
                if(result?.status==='cancelled')return finish('cancelled','Export cancelled. No download or upload was started.');
                if(result?.status!=='saved'||result.bytesWritten!==blob.size||result.sha256!==expectedDigest||typeof result.directorySynced!=='boolean') {
                    return finish('uncertain','The native save acknowledgement could not be verified. Check the selected file before retrying; your workspace is retained.');
                }
                return finish('saved',result.directorySynced
                    ?'Export saved to the selected local file. Its byte count and checksum were verified.'
                    :'Export saved and its byte count and checksum were verified. Directory power-loss durability could not be confirmed on this filesystem.');
            } catch(error) {
                // Do not echo native error strings or paths into shared views.
                return finish(invoked?'uncertain':'error',invoked
                    ?'Native export could not be confirmed. Check the selected destination before retrying. No automatic fallback download was started; your workspace is retained.'
                    :error instanceof Error?error.message:'Export could not start. Your workspace is retained.');
            } finally {busy=false;}
        }
    };
}
