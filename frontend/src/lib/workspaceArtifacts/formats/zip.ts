/** Bounded ZIP reader/writer for explicitly selected Office files. Stored exports
 * are interoperable ZIPs; imports permit only stored or raw-deflate entries.
 */
const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c;}
export function crc32(bytes:Uint8Array):number{let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export interface ZipEntry {name:string;size:number;read:()=>Promise<Uint8Array>}
export async function readZip(buffer:ArrayBuffer):Promise<Map<string,ZipEntry>>{
  if(buffer.byteLength>32*1024*1024)throw new Error('Office input exceeds 32 MiB');
  const view=new DataView(buffer),bytes=new Uint8Array(buffer);let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}
  if(end<0)throw new Error('Not a complete ZIP container');
  const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),offset=view.getUint32(end+16,true);
  if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||count>4000||count===65535||offset+size>end)throw new Error('Multi-disk, ZIP64, or oversized containers are unsupported');
  const entries=new Map<string,ZipEntry>();let p=offset,total=0;
  for(let n=0;n<count;n++){
    if(p+46>end||view.getUint32(p,true)!==0x02014b50)throw new Error('Invalid ZIP directory');
    const flags=view.getUint16(p+8,true),method=view.getUint16(p+10,true),crc=view.getUint32(p+16,true),packed=view.getUint32(p+20,true),unpacked=view.getUint32(p+24,true),nameLength=view.getUint16(p+28,true),extraLength=view.getUint16(p+30,true),commentLength=view.getUint16(p+32,true),at=view.getUint32(p+42,true);
    if(p+46+nameLength+extraLength+commentLength>offset+size)throw new Error('Truncated ZIP directory');
    const name=new TextDecoder(flags&0x800?'utf-8':'windows-1252',{fatal:true}).decode(bytes.subarray(p+46,p+46+nameLength));
    if(name.startsWith('/')||name.includes('\\')||name.includes('\0')||name.split('/').some(s=>s==='..')||entries.has(name))throw new Error('Unsafe or duplicate ZIP path');
    if((flags&1)||![0,8].includes(method)||unpacked>32*1024*1024||(packed&&unpacked>packed*400)||at+30>offset)throw new Error('Encrypted, unsupported, or excessive ZIP entry');
    total+=unpacked;if(total>96*1024*1024)throw new Error('Expanded Office file exceeds 96 MiB');
    const localFlags=view.getUint16(at+6,true),localMethod=view.getUint16(at+8,true),localName=view.getUint16(at+26,true),localExtra=view.getUint16(at+28,true),start=at+30+localName+localExtra;
    if(view.getUint32(at,true)!==0x04034b50||localMethod!==method||localFlags!==flags||start+packed>offset||localName!==nameLength||bytes.subarray(at+30,at+30+localName).some((byte,index)=>byte!==bytes[p+46+index]))throw new Error('ZIP entry headers disagree');
    let cached:Promise<Uint8Array>|undefined;
    entries.set(name,{name,size:unpacked,read:()=>cached??=(async()=>{
      const source=bytes.slice(start,start+packed);let result:Uint8Array;
      if(method===0){if(packed!==unpacked)throw new Error('Invalid stored ZIP size');result=source;}
      else{
        let stream:DecompressionStream;try{stream=new DecompressionStream('deflate-raw');}catch{throw new Error('This browser cannot decompress Office files. Download the original or use a supported desktop/browser build.');}
        const reader=new Blob([source]).stream().pipeThrough(stream).getReader(),chunks:Uint8Array[]=[];let length=0;
        try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>unpacked||length>32*1024*1024)throw new Error('ZIP expansion exceeded its declared size');chunks.push(next.value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
        result=new Uint8Array(length);let pos=0;for(const chunk of chunks){result.set(chunk,pos);pos+=chunk.length;}
      }
      if(result.length!==unpacked||crc32(result)!==crc)throw new Error('ZIP data failed size or CRC validation');return result;
    })()});p+=46+nameLength+extraLength+commentLength;
  }
  return entries;
}
export async function zipText(zip:Map<string,ZipEntry>,name:string):Promise<string>{const part=zip.get(name);if(!part)throw new Error('Office file is missing '+name);const bytes=await part.read();if(bytes.length>=2&&bytes[0]===255&&bytes[1]===254)return new TextDecoder('utf-16le',{fatal:true}).decode(bytes);if(bytes.length>=2&&bytes[0]===254&&bytes[1]===255)return new TextDecoder('utf-16be',{fatal:true}).decode(bytes);return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
export function writeZip(parts:Record<string,string|Uint8Array>):Uint8Array{
  const items=Object.entries(parts);if(items.length>4000)throw new Error('Too many export parts');const enc=new TextEncoder(),locals:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
  for(const [path,data] of items){if(!path||path.startsWith('/')||path.includes('\\')||path.includes('\0')||path.split('/').some(s=>s==='..'))throw new Error('Unsafe ZIP export path');const name=enc.encode(path),body=typeof data==='string'?enc.encode(data):data;if(name.length>65535||body.length>96*1024*1024)throw new Error('Export part exceeds limit');const crc=crc32(body),head=new Uint8Array(30+name.length),v=new DataView(head.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);v.setUint32(14,crc,true);v.setUint32(18,body.length,true);v.setUint32(22,body.length,true);v.setUint16(26,name.length,true);head.set(name,30);locals.push(head,body);
    const directory=new Uint8Array(46+name.length),d=new DataView(directory.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,crc,true);d.setUint32(20,body.length,true);d.setUint32(24,body.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);directory.set(name,46);central.push(directory);offset+=head.length+body.length;
  }
  const directorySize=central.reduce((n,c)=>n+c.length,0),tail=new Uint8Array(22),v=new DataView(tail.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,items.length,true);v.setUint16(10,items.length,true);v.setUint32(12,directorySize,true);v.setUint32(16,offset,true);const size=offset+directorySize+22;if(size>128*1024*1024)throw new Error('Export exceeds 128 MiB');const result=new Uint8Array(size);let position=0;for(const part of [...locals,...central,tail]){result.set(part,position);position+=part.length;}return result;
}
