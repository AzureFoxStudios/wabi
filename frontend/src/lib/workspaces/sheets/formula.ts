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
const functions=new Set(['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','IF','AND','OR','ROUND','COUNTIF','SUMIF','ABS','NOT','CONCAT']);
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
    function print(e:Expr):string{switch(e.type){case'value':return typeof e.value==='string'?`"${e.value.replaceAll('"','""')}"`:e.value===null?'0':String(e.value).toUpperCase();case'ref':return ref(e);case'range':return `${ref(e.from)}:${ref(e.to)}`;case'unary':return `${e.op}(${print(e.value)})`;case'binary':return `(${print(e.left)}${e.op}${print(e.right)})`;case'call':return `${e.name}(${e.args.map(print).join(',')})`;}}
    return '='+print(expr);
}
export function shiftFormula(expr:Expr,book:WorkbookSnapshot,dr:number,dc:number):Expr{
    const shift=(r:Ref):Ref=>{const sheet=book.sheets.find(s=>s.id===r.sheet);const ri=sheet?.rows.findIndex(x=>x.id===r.row)??-1,ci=sheet?.columns.findIndex(x=>x.id===r.column)??-1;return{...r,row:sheet?.rows[ri+(r.absoluteRow?0:dr)]?.id||'deleted',column:sheet?.columns[ci+(r.absoluteColumn?0:dc)]?.id||'deleted'};};
    switch(expr.type){case'ref':return shift(expr);case'range':return{...expr,from:shift(expr.from),to:shift(expr.to)};case'unary':return{...expr,value:shiftFormula(expr.value,book,dr,dc)};case'binary':return{...expr,left:shiftFormula(expr.left,book,dr,dc),right:shiftFormula(expr.right,book,dr,dc)};case'call':return{...expr,args:expr.args.map(e=>shiftFormula(e,book,dr,dc))};default:return expr;}
}
export function literal(input:string):Scalar{if(input==='')return null;if(input.startsWith("'"))return input.slice(1);if(/^(?:true|false)$/i.test(input))return input.toLowerCase()==='true';if(/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(input)){const n=Number(input);if(Number.isFinite(n))return n;}return input;}
export interface Calculation {values:Record<string,Scalar>;errors:Record<string,string>;}

export function calculate(book:WorkbookSnapshot):Calculation {
    const values:Record<string,Scalar>={},errors:Record<string,string>={},visiting=new Set<string>();
    // Rebuilt for this immutable input only: never reuse stale axis positions
    // after a collaborator inserts, removes or reorders a row/sheet.
    const indexes=new Map(book.sheets.map(sheet=>[sheet.id,{
        sheet,
        rows:new Map(sheet.rows.map((row,index)=>[row.id,index])),
        columns:new Map(sheet.columns.map((column,index)=>[column.id,index]))
    }]));
    let operations=0;
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
                result=version.expression?one(evaluate(version.expression)):version.literal!==undefined?version.literal:literal(version.input);
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
            return result;
        }
        case'unary':return(expr.op==='-'?-1:1)*number(one(evaluate(expr.value)));
        case'binary':{const a=one(evaluate(expr.left)),b=one(evaluate(expr.right));switch(expr.op){case'&':return String(a??'')+String(b??'');case'=':return typeof a==='string'&&typeof b==='string'?a.toLowerCase()===b.toLowerCase():a===b;case'<>':return a!==b;case'>':return number(a)>number(b);case'<':return number(a)<number(b);case'>=':return number(a)>=number(b);case'<=':return number(a)<=number(b);case'+':return number(a)+number(b);case'-':return number(a)-number(b);case'*':return number(a)*number(b);case'/':if(number(b)===0)throw new FormulaError('#DIV/0!');return number(a)/number(b);case'^':return number(a)**number(b);default:throw new FormulaError('#UNSUPPORTED!');}}
        case'call':{const args=expr.args;const required=(min:number,max=min)=>{if(args.length<min||args.length>max)throw new FormulaError('#ARGS!');};if(expr.name==='IF'){required(2,3);return truth(one(evaluate(args[0])))?evaluate(args[1]):args[2]?evaluate(args[2]):false;}
            if(expr.name==='COUNTIF'||expr.name==='SUMIF'){required(2,expr.name==='SUMIF'?3:2);const range=flatten(evaluate(args[0])),test=criterion(one(evaluate(args[1]))),sums=args[2]?flatten(evaluate(args[2])):range;if(range.length!==sums.length)throw new FormulaError('#VALUE!');return range.reduce<number>((n,v,i)=>n+(test(v)?expr.name==='COUNTIF'?1:number(sums[i]):0),0);}
            if(expr.name==='ROUND'){required(1,2);const x=number(one(evaluate(args[0]))),digits=args[1]?number(one(evaluate(args[1]))):0;if(!Number.isInteger(digits)||Math.abs(digits)>12)throw new FormulaError('#NUM!');const f=10**digits;return Math.sign(x)*Math.round((Math.abs(x)+Number.EPSILON)*f)/f;}
            if(expr.name==='ABS'||expr.name==='NOT'){required(1);const x=one(evaluate(args[0]));return expr.name==='ABS'?Math.abs(number(x)):!truth(x);}
            required(1,128);const all=args.flatMap(arg=>flatten(evaluate(arg)));const nums=all.filter((v):v is number=>typeof v==='number');switch(expr.name){case'SUM':return nums.reduce((a,b)=>a+b,0);case'AVERAGE':if(!nums.length)throw new FormulaError('#DIV/0!');return nums.reduce((a,b)=>a+b,0)/nums.length;case'MIN':return nums.length?nums.reduce((a,b)=>Math.min(a,b)):0;case'MAX':return nums.length?nums.reduce((a,b)=>Math.max(a,b)):0;case'COUNT':return nums.length;case'COUNTA':return all.filter(v=>v!==null&&v!=='').length;case'AND':return all.every(truth);case'OR':return all.some(truth);case'CONCAT':return all.map(v=>String(v??'')).join('');default:throw new FormulaError('#UNSUPPORTED!');}}
    }}
    for(const sheet of book.sheets)for(const key of Object.keys(sheet.cells)){
        const [row,column]=key.split('|'),id=`${sheet.id}/${key}`;
        try{cell(sheet.id,row,column);}catch(error){errors[id]=error instanceof FormulaError?error.code:'#ERROR!';}
    }
    return{values,errors};
}
