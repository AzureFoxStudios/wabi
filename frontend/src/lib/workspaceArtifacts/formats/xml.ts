/** A deliberately constrained XML reader for Office containers. No DTDs, entities,
 * external resources, script execution, or browser DOM is available to this parser.
 * This module is worker-safe and fails rather than repairing malformed documents.
 */
export interface XNode {name:string;attrs:Record<string,string>;children:(XNode|string)[]}
const NAME=/^[A-Za-z_][A-Za-z0-9_.:-]*/;
function entities(text:string):string{
  if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);)/i.test(text)) throw new Error('Invalid XML entity');
  return text.replace(/&([^;\s]+);/g,(_,entity:string)=>{
    const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(named,entity))return named[entity];
    if(/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)){const value=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));if((value===9||value===10||value===13||value>=32)&&value<=0x10ffff&&!(value>=0xd800&&value<=0xdfff))return String.fromCodePoint(value);}
    throw new Error('Unsupported XML entity');
  });
}
export function xml(source:string):XNode{
  if(source.length>16*1024*1024)throw new Error('XML part exceeds 16 MiB');
  if(/<!\s*(?:DOCTYPE|ENTITY)/i.test(source))throw new Error('DTD and entity declarations are not permitted');
  const root:XNode={name:'#document',attrs:Object.create(null),children:[]},stack=[root];let i=0,nodes=0;
  while(i<source.length){
    if(source[i]!=='<'){const end=source.indexOf('<',i),to=end<0?source.length:end;stack.at(-1)!.children.push(entities(source.slice(i,to)));i=to;continue;}
    if(source.startsWith('<!--',i)){const end=source.indexOf('-->',i+4);if(end<0)throw new Error('Unterminated XML comment');i=end+3;continue;}
    if(source.startsWith('<![CDATA[',i)){const end=source.indexOf(']]>',i+9);if(end<0)throw new Error('Unterminated CDATA');stack.at(-1)!.children.push(source.slice(i+9,end));i=end+3;continue;}
    if(source.startsWith('<?',i)){const end=source.indexOf('?>',i+2);if(end<0)throw new Error('Unterminated XML instruction');i=end+2;continue;}
    if(source.startsWith('</',i)){const end=source.indexOf('>',i+2);if(end<0||stack.length===1||source.slice(i+2,end).trim()!==stack.at(-1)!.name)throw new Error('Mismatched XML closing tag');stack.pop();i=end+1;continue;}
    i++;const name=source.slice(i).match(NAME)?.[0];if(!name)throw new Error('Unsupported XML element');i+=name.length;
    const node:XNode={name,attrs:Object.create(null),children:[]};let selfClosing=false;
    for(;;){
      while(/\s/.test(source[i]||'')&&i<source.length)i++;
      if(source.startsWith('/>',i)){i+=2;selfClosing=true;break;}if(source[i]==='>'){i++;break;}
      const attr=source.slice(i).match(NAME)?.[0];if(!attr)throw new Error('Invalid XML attribute');i+=attr.length;while(/\s/.test(source[i]||'')&&i<source.length)i++;if(source[i++]!=='=')throw new Error('Invalid XML attribute assignment');while(/\s/.test(source[i]||'')&&i<source.length)i++;
      const quote=source[i++];if(quote!=='"'&&quote!=="'")throw new Error('Unquoted XML attribute');const end=source.indexOf(quote,i);if(end<0||source.slice(i,end).includes('<')||Object.hasOwn(node.attrs,attr))throw new Error('Invalid or duplicate XML attribute');node.attrs[attr]=entities(source.slice(i,end));i=end+1;
    }
    if(++nodes>750000||stack.length>64)throw new Error('XML structure exceeds its limit');stack.at(-1)!.children.push(node);if(!selfClosing)stack.push(node);
  }
  const elements=root.children.filter((v):v is XNode=>typeof v!=='string');if(stack.length!==1||elements.length!==1||root.children.some(v=>typeof v==='string'&&v.trim()))throw new Error('Incomplete XML document');return elements[0];
}
export const local=(name:string)=>name.slice(name.lastIndexOf(':')+1);
export function children(node:XNode,name?:string):XNode[]{return node.children.filter((x):x is XNode=>typeof x!=='string'&&(!name||local(x.name)===name));}
export function all(node:XNode,name:string):XNode[]{const out:XNode[]=[],pending=[node];while(pending.length){const n=pending.pop()!;if(local(n.name)===name)out.push(n);const next=children(n);for(let i=next.length-1;i>=0;i--)pending.push(next[i]);}return out;}
export const first=(node:XNode,name:string):XNode|undefined=>all(node,name)[0];
export function text(node:XNode|undefined):string{if(!node)return '';return node.children.map(c=>typeof c==='string'?c:local(c.name)==='s'?' '.repeat(Math.min(1000,Math.max(1,Number(c.attrs['text:c'])||1))):local(c.name)==='tab'?'\t':local(c.name)==='line-break'?'\n':text(c)).join('');}
export function escape(value:unknown):string{return String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
export function partPath(base:string,target:string):string{
  let input:string;try{input=decodeURIComponent(target);}catch{throw new Error('Invalid part URI');}
  if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)||input.includes('\\')||input.includes('\0')||input.includes('?')||input.includes('#'))throw new Error('External or invalid Office part reference');
  const segments=input.startsWith('/')?[]:base.split('/').slice(0,-1);for(const s of input.split('/')){if(!s||s==='.')continue;if(s==='..'){if(!segments.length)throw new Error('Office part escapes its container');segments.pop();}else segments.push(s);}return segments.join('/');
}
