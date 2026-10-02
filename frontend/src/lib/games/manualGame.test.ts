import {test,expect} from 'bun:test';
import {manualGame} from './manualGame';
test('manual games accept store links and preserve selected catalog identities',()=>{
 expect(manualGame('Portal','https://store.steampowered.com/app/400/Portal/',[]).key).toBe('steam:400');
 expect(manualGame(' portal ','',[{key:'steam:400',title:'Portal'}]).key).toBe('steam:400');
 expect(manualGame('Genshin','',[],()=> 'local:test')).toEqual({title:'Genshin',key:'local:test'});
 for(const url of ['https://other.test/app/400/','https://store.steampowered.com@other.test/app/400/','https://store.steampowered.com/app/4294967296/'])expect(()=>manualGame('Game',url,[])).toThrow();
});
