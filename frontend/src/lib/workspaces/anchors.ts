import * as Y from 'yjs';

/** Bounded references. Quotes are private review context, never part of a URL. */
export type Anchor =
    | {v:1;kind:'text';start:number[];end:number[];quote:string;length:number}
    | {v:1;kind:'range';sheetId:string;rows:string[];columns:string[];label:string}
    | {v:1;kind:'slide';slideId:string;label:string}
    | {v:1;kind:'object';slideId:string;objectId:string;label:string};
const identity=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
const bytes=(value:unknown):value is number[]=>Array.isArray(value)&&value.length>0&&value.length<=128&&value.every(n=>Number.isInteger(n)&&n>=0&&n<=255);
function ids(value:unknown):value is string[]{return Array.isArray(value)&&value.length>0&&value.length<=40&&value.every(identity)&&new Set(value).size===value.length;}
export function parseAnchor(raw:string|null|undefined):Anchor|null {
    if(!raw||raw.length>4096)return null;
    try {
        const value=JSON.parse(raw);
        if(!value||value.v!==1)return null;
        if(value.kind==='text'&&bytes(value.start)&&bytes(value.end)&&typeof value.quote==='string'&&value.quote.length<=512&&Number.isSafeInteger(value.length)&&value.length>=0&&value.length<=1048576)return{v:1,kind:'text',start:value.start,end:value.end,quote:value.quote,length:value.length};
        if(value.kind==='range'&&identity(value.sheetId)&&ids(value.rows)&&ids(value.columns)&&typeof value.label==='string'&&value.label.length<=200)return{v:1,kind:'range',sheetId:value.sheetId,rows:value.rows,columns:value.columns,label:value.label};
        if(value.kind==='object'&&identity(value.slideId)&&identity(value.objectId)&&typeof value.label==='string'&&value.label.length<=200)return{v:1,kind:'object',slideId:value.slideId,objectId:value.objectId,label:value.label};
        if(value.kind==='slide'&&identity(value.slideId)&&typeof value.label==='string'&&value.label.length<=200)return{v:1,kind:'slide',slideId:value.slideId,label:value.label};
    }catch{/* Legacy free-text anchors stay non-executable labels. */}
    return null;
}
function encode(anchor:Anchor):string {const raw=JSON.stringify(anchor);if(!parseAnchor(raw))throw new Error('The selected reference is too large. Select a smaller range.');return raw;}
export function textAnchor(text:Y.Text,from:number,to:number):string|null {
    if(!text.doc||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to>text.length)return null;
    return encode({v:1,kind:'text',start:Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text,from,0))),end:Array.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text,to,-1))),quote:text.toString().slice(from,to).slice(0,512),length:to-from});
}
export function rangeAnchor(sheetId:string,rows:string[],columns:string[],label:string):string {return encode({v:1,kind:'range',sheetId,rows,columns,label:label.slice(0,200)});}
export function objectAnchor(slideId:string,objectId:string,label:string):string{return encode({v:1,kind:'object',slideId,objectId,label:label.slice(0,200)});}
export function slideAnchor(slideId:string,label:string):string {return encode({v:1,kind:'slide',slideId,label:label.slice(0,200)});}
export function textPosition(doc:Y.Doc,raw:string):{from:number;to:number}|null {
    const anchor=parseAnchor(raw);if(anchor?.kind!=='text')return null;
    try {
        const start=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(anchor.start)),doc);
        const end=Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Uint8Array.from(anchor.end)),doc);
        const body=doc.getText('body');
        if(!start||!end||start.type!==body||end.type!==body||end.index<=start.index)return null;
        return{from:start.index,to:end.index};
    }catch{return null;}
}
export function describeAnchor(doc:Y.Doc,raw:string|null|undefined):{label:string;missing:boolean;quote?:string} {
    const anchor=parseAnchor(raw);if(!anchor)return{label:raw?'Legacy reference':'Whole document',missing:false};
    if(anchor.kind==='text')return{label:'Selected passage',missing:!textPosition(doc,raw!),quote:anchor.quote||undefined};
    const data=doc.getMap('data');
    if(anchor.kind==='slide'||anchor.kind==='object'){
        const slides=data.get('slides');const slide=slides instanceof Y.Map?slides.get(anchor.slideId):null;
        if(anchor.kind==='object'){const design=slide instanceof Y.Map?slide.get('design'):null;const objects=design instanceof Y.Map?design.get('objects'):null;const object=objects instanceof Y.Map?objects.get(anchor.objectId):null;return{label:anchor.label||'Slide object',missing:!(slide instanceof Y.Map)||!!slide.get('removed')||!(object instanceof Y.Map)||!!object.get('removed')};}
        return{label:anchor.label||'Slide',missing:!(slide instanceof Y.Map)||Boolean(slide.get('removed'))};
    }
    const sheets=data.get('sheets');const sheet=sheets instanceof Y.Map?sheets.get(anchor.sheetId):null;
    if(!(sheet instanceof Y.Map)||sheet.get('removed'))return{label:anchor.label||'Cell range',missing:true};
    const rows=sheet.get('rows'),columns=sheet.get('columns');
    const exists=(axis:unknown,id:string)=>{if(!(axis instanceof Y.Map))return false;const item=axis.get(id);return !!item&&!item.removed;};
    return{label:anchor.label||'Cell range',missing:anchor.rows.some(id=>!exists(rows,id))||anchor.columns.some(id=>!exists(columns,id))};
}
/** A copied URL may leave this channel. Do not encode quotes or private titles. */
export function linkAnchor(raw:string|null|undefined):string|undefined {
    const anchor=parseAnchor(raw);if(!anchor)return undefined;
    return encode(anchor.kind==='text'?{...anchor,quote:''}:{...anchor,label:''});
}
