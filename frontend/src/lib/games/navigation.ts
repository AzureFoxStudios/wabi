import { get, writable } from 'svelte/store';
import { currentUser } from '$lib/socket';
import { getServerUrl } from '$lib/serverUrl';
import { authSessionGeneration, onAuthSessionCleared } from '$lib/authSession';
export interface GamesRequest { server: string; owner: string; generation: number; profileId: string | null; channelId: string; tab: 'board' | 'steam' | 'match'; label: string }
export const gamesDialog = writable<GamesRequest | null>(null);
export function openGames(options: Partial<Pick<GamesRequest,'profileId'|'channelId'|'tab'|'label'>> = {}): void {
  const self=get(currentUser)?.dbUserId; if (!self) return;
  const server=getServerUrl();
  gamesDialog.set({server,owner:String(self),generation:authSessionGeneration(server),profileId:null,channelId:'',tab:'board',label:'Games',...options});
}
onAuthSessionCleared(() => gamesDialog.set(null));
