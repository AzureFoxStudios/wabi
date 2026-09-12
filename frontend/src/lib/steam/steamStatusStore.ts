/** Compatibility facade. Unscoped Steam polling is retired; live sharing is unavailable. */
import { writable } from 'svelte/store';
export const steamStatusStore = writable({enabled:false,loading:false,error:null as string|null,steamId:null as string|null,status:null as null});
export function startSteamStatusPolling(): () => void { return () => {}; }
export function refreshSteamStatusNow(): Promise<void> { return Promise.resolve(); }
export function getSteamId(): null { return null; }
export function setSteamId(_id:string|null): void { /* Use verified Steam linking in Games settings. */ }
