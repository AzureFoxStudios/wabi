import type {Fields} from '../../workspaceArtifacts/model';
import {getSheet,getCell,resolveRef,type Expr,type Cell,type Ref} from './model';
type Scalar=number|string|boolean|null;
type Value=Scalar|Scalar[];
const FUNCTIONS=new Set(['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','IF','AND','OR','ROUND','COUNTIF','SUMIF']);
export const SUPPORTED_FUNCTIONS=[...FUNCTIONS];
class CalcError extends Error {}
const fail=(s:string):never=>{throw new CalcError(s);};
const numeric=(v:Scalar):number=>{
  if(v===null || v==='') return 0;
  if(typeof v==='number') return v;
  if(typeof v==='boolean') return Number(v);
  if(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(v)) return Number(v);
  return fail('#VALUE!');
};
export function parseFormula(f:Fields,sid:string,text:string):Expr {
  if(text.length>8192) throw new Error('Formula exceeds 8,192 characters');
  const input=text.startsWith('=')?text.slice(1):text; let pos=0,depth=0,count=0;
  type Tok={kind:string;value:string}; let token:Tok={kind:'',value:''};
  function next():void {
    while(/\s/.test(input[pos]||'') && pos<input.length)pos++;
    const rest=input.slice(pos); if(!rest){token={kind:'end',value:''};return;}
    let m:RegExpMatchArray|null;
    if((m=rest.match(/^"(?:[^"]|"")*"/))){token={kind:'string',value:m[0].slice(1,-1).replace(/""/g,'"')};pos+=m[0].length;return;}
    if((m=rest.match(/^(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_ ]*)!)?\$?[A-Za-z]+\$?[1-9][0-9]*(?![A-Za-z0-9_])/))){token={kind:'ref',value:m[0]};pos+=m[0].length;return;}
    if((m=rest.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/))){token={kind:'number',value:m[0]};pos+=m[0].length;return;}
    if((m=rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/))){token={kind:'name',value:m[0].toUpperCase()};pos+=m[0].length;return;}
    if((m=rest.match(/^(?:<=|>=|<>|[+\-*/^&=<>():,%])/))){token={kind:m[0],value:m[0]};pos+=m[0].length;return;}
    throw new Error(`Unsupported formula token at ${pos+1}`);
  }
  function take(k:string){if(token.kind!==k)throw new Error(`Expected ${k}`);next();}
  function atom():Expr{
    if(++count>2048 || ++depth>64)throw new Error('Formula is too complex');
    const t=token; let out:Expr;
    if(t.kind==='+'||t.kind==='-'){next();out={type:'unary',op:t.kind,right:expression(6)};}
    else if(t.kind==='number'){next();const n=Number(t.value);if(!Number.isFinite(n))throw new Error('Invalid number');out={type:'value',value:n};}
    else if(t.kind==='string'){next();out={type:'value',value:t.value};}
    else if(t.kind==='ref'){
      next();const from=resolveRef(f,sid,t.value);
      if(token.kind===':'){next();const to=resolveRef(f,from.sheet,token.value);take('ref');if(to.sheet!==from.sheet)throw new Error('3D ranges are unsupported');out={type:'range',from,to};}
      else out={type:'ref',ref:from};
    }else if(t.kind==='('){next();out=expression(0);take(')');}
    else if(t.kind==='name'){
      next();if(t.value==='TRUE'||t.value==='FALSE')out={type:'value',value:t.value==='TRUE'};
      else {if(!FUNCTIONS.has(t.value))throw new Error(`Unsupported function: ${t.value}`);take('(');const args:Expr[]=[];if(token.kind!==')'){do{args.push(expression(0));if(token.kind!==',')break;next();}while(true);}take(')');out={type:'call',name:t.value,args};}
    }else throw new Error('Invalid formula');
    while(token.kind==='%'){next();out={type:'unary',op:'%',right:out};}
    depth--;return out;
  }
  const precedence:Record<string,number>={'=':1,'<>':1,'<':1,'>':1,'<=':1,'>=':1,'&':2,'+':3,'-':3,'*':4,'/':4,'^':5};
  function expression(min:number):Expr{
    let left=atom();while((precedence[token.kind]||0)>min){const op=token.kind,p=precedence[op];next();left={type:'binary',op,left,right:expression(op==='^'?p-1:p)};if(++count>2048)throw new Error('Formula is too complex');}return left;
  }
  next();const ast=expression(0);take('end');return ast;
}
export function makeCell(f:Fields,sid:string,raw:string):Cell {
  if(raw.length>65536)throw new Error('Cell exceeds 65,536 characters');
  if(!raw.startsWith('='))return {raw};
  try{return {raw,ast:parseFormula(f,sid,raw)};}catch{return {raw,unsupported:true};}
}
export function literal(raw:string):Scalar {
  if(raw==='')return null;
  if(raw.startsWith("'"))return raw.slice(1);
  if(raw==='TRUE'||raw==='FALSE')return raw==='TRUE';
  // Leading-zero identifiers and ambiguous dates remain text.
  if(/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)&&Number.isFinite(Number(raw)))return Number(raw);
  return raw;
}
export function createCalculator(f:Fields):{cell:(s:string,r:string,c:string)=>Scalar; result:(s:string,r:string,c:string)=>{value:Scalar;error?:string}} {
  const cache=new Map<string,Scalar>(),active=new Set<string>();let budget=100_000;
  const scalar=(v:Value):Scalar=>Array.isArray(v)?fail('#VALUE!'):v;
  const check=(r:Ref)=>{const s=getSheet(f,r.sheet);if(!s.rows.includes(r.row)||!s.columns.includes(r.col))fail('#REF!');};
  function cell(s:string,r:string,c:string):Scalar {
    const key=`${s}:${r}:${c}`;if(cache.has(key))return cache.get(key)!;
    if(active.has(key))return fail('#CYCLE!');if(--budget<0)return fail('#LIMIT!');
    const value=getCell(f,s,r,c);if(value.unsupported)return fail('#UNSUPPORTED!');
    if(!value.ast)return literal(value.raw);
    active.add(key);let result:Scalar;try{result=scalar(evaluate(value.ast));if(typeof result==='number'&&!Number.isFinite(result))fail('#NUM!');}finally{active.delete(key);}
    cache.set(key,result);return result;
  }
  function ref(r:Ref):Scalar {check(r);return cell(r.sheet,r.row,r.col);}
  function evaluate(e:Expr):Value {
    if(--budget<0)fail('#LIMIT!');
    if(e.type==='value')return e.value;
    if(e.type==='ref')return ref(e.ref);
    if(e.type==='range'){
      check(e.from);check(e.to);const s=getSheet(f,e.from.sheet),out:Scalar[]=[];
      const r1=s.rows.indexOf(e.from.row),r2=s.rows.indexOf(e.to.row),c1=s.columns.indexOf(e.from.col),c2=s.columns.indexOf(e.to.col);
      if((Math.abs(r1-r2)+1)*(Math.abs(c1-c2)+1)>100_000)fail('#LIMIT!');
      for(let r=Math.min(r1,r2);r<=Math.max(r1,r2);r++)for(let c=Math.min(c1,c2);c<=Math.max(c1,c2);c++)out.push(ref({...e.from,row:s.rows[r],col:s.columns[c]}));return out;
    }
    if(e.type==='unary'){const v=numeric(scalar(evaluate(e.right)));return e.op==='-'?-v:e.op==='%'?v/100:v;}
    if(e.type==='binary'){
      const l=scalar(evaluate(e.left)),r=scalar(evaluate(e.right));
      if(e.op==='&')return `${l??''}${r??''}`;
      if(['=','<>','<','>','<=','>='].includes(e.op)){
        const ll=typeof l==='string'?l.toLowerCase():l??0,rr=typeof r==='string'?r.toLowerCase():r??0;
        const cmp=ll===rr?0:typeof ll===typeof rr?(ll<rr?-1:1):typeof ll==='number'?-1:typeof rr==='number'?1:String(ll)<String(rr)?-1:1;
        return e.op==='='?cmp===0:e.op==='<>'?cmp!==0:e.op==='<'?cmp<0:e.op==='>'?cmp>0:e.op==='<='?cmp<=0:cmp>=0;
      }
      const a=numeric(l),b=numeric(r);switch(e.op){case '+':return a+b;case '-':return a-b;case '*':return a*b;case '/':return b===0?fail('#DIV/0!'):a/b;case '^':return a**b;default:return fail('#VALUE!');}
    }
    const {name,args}=e;
    if(name==='IF'){if(args.length<2||args.length>3)fail('#VALUE!');return numeric(scalar(evaluate(args[0])))?evaluate(args[1]):args[2]?evaluate(args[2]):false;}
    const values=args.map(evaluate),flat=values.flat();
    if(name==='COUNT')return flat.filter(x=>typeof x==='number').length;
    if(name==='COUNTA')return flat.filter(x=>x!==null).length;
    if(name==='AND'||name==='OR'){if(!flat.length)fail('#VALUE!');const bool=flat.map(numeric).map(Boolean);return name==='AND'?bool.every(Boolean):bool.some(Boolean);}
    if(name==='ROUND'){if(values.length!==2)fail('#VALUE!');const n=numeric(scalar(values[0])),digits=numeric(scalar(values[1]));if(!Number.isInteger(digits)||Math.abs(digits)>15)fail('#NUM!');const m=10**digits;return Math.sign(n)*Math.round(Math.abs(n)*m+Number.EPSILON)/m;}
    if(name==='COUNTIF'||name==='SUMIF'){
      if(values.length<2||values.length>(name==='SUMIF'?3:2))fail('#VALUE!');
      const range=Array.isArray(values[0])?values[0]:[values[0]],criterion=scalar(values[1]),sum=values[2]===undefined?range:Array.isArray(values[2])?values[2]:[values[2]];
      if(sum.length!==range.length)fail('#VALUE!');let result=0;
      for(let i=0;i<range.length;i++)if(matchesCriterion(range[i],criterion)){if(name==='COUNTIF')result++;else if(typeof sum[i]==='number')result+=sum[i] as number;}return result;
    }
    if(!['SUM','AVERAGE','MIN','MAX'].includes(name))return fail('#UNSUPPORTED!');
    // In a range text/booleans are ignored; scalar arguments use numeric coercion.
    const numbers=values.flatMap(v=>Array.isArray(v)?v.filter((x):x is number=>typeof x==='number'):[numeric(v)]);
    if(name==='SUM')return numbers.reduce((a,b)=>a+b,0);
    if(name==='AVERAGE')return numbers.length?numbers.reduce((a,b)=>a+b,0)/numbers.length:fail('#DIV/0!');
    return !numbers.length?0:name==='MIN'?numbers.reduce((a,b)=>Math.min(a,b)):numbers.reduce((a,b)=>Math.max(a,b));
  }
  const result=(s:string,r:string,c:string):{value:Scalar;error?:string}=>{budget=100_000;try{return {value:cell(s,r,c)};}catch(e){return {value:null,error:e instanceof CalcError?e.message:'#VALUE!'};}};
  return {result,cell:(s,r,c)=>{const evaluated=result(s,r,c);return evaluated.error??evaluated.value;}};
}
function matchesCriterion(value:Scalar,criterion:Scalar):boolean {
  if(typeof criterion!=='string')return value===criterion;
  const match=criterion.match(/^(<=|>=|<>|=|<|>)(.*)$/),op=match?.[1]||'=',target=match?.[2]??criterion;
  if(/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(target)){
    let n:number;try{n=numeric(value);}catch{return op==='<>';}
    const t=Number(target);return op==='='?n===t:op==='<>'?n!==t:op==='<'?n<t:op==='>'?n>t:op==='<='?n<=t:n>=t;
  }
  const a=String(value??'').toLowerCase(),b=target.toLowerCase();
  if(op!=='='&&op!=='<>')return op==='<'?a<b:op==='>'?a>b:op==='<='?a<=b:a>=b;
  let pattern='';for(let i=0;i<b.length;i++){let c=b[i];if(c==='~'&&i+1<b.length){c=b[++i];pattern+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}else pattern+=c==='*'?'.*':c==='?'?'.':c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
  const matched=new RegExp(`^${pattern}$`,'u').test(a);return op==='='?matched:!matched;
}
