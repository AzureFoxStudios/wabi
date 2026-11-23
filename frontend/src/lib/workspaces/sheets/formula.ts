import {ARITY,MAX_TEXT,dateDif,dateToSerial,formatText,hasWildcard,parseIsoDate,parseNumberText,serialToDate,shiftMonths,weekday,wildcardFind,wildcardMatch} from './formulaFunctions';
/** A deliberately bounded calculation contract. Unsupported expressions stay errors, never zero. */
export type Scalar=string|number|boolean|null;
export interface Ref {type:'ref';sheet:string;row:string;column:string;absoluteRow:boolean;absoluteColumn:boolean;}
export type Expr={type:'value';value:Scalar}|Ref|{type:'range';from:Ref;to:Ref}|{type:'unary';op:string;value:Expr}|{type:'binary';op:string;left:Expr;right:Expr}|{type:'call';name:string;args:Expr[]};
export interface Axis {id:string;position:number;removed?:boolean;}
export interface CellVersion {id:string;cell:string;input:string;parents:string[];expression?:Expr;parseError?:string;literal?:Scalar;cached?:Scalar;imported?:boolean;}
export interface SheetSnapshot {id:string;name:string;rows:Axis[];columns:Axis[];cells:Record<string,CellVersion[]>;}
export interface WorkbookSnapshot {sheets:SheetSnapshot[];}
export class FormulaError extends Error{constructor(readonly code:string){super(code);}}
export const cellKey=(row:string,column:string)=>`${row}|${column}`;
export function columnName(index:number){let value=index+1,result='';while(value>0){value--;result=String.fromCharCode(65+value%26)+result;value=Math.floor(value/26);}return result;}
export function columnIndex(name:string){let value=0;for(const c of name.toUpperCase())value=value*26+c.charCodeAt(0)-64;return value-1;}
export function heads(versions:CellVersion[]){const superseded=new Set(versions.flatMap(v=>v.parents));return versions.filter(v=>!superseded.has(v.id)).sort((a,b)=>a.id.localeCompare(b.id));}
/** Every function the calculator knows. The autocomplete catalog is tested against this set. */
const LEGACY=['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','IF','AND','OR','ROUND','COUNTIF','SUMIF','ABS','NOT','CONCAT'];
export const FORMULA_FUNCTIONS=new Set([...LEGACY,...Object.keys(ARITY)]);
const LEGACY_SET=new Set(LEGACY);
/** Rows and columns of a range result. The result stays a flat row-major array, so older code is unaffected. */
const shapes=new WeakMap<Scalar[],{rows:number;cols:number}>();
const EXCEL_ERRORS=new Set(['#VALUE!','#DIV/0!','#N/A','#NUM!','#NAME?','#REF!','#NULL!']);
interface Grid {rows:number;cols:number;cells:Scalar[];}
const functions=FORMULA_FUNCTIONS;
interface Token{kind:string;text:string;}
function tokenize(input:string):Token[]{const result:Token[]=[];let at=0;while(at<input.length){const rest=input.slice(at);const space=/^\s+/.exec(rest);if(space){at+=space[0].length;continue;}let m:RegExpExecArray|null;
    if((m=/^"(?:[^"]|"")*"/.exec(rest)))result.push({kind:'string',text:m[0]});
    else if((m=/^(?:'(?:[^']|'')+'!|[A-Za-z_][A-Za-z0-9_ ]*!|)\$?[A-Za-z]{1,4}\$?[1-9]\d*/.exec(rest))&&!/^[A-Za-z0-9_]/.test(rest.slice(m[0].length)))result.push({kind:'ref',text:m[0]});
    else if((m=/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)))result.push({kind:'number',text:m[0]});
    else if((m=/^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest)))result.push({kind:'name',text:m[0].toUpperCase()});
    else if((m=/^(?:<>|<=|>=|[+\-*/^&=<>(),:%])/.exec(rest)))result.push({kind:m[0],text:m[0]});
    else throw new FormulaError('#UNSUPPORTED!');at+=m![0].length;if(result.length>512)throw new FormulaError('#LIMIT!');
}return result;}
export function parseFormula(input:string,book:WorkbookSnapshot,sheetId:string):Expr{
    if(input.length>8192)throw new FormulaError('#LIMIT!');const tokens=tokenize(input.slice(1));let at=0,depth=0;
    const peek=()=>tokens[at]?.kind;const take=(kind?:string)=>{const token=tokens[at++];if(!token||(kind&&token.kind!==kind))throw new FormulaError('#PARSE!');return token;};
    function reference(text:string,defaultSheet=sheetId):Ref{const split=text.lastIndexOf('!');let id=defaultSheet,address=text;if(split>=0){let name=text.slice(0,split);if(name.startsWith("'"))name=name.slice(1,-1).replaceAll("''","'");const matches=book.sheets.filter(s=>s.name.toLowerCase()===name.toLowerCase());if(matches.length!==1)throw new FormulaError('#REF!');id=matches[0].id;address=text.slice(split+1);}const m=/^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(address);const sheet=book.sheets.find(s=>s.id===id);if(!m||!sheet)throw new FormulaError('#REF!');const row=sheet.rows[Number(m[4])-1],column=sheet.columns[columnIndex(m[2])];if(!row||!column)throw new FormulaError('#REF!');return{type:'ref',sheet:id,row:row.id,column:column.id,absoluteRow:!!m[3],absoluteColumn:!!m[1]};}
    const precedence:Record<string,number>={'=':1,'<>':1,'<':1,'>':1,'<=':1,'>=':1,'&':2,'+':3,'-':3,'*':4,'/':4,'^':5};
    function expression(min=0):Expr{if(++depth>48)throw new FormulaError('#LIMIT!');let left:Expr;const token=take();
        if(token.kind==='+'||token.kind==='-')left={type:'unary',op:token.kind,value:expression(5)};
        else if(token.kind==='('){left=expression();take(')');}
        else if(token.kind==='number')left={type:'value',value:Number(token.text)};
        else if(token.kind==='string')left={type:'value',value:token.text.slice(1,-1).replaceAll('""','"')};
        else if(token.kind==='ref'){const from=reference(token.text);if(peek()===':'){take(':');left={type:'range',from,to:reference(take('ref').text,from.sheet)};}else left=from;}
        else if(token.kind==='name'&&['TRUE','FALSE'].includes(token.text)&&peek()!=='(')left={type:'value',value:token.text==='TRUE'};
        else if(token.kind==='name'&&functions.has(token.text)){take('(');const args:Expr[]=[];if(peek()!==')'){do{args.push(expression());if(peek()!==',')break;take(',');}while(args.length<128);}take(')');left={type:'call',name:token.text,args};}
        else throw new FormulaError('#UNSUPPORTED!');
        while(peek()==='%'){take('%');left={type:'binary',op:'/',left,right:{type:'value',value:100}};}
        while(peek()&&precedence[peek()!]!==undefined&&precedence[peek()!]>=min){const op=take().kind,p=precedence[op];left={type:'binary',op,left,right:expression(op==='^'?p:p+1)};}
        depth--;return left;
    }
    const result=expression();if(at!==tokens.length)throw new FormulaError('#PARSE!');return result;
}
export function renderFormula(expr:Expr,book:WorkbookSnapshot,currentSheet:string):string{
    function ref(r:Ref){const sheet=book.sheets.find(s=>s.id===r.sheet),row=sheet?.rows.findIndex(x=>x.id===r.row)??-1,column=sheet?.columns.findIndex(x=>x.id===r.column)??-1;if(!sheet||row<0||column<0)return '#REF!';return(r.sheet===currentSheet?'':`'${sheet.name.replaceAll("'","''")}'!`)+(r.absoluteColumn?'$':'')+columnName(column)+(r.absoluteRow?'$':'')+(row+1);}
    // Parentheses only where the parser would otherwise read the formula differently. These mirror its
    // precedence and associativity: every operator is left-associative except ^, and a unary sign binds
    // like ^ (its operand is parsed at level 5). So "=A1*10" comes back as typed, not "=(A1*10)".
    const PRECEDENCE:Record<string,number>={'=':1,'<>':1,'<':1,'>':1,'<=':1,'>=':1,'&':2,'+':3,'-':3,'*':4,'/':4,'^':5};
    const level=(e:Expr)=>e.type==='binary'?PRECEDENCE[e.op]:e.type==='unary'?5:99;
    function print(e:Expr):string{switch(e.type){case'value':return typeof e.value==='string'?`"${e.value.replaceAll('"','""')}"`:e.value===null?'0':String(e.value).toUpperCase();case'ref':return ref(e);case'range':return `${ref(e.from)}:${ref(e.to)}`;
        case'unary':{const operand=print(e.value);return e.op+(level(e.value)<5?`(${operand})`:operand);}
        case'binary':{const p=PRECEDENCE[e.op],left=print(e.left),right=print(e.right),rightAssociative=e.op==='^';return(level(e.left)<(rightAssociative?p+1:p)?`(${left})`:left)+e.op+(level(e.right)<(rightAssociative?p:p+1)?`(${right})`:right);}
        case'call':return `${e.name}(${e.args.map(print).join(',')})`;}}
    return '='+print(expr);
}
export function shiftFormula(expr:Expr,book:WorkbookSnapshot,dr:number,dc:number):Expr{
    const shift=(r:Ref):Ref=>{const sheet=book.sheets.find(s=>s.id===r.sheet);const ri=sheet?.rows.findIndex(x=>x.id===r.row)??-1,ci=sheet?.columns.findIndex(x=>x.id===r.column)??-1;return{...r,row:sheet?.rows[ri+(r.absoluteRow?0:dr)]?.id||'deleted',column:sheet?.columns[ci+(r.absoluteColumn?0:dc)]?.id||'deleted'};};
    switch(expr.type){case'ref':return shift(expr);case'range':return{...expr,from:shift(expr.from),to:shift(expr.to)};case'unary':return{...expr,value:shiftFormula(expr.value,book,dr,dc)};case'binary':return{...expr,left:shiftFormula(expr.left,book,dr,dc),right:shiftFormula(expr.right,book,dr,dc)};case'call':return{...expr,args:expr.args.map(e=>shiftFormula(e,book,dr,dc))};default:return expr;}
}
export function literal(input:string):Scalar{if(input==='')return null;if(input.startsWith("'"))return input.slice(1);if(/^(?:true|false)$/i.test(input))return input.toLowerCase()==='true';if(/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(input)){const n=Number(input);if(Number.isFinite(n))return n;}return input;}
export interface Calculation {values:Record<string,Scalar>;errors:Record<string,string>;}

