import {steamAppId,type LibraryGame} from './model';
import {newLocalGameKey} from './localGameKey';
/** Pasting a Steam store address is enough; players need not extract its AppID. */
export function manualGame(title: string, identifier: string, library: LibraryGame[], localKey: ()=>string = newLocalGameKey): LibraryGame {
 let code=identifier.trim();
 if(/^https?:\/\//i.test(code)) {
  const url=new URL(code);
  const id=url.hostname==='store.steampowered.com' && !url.username && !url.password ? /^\/app\/([1-9][0-9]*)(?:\/|$)/.exec(url.pathname)?.[1] : null;
  if(!id || !steamAppId(`steam:${id}`)) throw new Error('Paste a Steam store game address, or leave the identifier empty.');
  code=`steam:${id}`;
 }
 const known=library.find(game=>game.title.toLocaleLowerCase()===title.trim().toLocaleLowerCase());
 return {title:title.trim(),key:code?(/^[0-9]+$/.test(code)?`steam:${code}`:code):known?.key || localKey()};
}
