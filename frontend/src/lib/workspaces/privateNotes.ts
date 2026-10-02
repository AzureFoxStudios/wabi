/** Tiny device-only note storage for the presenter view. No editor or CRDT import. */
export interface NoteScope {scopeId:string;isCurrent:()=>boolean;}
let database:Promise<IDBDatabase>|null=null;
function db():Promise<IDBDatabase>{
    if(database)return database;
    database=new Promise<IDBDatabase>((resolve,reject)=>{
        const request=indexedDB.open('wabi-workspace-artifacts-v1',1);
        request.onupgradeneeded=()=>{const store=request.result.createObjectStore('artifacts',{keyPath:'key'});store.createIndex('scope','scopeId');request.result.createObjectStore('private-notes',{keyPath:'key'});};
        request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Close the older workspace window to reopen private notes.'));
        request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();database=null;};resolve(request.result);};
    }).catch(error=>{database=null;throw error;});return database;
}
export async function readPrivateNotes(scope:NoteScope,id:string):Promise<Record<string,string>>{
    const database=await db();const notes=await new Promise<Record<string,string>>((resolve,reject)=>{
        const request=database.transaction('private-notes','readonly').objectStore('private-notes').get(`${scope.scopeId}\u0000${id}`);
        request.onsuccess=()=>resolve(request.result?.notes||{});request.onerror=()=>reject(request.error);
    });if(!scope.isCurrent())throw new Error('Account changed while reading private notes.');return notes;
}
export async function savePrivateNote(scope:NoteScope,id:string,slide:string,text:string):Promise<void>{
    if(text.length>32000)throw new Error('Private note exceeds its size limit.');
    const database=await db();await new Promise<void>((resolve,reject)=>{
        const transaction=database.transaction('private-notes','readwrite'),store=transaction.objectStore('private-notes'),key=`${scope.scopeId}\u0000${id}`,request=store.get(key);
        request.onsuccess=()=>store.put({key,notes:{...(request.result?.notes||{}),[slide]:text}});
        transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error||new Error('Private note save interrupted.'));
    });
}
