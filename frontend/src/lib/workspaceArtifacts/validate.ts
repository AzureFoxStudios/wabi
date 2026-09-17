import {safeKey,type ArtifactKind,type Fields} from './model';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(message:string):never { throw new Error('Invalid native content: '+message); }
/** Structural validation only: this deliberately imports no editor, calculator,
 * PDF parser, or Office adapter into the library/shared service boundary. */
export function validateNativeFields(kind:ArtifactKind,value:unknown):asserts value is Fields{
  let count=0;
  function json(v:unknown,depth=0):void{
    if(++count>2_000_000||depth>64)fail('structure exceeds limits');
    if(v===null||typeof v==='boolean'||typeof v==='string')return;
    if(typeof v==='number'){if(!Number.isFinite(v))fail('non-finite number');return;}
    if(Array.isArray(v)){for(const item of v)json(item,depth+1);return;}
    if(object(v)){for(const [k,item] of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k))fail('unsafe object key');json(item,depth+1);}return;}
    fail('not JSON data');
  }
  json(value);if(!object(value)||Object.keys(value).length>250000||!Object.keys(value).every(safeKey)||typeof value.title!=='string'||value.title.length>512)fail('invalid fields or title');
  if(new TextEncoder().encode(JSON.stringify(value)).length>32*1024*1024)fail('document exceeds 32 MiB');
  if(kind==='document'){
    if(typeof value.text!=='string'||!['text','markdown','html','code'].includes(String(value.format))||Object.keys(value).some(k=>!['title','text','format','language'].includes(k)))fail('invalid document schema');return;
  }
  if(kind==='deck'){
    if(!Array.isArray(value.slides)||!value.slides.length||value.slides.length>300||!value.slides.every(id)||new Set(value.slides).size!==value.slides.length)fail('invalid slide identities');
    if(value.aspect!==undefined&&(typeof value.aspect!=='number'||value.aspect<.5||value.aspect>3))fail('invalid slide aspect');
    if(value.theme!==undefined&&!['paper','night','sage'].includes(String(value.theme)))fail('invalid theme');
    for(const sid of value.slides){const s=value['slide:'+sid];if(!object(s)||typeof s.title!=='string'||typeof s.body!=='string'||s.body.length>50000||s.title.length>512||!['title','body','image','split'].includes(String(s.layout)))fail('invalid slide');if(s.image!=null&&(typeof s.image!=='string'||s.image.length>4*1024*1024||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(s.image)))fail('unsafe slide image');if(Object.keys(s).some(k=>!['title','body','image','layout','hidden'].includes(k)))fail('unexpected slide property');}
    if(Object.keys(value).some(k=>!['title','slides','theme','aspect'].includes(k)&&!k.startsWith('slide:')))fail('unexpected deck field');return;
  }
  if(kind!=='sheet')fail('unknown content kind');
  if(!Array.isArray(value.sheets)||!value.sheets.length||value.sheets.length>100||!value.sheets.every(id)||new Set(value.sheets).size!==value.sheets.length)fail('invalid sheet identities');
  const sheets=new Map<string,{rows:Set<string>;columns:Set<string>}>(),names=new Set<string>();
  for(const sid of value.sheets){const s=value['s:'+sid];if(!object(s)||typeof s.name!=='string'||!s.name||s.name.length>200||!Array.isArray(s.rows)||!Array.isArray(s.columns)||!s.rows.length||s.rows.length>100000||!s.columns.length||s.columns.length>256||!s.rows.every(id)||!s.columns.every(id)||new Set(s.rows).size!==s.rows.length||new Set(s.columns).size!==s.columns.length)fail('invalid grid dimensions or identities');if(names.has(s.name.toLowerCase()))fail('duplicate sheet name');names.add(s.name.toLowerCase());sheets.set(sid,{rows:new Set(s.rows),columns:new Set(s.columns)});}
  function expr(v:unknown,depth=0):void{
    if(depth>64||!object(v))fail('invalid formula tree');
    if(v.type==='value'){if(!['string','number','boolean'].includes(typeof v.value))fail('invalid formula scalar');}
    else if(v.type==='ref')ref(v.ref);
    else if(v.type==='range'){ref(v.from);ref(v.to);}
    else if(v.type==='unary'){if(!['+','-','%'].includes(String(v.op)))fail('invalid unary operator');expr(v.right,depth+1);}
    else if(v.type==='binary'){if(!['+','-','*','/','^','&','=','<>','<','>','<=','>='].includes(String(v.op)))fail('invalid binary operator');expr(v.left,depth+1);expr(v.right,depth+1);}
    else if(v.type==='call'){if(typeof v.name!=='string'||!['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','IF','AND','OR','ROUND','COUNTIF','SUMIF'].includes(v.name)||!Array.isArray(v.args)||v.args.length>2048)fail('invalid formula function');for(const arg of v.args)expr(arg,depth+1);}
    else fail('unknown formula node');
  }
  function ref(v:unknown){if(!object(v)||!id(v.sheet)||typeof v.row!=='string'||typeof v.col!=='string'||typeof v.absRow!=='boolean'||typeof v.absCol!=='boolean')fail('invalid formula reference');}
  for(const [k,v] of Object.entries(value)){
    if(['title','sheets','dateSystem'].includes(k)||k.startsWith('s:'))continue;
    if(k.startsWith('chart:')){if(!object(v)||!['bar','line','pie'].includes(String(v.type))||typeof v.title!=='string'||!sheets.has(String(v.sheet))||!Array.isArray(v.rows)||!Array.isArray(v.columns))fail('invalid chart');continue;}
    if(!k.startsWith('c:')&&!k.startsWith('f:'))fail('unexpected sheet field');
    const parts=k.split(':'),s=sheets.get(parts[1]);if(parts.length!==4||!s?.rows.has(parts[2])||!s.columns.has(parts[3])||!object(v))fail('cell targets a missing row or column');
    if(k.startsWith('c:')){if(typeof v.raw!=='string'||v.raw.length>65536||Object.keys(v).some(n=>!['raw','ast','unsupported','cached'].includes(n)))fail('invalid cell');if(v.ast!==undefined)expr(v.ast);}
  }
}
