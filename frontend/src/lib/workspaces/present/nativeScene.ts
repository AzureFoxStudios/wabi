import { Y, editText, type ArtifactSession } from '../session';
import { cleanDesign, cleanSceneObject, scenePalette, type SceneObject, type SceneKind, type SceneTheme, type SlideDesign } from '../scene';
import { collection } from './model';

export type ScenePreset = 'blank'|'title'|'body'|'caption'|'comparison'|'grid'|'table'|'chart';
const defaults = (kind:SceneKind, theme:SceneTheme):Omit<SceneObject,'id'> => ({kind,x:.1,y:.1,w:.8,h:.18,z:0,text:kind==='text'?'New text':'',image:null,fill:kind==='rect'||kind==='ellipse'?scenePalette[theme].accent:'transparent',color:scenePalette[theme].foreground,fontSize:24,align:'left',fit:'contain',cropX:.5,cropY:.5});
export function readDesign(root:Y.Map<unknown>, slideId:string):SlideDesign|null {
    const source=collection(root).get(slideId)?.get('design');
    if(!(source instanceof Y.Map))return null;
    const objects=source.get('objects');
    if(!(objects instanceof Y.Map))throw new Error('Slide objects are damaged; export recovery before replacing them.');
    const visible=[];
    for(const[id,value]of objects.entries()){
        if(!(value instanceof Y.Map))throw new Error('Invalid native slide object.');
        const raw=value.toJSON();const {removed,...fields}=raw;
        if(removed!==undefined&&typeof removed!=='boolean')throw new Error('Invalid slide object removal state.');
        const object=cleanSceneObject({...fields,id});
        if(!removed)visible.push(object);
    }
    return cleanDesign({theme:source.get('theme'),objects:visible});
}
function objectMap(object:SceneObject):Y.Map<unknown>{
    const map=new Y.Map<unknown>();
    for(const[key,value]of Object.entries(object)){
        if(key==='id')continue;
        if(key==='text'){const text=new Y.Text();text.insert(0,String(value));map.set(key,text);}else map.set(key,value);
    }
    return map;
}
export function setDesign(root:Y.Map<unknown>,slideId:string,design:SlideDesign){
    const safe=cleanDesign(design),slide=collection(root).get(slideId);
    if(!slide)throw new Error('Slide no longer exists.');
    const map=new Y.Map<unknown>(),objects=new Y.Map<Y.Map<unknown>>();
    for(const object of safe.objects)objects.set(object.id,objectMap(object));
    map.set('theme',safe.theme);map.set('objects',objects);slide.set('design',map);slide.set('layout','canvas');
}
export function presetDesign(preset:ScenePreset,title:string,body:string,theme:SceneTheme='paper'):SlideDesign{
    const objects:SceneObject[]=[];
    const add=(kind:SceneKind,patch:Partial<SceneObject>)=>objects.push({...defaults(kind,theme),id:crypto.randomUUID(),z:objects.length,...patch});
    if(preset==='blank')return{theme,objects};
    add('text',{text:title||'Presentation title',x:.07,y:.05,w:.86,h:.16,fontSize:36,align:preset==='title'?'center':'left'});
    if(preset==='title')add('text',{text:body,x:.15,y:.4,w:.7,h:.35,fontSize:28,align:'center'});
    if(preset==='body')add('text',{text:body||'Add the main points here.',x:.08,y:.27,w:.84,h:.65});
    if(preset==='caption'){add('image',{x:.1,y:.23,w:.8,h:.53});add('text',{text:body||'Image caption',x:.1,y:.8,w:.8,h:.15,fontSize:20,align:'center'});}
    if(preset==='comparison'){add('text',{text:body||'Left comparison',x:.07,y:.28,w:.4,h:.64});add('text',{text:'Right comparison',x:.53,y:.28,w:.4,h:.64});}
    if(preset==='grid')for(let i=0;i<4;i++)add('image',{x:i%2?.52:.07,y:i<2?.25:.61,w:.41,h:.31});
    if(preset==='table'||preset==='chart')add(preset,{text:preset==='table'?'Item\tValue\nFirst\t12\nSecond\t20':'First\t12\nSecond\t20',x:.08,y:.27,w:.84,h:.65,fontSize:24});
    return cleanDesign({theme,objects});
}
function writable(session:ArtifactSession){if(!session.editable||session.isClosed||!session.scope.isCurrent())throw new Error('Editing is not permitted in this workspace.');}
export function addSceneObject(session:ArtifactSession,slideId:string,kind:SceneKind):string{
    writable(session);const design=readDesign(session.data,slideId);if(!design)throw new Error('Choose a native layout first.');
    const source=collection(session.data).get(slideId)!.get('design') as Y.Map<unknown>,objects=source.get('objects') as Y.Map<Y.Map<unknown>>;
    if(objects.size>=64)throw new Error('This release supports 64 stored objects per slide, including recoverable removed objects.');
    const object:SceneObject={...defaults(kind,design.theme),id:crypto.randomUUID(),z:Math.max(0,...design.objects.map(o=>o.z))+1};
    if(kind==='image'||kind==='chart'||kind==='table')object.h=.5;
    if(kind==='table'||kind==='chart')object.text='First\t12\nSecond\t20';
    session.doc.transact(()=>objects.set(object.id,objectMap(cleanSceneObject(object))),session.origin);
    return object.id;
}
export function patchSceneObject(session:ArtifactSession,slideId:string,id:string,patch:Partial<SceneObject>){
    writable(session);const design=readDesign(session.data,slideId),before=design?.objects.find(o=>o.id===id);if(!before)throw new Error('Object was removed; the edit was not applied to another object.');
    const next=cleanSceneObject({...before,...patch,id});
    const source=collection(session.data).get(slideId)!.get('design') as Y.Map<unknown>,objects=source.get('objects') as Y.Map<Y.Map<unknown>>,map=objects.get(id)!;
    session.doc.transact(()=>{for(const key of Object.keys(patch) as (keyof SceneObject)[]){if(key==='id')continue;if(key==='text'){const text=map.get('text');if(!(text instanceof Y.Text))throw new Error('Object text is not editable.');editText(text,next.text,session.origin);}else map.set(key,next[key]);}},session.origin);
}
export function removeSceneObject(session:ArtifactSession,slideId:string,id:string){
    writable(session);const source=collection(session.data).get(slideId)?.get('design');if(!(source instanceof Y.Map))return;const objects=source.get('objects');if(!(objects instanceof Y.Map))return;
    const object=objects.get(id);if(object instanceof Y.Map)session.doc.transact(()=>object.set('removed',true),session.origin);
}
export function setSceneTheme(session:ArtifactSession,slideId:string,theme:SceneTheme){
    writable(session);if(!Object.hasOwn(scenePalette,theme))throw new Error('Unknown theme');
    const design=readDesign(session.data,slideId);if(!design)return;const source=collection(session.data).get(slideId)!.get('design') as Y.Map<unknown>,objects=source.get('objects') as Y.Map<Y.Map<unknown>>;
    session.doc.transact(()=>{source.set('theme',theme);for(const object of design.objects){const map=objects.get(object.id)!;if(object.color===scenePalette[design.theme].foreground)map.set('color',scenePalette[theme].foreground);if(object.fill===scenePalette[design.theme].accent)map.set('fill',scenePalette[theme].accent);}},session.origin);
}
