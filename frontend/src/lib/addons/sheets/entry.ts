import {registerTool,unregisterTool} from '$lib/workspaceArtifacts/tools';
export function onInit():void{registerTool({id:'sheets',label:'Sheets',load:()=>import('./Sheets.svelte'),create:()=>import('./model').then(m=>m.newWorkbook())});}
export async function onDisable():Promise<void>{await unregisterTool('sheets');}
export async function onUnload():Promise<void>{await unregisterTool('sheets');}
