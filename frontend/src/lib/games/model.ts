/** Provider-independent, deliberately curated game selections. No activity history. */
export interface GameSelection {
  key: string; title: string; platform: string; tags: string[]; note: string;
  rotation: boolean; favorite: boolean; invitations: boolean; visibility: 'private' | 'server';
}
export interface GameBoard { revision: string; entries: GameSelection[]; steamId: string | null; showSteamLink: boolean }
export interface GamePublicBoard { entries: GameSelection[]; steamProfileUrl: string | null }
export interface SteamCapabilities { enabled: boolean; linking: boolean; library: boolean; liveActivity: false; sessionJoining: false }
export interface LibraryGame { key: string; title: string }
export interface LinkFlow { ticket: string; proof: string; authorizeUrl: string; expiresIn: number }
export interface Member { id: string; name: string }
export function steamAppId(key: string): string | null {
  const match = /^steam:([1-9][0-9]{0,9})$/.exec(key);
  return match && Number(match[1]) <= 4294967295 ? match[1] : null;
}
export function steamLaunchUrl(key: string): string | null { const id = steamAppId(key); return id ? `steam://run/${id}` : null; }
export function steamStoreUrl(key: string): string | null { const id = steamAppId(key); return id ? `https://store.steampowered.com/app/${id}/` : null; }
export function validKey(key: string): boolean { return !!steamAppId(key) || /^local:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key); }
function text(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && [...value].length <= max && (!required || !!value.trim()) &&
    ![...value].some(c => /\p{Cc}/u.test(c) && c !== '\n' && c !== '\t');
}
export function selections(value: unknown): GameSelection[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid game selections');
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid game');
    const e = raw as Record<string, unknown>;
    if (typeof e.key !== 'string' || !validKey(e.key) || seen.has(e.key) || !text(e.title,120,true) ||
        !text(e.platform,40) || !text(e.note,300) || !Array.isArray(e.tags) || e.tags.length>8 ||
        !e.tags.every(t=>text(t,24,true)) || new Set(e.tags).size!==e.tags.length ||
        !['private','server'].includes(String(e.visibility)) ||
        ['rotation','favorite','invitations'].some(k=>typeof e[k]!=='boolean')) throw new Error('Invalid or duplicate game selection');
    seen.add(e.key);
    return { key:e.key,title:e.title,platform:e.platform,note:e.note,tags:[...e.tags] as string[],
      visibility:e.visibility as GameSelection['visibility'],rotation:e.rotation as boolean,favorite:e.favorite as boolean,invitations:e.invitations as boolean };
  });
}
export function board(value: unknown): GameBoard {
  if (!value || typeof value!=='object') throw new Error('Game board was not returned');
  const b=value as Record<string,unknown>;
  if (typeof b.revision!=='string' || !b.revision || b.revision.length>64 || typeof b.showSteamLink!=='boolean' ||
      (b.steamId!==null && (typeof b.steamId!=='string' || !/^7656[0-9]{13}$/.test(b.steamId)))) throw new Error('Invalid game board response');
  return {revision:b.revision,entries:selections(b.entries),steamId:b.steamId as string|null,showSteamLink:b.showSteamLink};
}
export function privateSelection(game: LibraryGame): GameSelection {
  if (!validKey(game.key) || !text(game.title,120,true)) throw new Error('Invalid game');
  return {key:game.key,title:game.title,platform:'',tags:[],note:'',rotation:true,favorite:false,invitations:false,visibility:'private'};
}
export function safeAuthorizeUrl(raw: string): string {
  const u=new URL(raw);
  if (u.origin!=='https://steamcommunity.com' || u.pathname!=='/openid/login' || u.username || u.password || u.hash)
    throw new Error('Invalid Steam sign-in destination');
  return u.toString();
}
export function invitationIntersection(boards: GameSelection[][]): LibraryGame[] {
  if (boards.length<2 || boards.length>12) return [];
  return boards[0].filter(e=>e.visibility==='server' && e.invitations && boards.slice(1).every(b=>b.some(x=>x.key===e.key && x.visibility==='server' && x.invitations)))
    .map(({key,title})=>({key,title}));
}
