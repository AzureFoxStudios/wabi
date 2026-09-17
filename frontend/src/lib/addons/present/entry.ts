import {registerTool,unregisterTool} from '$lib/workspaceArtifacts/tools';
export function onInit():void{registerTool({id:'present',label:'Present',load:()=>import('./Present.svelte'),create:()=>import('./model').then(m=>m.newDeck())});}
export async function onDisable():Promise<void>{await unregisterTool('present');}
export async function onUnload():Promise<void>{await unregisterTool('present');}
