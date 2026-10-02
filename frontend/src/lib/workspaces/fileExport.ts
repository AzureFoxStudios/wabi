import { writable } from 'svelte/store';
import { isDesktopTauri } from '$lib/tauri-platform';
import { createFileExporter, type ExportState } from './fileExportCore';

// Status contains no path, title, document content, account ID or retained Blob.
export const workspaceExportState=writable<ExportState>({phase:'idle',message:''});
const exporter=createFileExporter({
    desktop:isDesktopTauri,
    native:async input=>{
        const {invoke}=await import('@tauri-apps/api/core');
        return invoke('workspace_export_file',{input});
    },
    browser:(name,blob)=>{
        const url=URL.createObjectURL(blob),link=document.createElement('a');
        try {link.href=url;link.download=name;link.hidden=true;document.body.appendChild(link);link.click();}
        finally {link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    },
    digest:async buffer=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),byte=>byte.toString(16).padStart(2,'0')).join(''),
    state:state=>workspaceExportState.set(state)
});

/** Compatible with existing workspace export actions; never leaves an unhandled
 * rejection. Native errors stay visible and do not trigger a second download. */
export function download(name:string,source:string|Blob,type='application/json'):void {
    if(exporter.busy)return;
    void exporter.save(name,source,type).catch(()=>{
        workspaceExportState.set({phase:'error',message:'Export could not start. Your workspace remains available.'});
    });
}
export function dismissExportStatus(){if(!exporter.busy)workspaceExportState.set({phase:'idle',message:''});}