/** `now` only feeds TODAY/NOW (read once per calculation); every other function is deterministic. */
export function calculate(book:WorkbookSnapshot,now?:Date):Calculation {
    const values:Record<string,Scalar>={},errors:Record<string,string>={},visiting=new Set<string>();
    // Rebuilt for this immutable input only: never reuse stale axis positions
    // after a collaborator inserts, removes or reorders a row/sheet.
    const indexes=new Map(book.sheets.map(sheet=>[sheet.id,{
        sheet,
        rows:new Map(sheet.rows.map((row,index)=>[row.id,index])),
        columns:new Map(sheet.columns.map((column,index)=>[column.id,index]))
    }]));
    let operations=0,current:{sheet:string;row:string;column:string}|null=null,clock:Date|undefined=now;
    const budget=()=>{if(++operations>2_000_000)throw new FormulaError('#LIMIT!');};
    const number=(value:Scalar)=>{if(value===null||value==='')return 0;if(typeof value==='boolean')return Number(value);if(typeof value==='number')return value;if(typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value)))return Number(value);throw new FormulaError('#VALUE!');};
    const truth=(v:Scalar)=>typeof v==='string'?v!==''&&v.toLowerCase()!=='false':!!v;
    const flatten=(value:Scalar|Scalar[])=>Array.isArray(value)?value:[value];
    function one(value:Scalar|Scalar[]){if(Array.isArray(value)){if(value.length!==1)throw new FormulaError('#VALUE!');return value[0];}return value;}
    function cell(sheetId:string,row:string,column:string):Scalar {
        const id=`${sheetId}/${cellKey(row,column)}`;
        if(Object.hasOwn(errors,id))throw new FormulaError(errors[id]);
        if(Object.hasOwn(values,id)){budget();return values[id];}
        let entered=false;
        try {
            budget();
            const indexed=indexes.get(sheetId);
            if(!indexed||!indexed.rows.has(row)||!indexed.columns.has(column))throw new FormulaError('#REF!');
            if(visiting.has(id))throw new FormulaError('#CYCLE!');
            if(visiting.size>128)throw new FormulaError('#LIMIT!');
            visiting.add(id);entered=true;
            const latest=heads(indexed.sheet.cells[cellKey(row,column)]||[]);
            if(latest.length>1)throw new FormulaError('#CONFLICT!');
            const version=latest[0];
            let result:Scalar=null;
            if(version){
                if(version.parseError)throw new FormulaError(version.parseError);
                if(version.expression){const outer=current;current={sheet:sheetId,row,column};try{result=one(evaluate(version.expression));}finally{current=outer;}}
                else result=version.literal!==undefined?version.literal:literal(version.input);
                if(typeof result==='number'&&!Number.isFinite(result))throw new FormulaError('#NUM!');
            }
            values[id]=result;
            return result;
        } catch(error) {
            // Budget/ref errors must be visible too, rather than an omitted
            // value which the grid could display as an innocent blank.
            errors[id]=error instanceof FormulaError?error.code:'#ERROR!';
            throw error;
        } finally {if(entered)visiting.delete(id);}
    }
    function criterion(expected:Scalar){if(typeof expected!=='string')return(v:Scalar)=>v===expected;const m=/^(<>|>=|<=|>|<|=)?(.*)$/.exec(expected)!;const op=m[1]||'=',raw=m[2],target=raw.trim()!==''&&Number.isFinite(Number(raw))?Number(raw):raw.toLowerCase();return(v:Scalar)=>{const value=typeof target==='number'?number(v):String(v??'').toLowerCase();switch(op){case'=':return value===target;case'<>':return value!==target;case'>':return value>target;case'<':return value<target;case'>=':return value>=target;default:return value<=target;}};}
    /* ---- Extended function set (see formulaFunctions.ts for the pure helpers) ---- */
    const fail=(code:string):never=>{throw new FormulaError(code);};
    /** Runs f; only Excel's own error values are caught. #CYCLE!, #LIMIT!, #CONFLICT! and the like always propagate. */
    function attempt<T>(f:()=>T):{ok:boolean;code:string;value:T}{try{return{ok:true,code:'',value:f()};}catch(error){if(error instanceof FormulaError&&EXCEL_ERRORS.has(error.code))return{ok:false,code:error.code,value:undefined as T};throw error;}}
    const val=(e:Expr)=>one(evaluate(e));
    const num=(e:Expr)=>number(val(e));
    const int=(e:Expr)=>Math.trunc(num(e));
    const text=(v:Scalar)=>v===null?'':typeof v==='boolean'?(v?'TRUE':'FALSE'):String(v);
    const textOf=(e:Expr)=>text(val(e));
    const cap=(s:string)=>s.length>MAX_TEXT?fail('#VALUE!'):s;
    /** Excel logical coercion: booleans, numbers, and the text TRUE/FALSE; other text is #VALUE!. */
    function logical(v:Scalar):boolean{if(typeof v==='boolean')return v;if(typeof v==='number')return v!==0;if(v===null)return false;const t=v.trim().toLowerCase();if(t==='true')return true;if(t==='false')return false;return fail('#VALUE!');}
    const grid=(v:Scalar|Scalar[]):Grid=>{if(!Array.isArray(v))return{rows:1,cols:1,cells:[v]};const s=shapes.get(v);return s?{...s,cells:v}:{rows:v.length,cols:1,cells:v};};
    const shaped=(cells:Scalar[],rows:number,cols:number)=>{shapes.set(cells,{rows,cols});return cells;};
    const isRef=(e:Expr)=>e.type==='ref'||e.type==='range';
    /** Numbers for statistics: cells in references count only when numeric; direct arguments are coerced. */
    function numbersOf(args:Expr[]):number[]{const out:number[]=[];for(const arg of args){if(isRef(arg)){for(const v of flatten(evaluate(arg)))if(typeof v==='number')out.push(v);}else{const v=evaluate(arg);if(Array.isArray(v)){for(const x of v)if(typeof x==='number')out.push(x);}else out.push(number(v));}}return out;}
    const snap=(x:number)=>Number(x.toPrecision(15));
    function roundDigits(x:number,digits:number,mode:'up'|'down'){if(Math.abs(digits)>15)fail('#NUM!');const sign=Math.sign(x),abs=Math.abs(x),pick=mode==='up'?Math.ceil:Math.floor;if(digits>=0){const f=10**digits;return sign*pick(snap(abs*f))/f;}const f=10**-digits;return sign*pick(snap(abs/f))*f;}
    function dateOf(v:Scalar):number{const n=typeof v==='string'?(parseIsoDate(v)??number(v)):number(v);if(n<0||n>=2958466)fail('#NUM!');return n;}
    const ymd=(v:Scalar)=>serialToDate(dateOf(v))??fail('#NUM!');
    function clockNow(){clock??=new Date();return clock;}
    function position(arg:Expr|undefined){
        const at=(sheet:string,row:string,column:string)=>{const ix=indexes.get(sheet),r=ix?.rows.get(row),c=ix?.columns.get(column);if(r===undefined||c===undefined)return fail('#REF!');return{row:r,col:c};};
        if(!arg){if(!current)return fail('#VALUE!');return{...at(current.sheet,current.row,current.column),rows:1,cols:1};}
        if(arg.type==='ref')return{...at(arg.sheet,arg.row,arg.column),rows:1,cols:1};
        if(arg.type==='range'){if(arg.from.sheet!==arg.to.sheet)return fail('#REF!');const a=at(arg.from.sheet,arg.from.row,arg.from.column),b=at(arg.to.sheet,arg.to.row,arg.to.column);return{row:Math.min(a.row,b.row),col:Math.min(a.col,b.col),rows:Math.abs(a.row-b.row)+1,cols:Math.abs(a.col-b.col)+1};}
        return fail('#VALUE!');
    }
    /** Cells of ranges that satisfy every (range, criteria) pair, reusing the COUNTIF/SUMIF criterion rules. */
    function matching(pairs:Expr[]):{mask:boolean[];shape:Grid}{
        let shape:Grid|undefined,mask:boolean[]=[];
        for(let i=0;i<pairs.length;i+=2){const g=grid(evaluate(pairs[i])),test=criterion(val(pairs[i+1]));
            if(!shape){shape=g;mask=g.cells.map(()=>true);}else if(g.rows!==shape.rows||g.cols!==shape.cols)fail('#VALUE!');
            for(let k=0;k<g.cells.length;k++)if(mask[k]&&!test(g.cells[k]))mask[k]=false;}
        return{mask,shape:shape!};
    }
    const sameKind=(a:Scalar,b:Scalar)=>a!==null&&b!==null&&typeof a===typeof b;
    const order=(a:Scalar,b:Scalar)=>typeof a==='string'?(a.toLowerCase()<(b as string).toLowerCase()?-1:a.toLowerCase()>(b as string).toLowerCase()?1:0):Number(a)-Number(b);
    /** Exact match position, case-insensitive for text; wildcards only where asked. -1 when absent. */
    function exactAt(cells:Scalar[],target:Scalar,wild:boolean,reverse=false):number{
        const lower=typeof target==='string'?target.toLowerCase():'',useWild=wild&&typeof target==='string'&&hasWildcard(target);
        const test=(v:Scalar)=>{if(!sameKind(v,target))return false;if(typeof target!=='string')return v===target;const t=(v as string).toLowerCase();return useWild?wildcardMatch(lower,t):t===lower;};
        if(reverse){for(let i=cells.length-1;i>=0;i--)if(test(cells[i]))return i;}else for(let i=0;i<cells.length;i++)if(test(cells[i]))return i;return -1;
    }
    /** Sorted-data search: largest value <= target (dir 1) or smallest value >= target (dir -1), as Excel's approximate modes. */
    function sortedAt(cells:Scalar[],target:Scalar,dir:1|-1):number{let best=-1;for(let i=0;i<cells.length;i++){const v=cells[i];if(!sameKind(v,target))continue;const c=order(v,target);if(dir===1?c>0:c<0)break;best=i;}return best;}
    /** XLOOKUP's unsorted exact-or-next: the closest value on the requested side, first in search order. */
    function nearestAt(cells:Scalar[],target:Scalar,dir:1|-1,reverse:boolean):number{let best=-1;const n=cells.length;for(let k=0;k<n;k++){const i=reverse?n-1-k:k,v=cells[i];if(!sameKind(v,target))continue;const c=order(v,target);if(c===0)return i;if(dir===1?c>0:c<0){if(best<0||(dir===1?order(v,cells[best])<0:order(v,cells[best])>0))best=i;}}return best;}
    const lookupKey=(v:Scalar):Scalar=>v===null?0:v;
    const vector=(g:Grid,what:string):Scalar[]=>{if(g.rows!==1&&g.cols!==1)fail(what);return g.cells;};
    function extended(expr:Extract<Expr,{type:'call'}>):Scalar|Scalar[]{
        const {name,args}=expr,arity=ARITY[name];if(!arity||args.length<arity[0]||args.length>arity[1])fail('#ARGS!');
        switch(name){
        // Logic and error handling. Branches that are not taken are never evaluated.
        case'IFERROR':case'IFNA':{const r=attempt(()=>evaluate(args[0]));if(r.ok)return r.value;return name==='IFNA'&&r.code!=='#N/A'?fail(r.code):evaluate(args[1]);}
        case'IFS':{if(args.length%2)fail('#ARGS!');for(let i=0;i<args.length;i+=2)if(logical(val(args[i])))return evaluate(args[i+1]);return fail('#N/A');}
        case'SWITCH':{const key=val(args[0]),pairs=(args.length-1)>>1,hasDefault=(args.length-1)%2===1;
            for(let i=0;i<pairs;i++){const candidate=val(args[1+2*i]);if(typeof key==='string'&&typeof candidate==='string'?key.toLowerCase()===candidate.toLowerCase():key===candidate)return evaluate(args[2+2*i]);}
            return hasDefault?evaluate(args[args.length-1]):fail('#N/A');}
        case'XOR':{let seen=false,odd=false;for(const arg of args){if(isRef(arg)){for(const v of flatten(evaluate(arg)))if(typeof v==='boolean'||typeof v==='number'){seen=true;if(logical(v))odd=!odd;}}else{seen=true;if(logical(val(arg)))odd=!odd;}}return seen?odd:fail('#VALUE!');}
        case'ISNUMBER':case'ISTEXT':case'ISBLANK':{const r=attempt(()=>val(args[0]));if(!r.ok)return false;return name==='ISNUMBER'?typeof r.value==='number':name==='ISTEXT'?typeof r.value==='string':r.value===null;}
        case'ISERROR':return!attempt(()=>val(args[0])).ok;
        case'ISNA':{const r=attempt(()=>val(args[0]));return!r.ok&&r.code==='#N/A';}
        // Math
        case'INT':return Math.floor(num(args[0]));
        case'MOD':{const n=num(args[0]),d=num(args[1]);if(d===0)fail('#DIV/0!');let r=n%d;if(r!==0&&(r<0)!==(d<0))r+=d;return r;}
        case'POWER':{const a=num(args[0]),b=num(args[1]);if(a===0&&b===0)fail('#NUM!');if(a===0&&b<0)fail('#DIV/0!');const r=a**b;return Number.isNaN(r)?fail('#NUM!'):r;}
        case'SQRT':{const x=num(args[0]);return x<0?fail('#NUM!'):Math.sqrt(x);}
        case'ROUNDUP':case'ROUNDDOWN':return roundDigits(num(args[0]),int(args[1]),name==='ROUNDUP'?'up':'down');
        case'CEILING':case'FLOOR':{const n=num(args[0]),s=num(args[1]);if(s===0)return name==='FLOOR'?fail('#DIV/0!'):0;if(n>0&&s<0)fail('#NUM!');const q=snap(n/s);return snap((name==='CEILING'?Math.ceil(q):Math.floor(q))*s);}
        case'SIGN':return Math.sign(num(args[0]));
        case'PRODUCT':{const n=numbersOf(args);return n.length?n.reduce((a,b)=>a*b,1):0;}
        case'MEDIAN':{const n=numbersOf(args).sort((a,b)=>a-b);if(!n.length)fail('#NUM!');const h=n.length>>1;return n.length%2?n[h]:(n[h-1]+n[h])/2;}
        case'MODE':{const n=numbersOf(args),count=new Map<number,number>();for(const x of n)count.set(x,(count.get(x)||0)+1);let best:number|undefined,top=1;for(const x of n){const c=count.get(x)!;if(c>top){top=c;best=x;}}return best??fail('#N/A');}
        case'STDEV':{const n=numbersOf(args);if(n.length<2)fail('#DIV/0!');const mean=n.reduce((a,b)=>a+b,0)/n.length;return Math.sqrt(n.reduce((a,b)=>a+(b-mean)**2,0)/(n.length-1));}
        case'LARGE':case'SMALL':{const n=numbersOf([args[0]]).sort((a,b)=>name==='LARGE'?b-a:a-b),k=Math.ceil(num(args[1]));if(!(k>=1)||k>n.length)fail('#NUM!');return n[k-1];}
        case'RANK':{const x=num(args[0]);if(!isRef(args[1]))fail('#VALUE!');const n=numbersOf([args[1]]),asc=args[2]?num(args[2])!==0:false;if(!n.includes(x))fail('#N/A');return 1+n.filter(v=>asc?v<x:v>x).length;}
        // Conditional aggregation
        case'AVERAGEIF':{const range=grid(evaluate(args[0])),test=criterion(val(args[1])),avg=args[2]?grid(evaluate(args[2])):range;if(avg.cells.length!==range.cells.length)fail('#VALUE!');let sum=0,n=0;range.cells.forEach((v,i)=>{const x=avg.cells[i];if(test(v)&&typeof x==='number'){sum+=x;n++;}});return n?sum/n:fail('#DIV/0!');}
        case'COUNTIFS':{if(args.length%2)fail('#ARGS!');return matching(args).mask.filter(Boolean).length;}
        case'SUMIFS':case'AVERAGEIFS':case'MAXIFS':case'MINIFS':{if(args.length%2===0)fail('#ARGS!');const target=grid(evaluate(args[0])),{mask,shape}=matching(args.slice(1));if(target.rows!==shape.rows||target.cols!==shape.cols)fail('#VALUE!');
            const picked:number[]=[];mask.forEach((m,i)=>{const x=target.cells[i];if(m&&typeof x==='number')picked.push(x);});
            if(name==='SUMIFS')return picked.reduce((a,b)=>a+b,0);if(name==='AVERAGEIFS')return picked.length?picked.reduce((a,b)=>a+b,0)/picked.length:fail('#DIV/0!');
            return picked.length?picked.reduce((a,b)=>name==='MAXIFS'?Math.max(a,b):Math.min(a,b)):0;}
        // Text
        case'LEFT':case'RIGHT':{const s=textOf(args[0]),n=args[1]?int(args[1]):1;if(n<0)fail('#VALUE!');return name==='LEFT'?s.slice(0,n):n===0?'':s.slice(-n);}
        case'MID':{const s=textOf(args[0]),start=int(args[1]),n=int(args[2]);if(start<1||n<0)fail('#VALUE!');return s.substr(start-1,n);}
        case'LEN':return textOf(args[0]).length;
        case'TRIM':return textOf(args[0]).replace(/ +/g,' ').replace(/^ | $/g,'');
        case'UPPER':return textOf(args[0]).toUpperCase();
        case'LOWER':return textOf(args[0]).toLowerCase();
        case'PROPER':return textOf(args[0]).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu,(_m,a:string,b:string)=>a+b.toUpperCase());
        case'SUBSTITUTE':{const s=textOf(args[0]),old=textOf(args[1]),rep=textOf(args[2]);if(old==='')return s;
            if(args[3]){const n=int(args[3]);if(n<1)fail('#VALUE!');let at=-1;for(let i=0;i<n;i++){at=s.indexOf(old,at+1);if(at<0)return s;}return cap(s.slice(0,at)+rep+s.slice(at+old.length));}
            const parts=s.split(old);if(s.length+(parts.length-1)*(rep.length-old.length)>MAX_TEXT)fail('#VALUE!');return parts.join(rep);}
        case'FIND':case'SEARCH':{const find=textOf(args[0]),within=textOf(args[1]),start=args[2]?int(args[2]):1;if(start<1||start>within.length+1)fail('#VALUE!');
            let at:number;if(name==='FIND')at=within.indexOf(find,start-1);
            else{const f=find.toLowerCase(),w=within.toLowerCase();if(hasWildcard(f)){if(w.length**2*f.length>5e7)fail('#LIMIT!');at=wildcardFind(f,w,start-1,budget);}else at=w.indexOf(f,start-1);}
            return at<0?fail('#VALUE!'):at+1;}
        case'TEXT':{const v=val(args[0]),format=textOf(args[1]);if(typeof v==='boolean')return text(v);const n=v===null?0:typeof v==='number'?v:parseNumberText(v);if(n===null)return v as string;if(!Number.isFinite(n))fail('#VALUE!');return cap(formatText(n,format)??fail('#VALUE!'));}
        case'VALUE':{const v=val(args[0]);if(typeof v==='number')return v;if(v===null)return 0;if(typeof v==='boolean')fail('#VALUE!');return parseNumberText(v as string)??fail('#VALUE!');}
        case'TEXTJOIN':{const delimiter=textOf(args[0]),skip=logical(val(args[1])),parts:string[]=[];let size=0;
            for(const arg of args.slice(2))for(const v of flatten(evaluate(arg))){if(skip&&(v===null||v===''))continue;const t=text(v);size+=t.length+delimiter.length;if(size>MAX_TEXT+delimiter.length)fail('#VALUE!');parts.push(t);}
            return cap(parts.join(delimiter));}
        case'REPT':{const s=textOf(args[0]),n=int(args[1]);if(n<0||s.length*n>MAX_TEXT)fail('#VALUE!');return s.repeat(n);}
        case'EXACT':return textOf(args[0])===textOf(args[1]);
        // Dates (serial numbers; see formulaFunctions.ts for the 1900 leap-year note)
        case'TODAY':case'NOW':{const c=clockNow(),day=dateToSerial(c.getFullYear(),c.getMonth()+1,c.getDate())!;return name==='TODAY'?day:day+(c.getHours()*3600+c.getMinutes()*60+c.getSeconds())/86400;}
        case'DATE':return dateToSerial(int(args[0]),int(args[1]),int(args[2]))??fail('#NUM!');
        case'YEAR':return ymd(val(args[0])).y;
        case'MONTH':return ymd(val(args[0])).m;
        case'DAY':return ymd(val(args[0])).d;
        case'WEEKDAY':return weekday(dateOf(val(args[0])),args[1]?int(args[1]):1)??fail('#NUM!');
        case'EDATE':case'EOMONTH':return shiftMonths(dateOf(val(args[0])),int(args[1]),name==='EOMONTH')??fail('#NUM!');
        case'DATEDIF':return dateDif(dateOf(val(args[0])),dateOf(val(args[1])),textOf(args[2]))??fail('#NUM!');
        // Position: these read the reference itself, never its cells, so =ROW(A1) in A1 is not a cycle.
        case'ROW':return position(args[0]).row+1;
        case'COLUMN':return position(args[0]).col+1;
        case'ROWS':return position(args[0]).rows;
        case'COLUMNS':return position(args[0]).cols;
        // Lookup
        case'VLOOKUP':case'HLOOKUP':{const want=lookupKey(val(args[0])),g=grid(evaluate(args[1])),index=int(args[2]),exact=args[3]?!logical(val(args[3])):false,vertical=name==='VLOOKUP',span=vertical?g.cols:g.rows;
            if(index<1)fail('#VALUE!');if(index>span)fail('#REF!');
            const keys:Scalar[]=vertical?Array.from({length:g.rows},(_,r)=>g.cells[r*g.cols]):g.cells.slice(0,g.cols);
            const at=exact?exactAt(keys,want,true):sortedAt(keys,want,1);if(at<0)fail('#N/A');
            return vertical?g.cells[at*g.cols+index-1]:g.cells[(index-1)*g.cols+at];}
        case'MATCH':{const want=lookupKey(val(args[0])),cells=vector(grid(evaluate(args[1])),'#N/A'),kind=args[2]?Math.sign(num(args[2])):1;
            const at=kind===0?exactAt(cells,want,true):sortedAt(cells,want,kind>0?1:-1);return at<0?fail('#N/A'):at+1;}
        case'INDEX':{const g=grid(evaluate(args[0])),r=int(args[1]);let c=args[2]?int(args[2]):undefined,row=r;
            if(c===undefined){if(g.rows===1){c=r;row=1;}else if(g.cols===1)c=1;else c=0;}
            if(row<0||c<0)fail('#VALUE!');if(row>g.rows||c>g.cols)fail('#REF!');
            if(row===0&&c===0)return g.cells;
            if(row===0)return shaped(Array.from({length:g.rows},(_,i)=>g.cells[i*g.cols+c-1]),g.rows,1);
            if(c===0)return shaped(g.cells.slice((row-1)*g.cols,row*g.cols),1,g.cols);
            return g.cells[(row-1)*g.cols+c-1];}
        case'XLOOKUP':{const want=lookupKey(val(args[0])),look=grid(evaluate(args[1])),ret=grid(evaluate(args[2])),mode=args[4]?int(args[4]):0,search=args[5]?int(args[5]):1;
            const keys=vector(look,'#VALUE!'),horizontal=look.rows===1&&look.cols>1;
            if(![0,-1,1,2].includes(mode)||(search!==1&&search!==-1))fail('#VALUE!');
            if((horizontal?ret.cols:ret.rows)!==keys.length)fail('#VALUE!');
            const reverse=search===-1,at=mode===0||mode===2?exactAt(keys,want,mode===2,reverse):nearestAt(keys,want,mode as 1|-1,reverse);
            if(at<0)return args[3]?evaluate(args[3]):fail('#N/A');
            if(horizontal)return ret.rows===1?ret.cells[at]:shaped(Array.from({length:ret.rows},(_,r)=>ret.cells[r*ret.cols+at]),ret.rows,1);
            return ret.cols===1?ret.cells[at]:shaped(ret.cells.slice(at*ret.cols,(at+1)*ret.cols),1,ret.cols);}
        default:return fail('#UNSUPPORTED!');}
    }
    function evaluate(expr:Expr):Scalar|Scalar[]{budget();switch(expr.type){
        case'value':return expr.value;case'ref':return cell(expr.sheet,expr.row,expr.column);
        case'range':{
            if(expr.from.sheet!==expr.to.sheet)throw new FormulaError('#REF!');
            const indexed=indexes.get(expr.from.sheet);
            if(!indexed)throw new FormulaError('#REF!');
            const {sheet,rows,columns}=indexed;
            const r1=rows.get(expr.from.row),r2=rows.get(expr.to.row),c1=columns.get(expr.from.column),c2=columns.get(expr.to.column);
            if(r1===undefined||r2===undefined||c1===undefined||c2===undefined)throw new FormulaError('#REF!');
            if((Math.abs(r2-r1)+1)*(Math.abs(c2-c1)+1)>100000)throw new FormulaError('#LIMIT!');
            const result:Scalar[]=[];
            for(let r=Math.min(r1,r2);r<=Math.max(r1,r2);r++)for(let c=Math.min(c1,c2);c<=Math.max(c1,c2);c++)result.push(cell(sheet.id,sheet.rows[r].id,sheet.columns[c].id));
            shapes.set(result,{rows:Math.abs(r2-r1)+1,cols:Math.abs(c2-c1)+1});
            return result;
        }
        case'unary':return(expr.op==='-'?-1:1)*number(one(evaluate(expr.value)));
        case'binary':{const a=one(evaluate(expr.left)),b=one(evaluate(expr.right));switch(expr.op){case'&':return String(a??'')+String(b??'');case'=':return typeof a==='string'&&typeof b==='string'?a.toLowerCase()===b.toLowerCase():a===b;case'<>':return a!==b;case'>':return number(a)>number(b);case'<':return number(a)<number(b);case'>=':return number(a)>=number(b);case'<=':return number(a)<=number(b);case'+':return number(a)+number(b);case'-':return number(a)-number(b);case'*':return number(a)*number(b);case'/':if(number(b)===0)throw new FormulaError('#DIV/0!');return number(a)/number(b);case'^':return number(a)**number(b);default:throw new FormulaError('#UNSUPPORTED!');}}
        case'call':{const args=expr.args;const required=(min:number,max=min)=>{if(args.length<min||args.length>max)throw new FormulaError('#ARGS!');};if(expr.name==='IF'){required(2,3);return truth(one(evaluate(args[0])))?evaluate(args[1]):args[2]?evaluate(args[2]):false;}
            if(expr.name==='COUNTIF'||expr.name==='SUMIF'){required(2,expr.name==='SUMIF'?3:2);const range=flatten(evaluate(args[0])),test=criterion(one(evaluate(args[1]))),sums=args[2]?flatten(evaluate(args[2])):range;if(range.length!==sums.length)throw new FormulaError('#VALUE!');return range.reduce<number>((n,v,i)=>n+(test(v)?expr.name==='COUNTIF'?1:number(sums[i]):0),0);}
            if(expr.name==='ROUND'){required(1,2);const x=number(one(evaluate(args[0]))),digits=args[1]?number(one(evaluate(args[1]))):0;if(!Number.isInteger(digits)||Math.abs(digits)>12)throw new FormulaError('#NUM!');const f=10**digits;return Math.sign(x)*Math.round((Math.abs(x)+Number.EPSILON)*f)/f;}
            if(expr.name==='ABS'||expr.name==='NOT'){required(1);const x=one(evaluate(args[0]));return expr.name==='ABS'?Math.abs(number(x)):!truth(x);}
            if(!LEGACY_SET.has(expr.name))return extended(expr);
            required(1,128);const all=args.flatMap(arg=>flatten(evaluate(arg)));const nums=all.filter((v):v is number=>typeof v==='number');switch(expr.name){case'SUM':return nums.reduce((a,b)=>a+b,0);case'AVERAGE':if(!nums.length)throw new FormulaError('#DIV/0!');return nums.reduce((a,b)=>a+b,0)/nums.length;case'MIN':return nums.length?nums.reduce((a,b)=>Math.min(a,b)):0;case'MAX':return nums.length?nums.reduce((a,b)=>Math.max(a,b)):0;case'COUNT':return nums.length;case'COUNTA':return all.filter(v=>v!==null&&v!=='').length;case'AND':return all.every(truth);case'OR':return all.some(truth);case'CONCAT':return all.map(v=>String(v??'')).join('');default:throw new FormulaError('#UNSUPPORTED!');}}
    }}
    for(const sheet of book.sheets)for(const key of Object.keys(sheet.cells)){
        const [row,column]=key.split('|'),id=`${sheet.id}/${key}`;
        try{cell(sheet.id,row,column);}catch(error){errors[id]=error instanceof FormulaError?error.code:'#ERROR!';}
    }
    return{values,errors};
}
