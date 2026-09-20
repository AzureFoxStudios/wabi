import type PptxGenJS from 'pptxgenjs';
import { cleanDesign, tableRows, chartRows, scenePalette, type SceneObject, type SlideDesign } from '../scene';
type PptxSlide = ReturnType<PptxGenJS['addSlide']>;
const hex = (value:string) => value.replace('#','');

async function objectImage(object:SceneObject, aspect:number):Promise<string|null>{
    if(!object.image)return null;
    const image=new Image();image.src=object.image;await image.decode();
    if(image.naturalWidth*image.naturalHeight>32_000_000)throw new Error('Slide image dimensions exceed the export limit.');
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(object.w*1000));canvas.height=Math.max(1,Math.round(object.h*1000/aspect));
    const context=canvas.getContext('2d');if(!context)throw new Error('Image export is unavailable.');
    const scale=(object.fit==='cover'?Math.max:Math.min)(canvas.width/image.naturalWidth,canvas.height/image.naturalHeight);
    const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
    context.drawImage(image,(canvas.width-width)*(object.fit==='cover'?object.cropX:.5),(canvas.height-height)*(object.fit==='cover'?object.cropY:.5),width,height);
    const result=canvas.toDataURL('image/png');canvas.width=canvas.height=1;return result;
}
export async function addDesignToPptx(pptx:PptxGenJS,slide:PptxSlide,source:SlideDesign,width:number,height:number):Promise<void>{
    const design=cleanDesign(source),palette=scenePalette[design.theme];slide.background={color:hex(palette.background)};
    for(const object of design.objects){
        const x=object.x*width,y=object.y*height,w=object.w*width,h=object.h*height;
        const textOptions={x,y,w,h,fontFace:'Arial',fontSize:object.fontSize*.72,color:hex(object.color),align:object.align,margin:0,fit:'shrink' as const,valign:'top' as const,breakLine:false};
        const fill=object.fill==='transparent'?{color:'FFFFFF',transparency:100}:{color:hex(object.fill)};
        if(object.fill!=='transparent'&&object.kind!=='ellipse')slide.addShape(pptx.ShapeType.rect,{x,y,w,h,line:{color:hex(object.fill),transparency:100},fill});
        if(object.kind==='text')slide.addText(object.text,textOptions);
        else if(object.kind==='image'){const image=await objectImage(object,width/height);if(image)slide.addImage({data:image,x,y,w,h,altText:object.text});}
        else if(object.kind==='ellipse')slide.addShape(pptx.ShapeType.ellipse,{x,y,w,h,fill,line:{color:hex(object.color),transparency:object.fill==='transparent'?0:100}});
        else if(object.kind==='line')slide.addShape(pptx.ShapeType.line,{x,y,w,h,line:{color:hex(object.color),width:2}});
        else if(object.kind==='table'){
            const rows=tableRows(object.text);
            if(rows.length)slide.addTable(rows.map(row=>row.map(text=>({text}))),{...textOptions,fontSize:object.fontSize*.72*.72,border:{type:'solid',pt:1,color:hex(object.color)},rowH:h/rows.length,autoPage:false});
            else slide.addText('Table data exceeds the supported row/column limits.',textOptions);
        }else if(object.kind==='chart'){
            // Export bars and labels, not an embedded Excel workbook or a live data link.
            const rows=chartRows(object.text),maximum=Math.max(1,...rows.map(row=>Math.abs(row.value)));
            if(!rows.length){slide.addText('Chart requires label and numeric value columns.',textOptions);continue;}
            const rowH=h/rows.length;
            rows.forEach((row,index)=>{
                const top=y+index*rowH;
                slide.addText(row.label,{...textOptions,x,y:top,w:w*.28,h:rowH,fontSize:object.fontSize*.72*.72});
                slide.addText(String(row.value),{...textOptions,x:x+w*.82,y:top,w:w*.18,h:rowH,fontSize:object.fontSize*.72*.72});
                const chartX=x+w*.3,chartW=w*.48,barW=Math.abs(row.value)/maximum*chartW*.5;
                slide.addShape(pptx.ShapeType.line,{x:chartX+chartW*.5,y:top,w:0,h:rowH,line:{color:hex(object.color),width:.5}});
                if(barW>0)slide.addShape(pptx.ShapeType.rect,{x:chartX+chartW*.5-(row.value<0?barW:0),y:top+rowH*.15,w:barW,h:rowH*.7,fill:{color:hex(palette.accent)},line:{color:hex(palette.accent),transparency:100}});
            });
        }
    }
}

