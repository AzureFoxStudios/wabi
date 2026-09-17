import {createCalculator} from './formula';
import type {Fields} from '../../workspaceArtifacts/model';
let fields:Fields={};
self.onmessage=(event:MessageEvent<{revision:number;fields?:Fields;set?:Fields;remove?:string[];cells:{key:string;sheet:string;row:string;col:string}[]}>)=>{
  const input=event.data;
  try{
    if(input.fields)fields=input.fields;
    if(input.set)Object.assign(fields,input.set);input.remove?.forEach(k=>delete fields[k]);
    const calculator=createCalculator(fields),values:Record<string,unknown>=Object.create(null);
    if(input.cells.length>15000)throw new Error('Calculation view exceeds 15,000 requested cells');
    for(const c of input.cells)values[c.key]=calculator.cell(c.sheet,c.row,c.col);
    postMessage({revision:input.revision,values});
  }catch(error){postMessage({revision:input.revision,error:error instanceof Error?error.message:String(error)});}
};
