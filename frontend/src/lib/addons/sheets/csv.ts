/** Quoted fields, embedded newlines and UTF-8 are retained. No implicit date conversion. */
export function parseDelimited(text:string,delimiter:string):string[][]{
  if(![',','\t',';'].includes(delimiter))throw new Error('Unsupported delimiter');
  if(text.length>32*1024*1024)throw new Error('Delimited file exceeds 32 MiB');
  text=text.replace(/^\uFEFF/,'');const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;}
    else if(c==='"'&&!field&&!closed)quoted=true;
    else if(c===delimiter){row.push(field);field='';closed=false;}
    else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';closed=false;}
    else{if(closed)throw new Error('Unexpected text after a quoted CSV field');field+=c;}
    if(field.length>65536||row.length>256||rows.length>100000)throw new Error('File exceeds the supported grid/cell limit');
  }
  if(quoted)throw new Error('Unterminated quoted CSV field');
  if(field||row.length||closed){row.push(field);rows.push(row);}
  return rows;
}
export function quoteField(value:string,delimiter=','):string{return value.includes('"')||value.includes(delimiter)||/[\r\n]/.test(value)?`"${value.replace(/"/g,'""')}"`:value;}
export function writeDelimited(rows:string[][],delimiter=',',safeText=false):string{
  return rows.map(row=>row.map(value=>{if(safeText&&/^\s*[=+@-]/.test(value)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(value))value="'"+value;return quoteField(value,delimiter);}).join(delimiter)).join('\r\n');
}