/** Build print DOM with textContent and fixed properties; never interpolate HTML. */
export function appendDesignToPrint(doc:Document,parent:HTMLElement,source:SlideDesign):Promise<void>[] {
    const design=cleanDesign(source),palette=scenePalette[design.theme],scene=doc.createElement('div');
    Object.assign(scene.style,{position:'absolute',inset:'0',overflow:'hidden',background:palette.background,containerType:'inline-size'});parent.append(scene);
    const images:Promise<void>[]=[];
    for(const object of design.objects){
        const box=doc.createElement('div');
        Object.assign(box.style,{position:'absolute',boxSizing:'border-box',overflow:'hidden',left:`${object.x*100}%`,top:`${object.y*100}%`,width:`${object.w*100}%`,height:`${object.h*100}%`,background:object.fill,color:object.color,fontFamily:'Arial,sans-serif',fontSize:`${object.fontSize/10}cqw`,lineHeight:'1.25',textAlign:object.align});
        scene.append(box);
        if(object.kind==='text'){Object.assign(box.style,{whiteSpace:'pre-wrap',overflowWrap:'anywhere',padding:'.15em'});box.textContent=object.text;}
        else if(object.kind==='ellipse')box.style.borderRadius='50%';
        else if(object.kind==='image'&&object.image){const image=doc.createElement('img');image.src=object.image;image.alt=object.text;Object.assign(image.style,{width:'100%',height:'100%',maxHeight:'100%',objectFit:object.fit,objectPosition:`${object.cropX*100}% ${object.cropY*100}%`});box.append(image);images.push(image.decode());}
        else if(object.kind==='line'){const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 100 100');svg.setAttribute('preserveAspectRatio','none');svg.style.width=svg.style.height='100%';const line=doc.createElementNS(svg.namespaceURI,'line');for(const[key,value]of Object.entries({x1:'0',y1:'0',x2:'100',y2:'100',stroke:object.color,'stroke-width':'2','vector-effect':'non-scaling-stroke'}))line.setAttribute(key,value);svg.append(line);box.append(svg);}
        else if(object.kind==='table'){
            const rows=tableRows(object.text),table=doc.createElement('table');Object.assign(table.style,{width:'100%',height:'100%',borderCollapse:'collapse',tableLayout:'fixed',fontSize:'.72em'});box.append(table);
            if(!rows.length){box.textContent='Table requires at most 20 rows and 8 columns.';continue;}
            rows.forEach((row,index)=>{const tr=doc.createElement('tr');for(const text of row){const cell=doc.createElement(index===0?'th':'td');cell.textContent=text;Object.assign(cell.style,{border:'1px solid currentColor',padding:'.2em',overflowWrap:'anywhere',whiteSpace:'pre-wrap'});tr.append(cell);}table.append(tr);});
        }else if(object.kind==='chart'){
            const rows=chartRows(object.text),maximum=Math.max(1,...rows.map(row=>Math.abs(row.value)));Object.assign(box.style,{display:'flex',flexDirection:'column',justifyContent:'space-around',gap:'.15em',fontSize:`${object.fontSize/10*.72}cqw`});
            if(!rows.length){box.textContent='Chart requires label and numeric value columns.';continue;}
            for(const row of rows){const line=doc.createElement('div');Object.assign(line.style,{display:'grid',gridTemplateColumns:'28% 1fr 18%',gap:'2%',alignItems:'center',flex:'1',minHeight:'0'});const label=doc.createElement('span');label.textContent=row.label;const space=doc.createElement('div');Object.assign(space.style,{position:'relative',height:'70%'});const axis=doc.createElement('i');Object.assign(axis.style,{position:'absolute',left:'50%',top:'-10%',bottom:'-10%',borderLeft:'1px solid currentColor',opacity:'.5'});const bar=doc.createElement('i');Object.assign(bar.style,{position:'absolute',top:'0',bottom:'0',left:`${row.value<0?50-Math.abs(row.value)/maximum*50:50}%`,width:`${Math.abs(row.value)/maximum*50}%`,background:palette.accent});space.append(axis,bar);const value=doc.createElement('span');value.textContent=String(row.value);line.append(label,space,value);box.append(line);}
        }
    }
    return images;
}
