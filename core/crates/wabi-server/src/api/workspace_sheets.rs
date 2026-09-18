//! Workbook schema validation and owner-controlled edit protection. Neither
//! protection metadata nor permission decisions are accepted from CRDT content.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use crate::error::AppError;
use super::{bad, valid_id};
type Result<T> = std::result::Result<T, AppError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct ProtectedRange {
    pub id:String, pub sheet_id:String, pub rows:Vec<String>, pub columns:Vec<String>, pub label:String,
}
fn object(value:&Value)->Result<&Map<String,Value>>{value.as_object().ok_or_else(||bad("Workbook object has an invalid shape"))}
fn allowed(value:&Value,fields:&[&str])->Result<()>{if object(value)?.keys().any(|key|!fields.contains(&key.as_str())){return Err(bad("Workbook contains an unsupported field"));}Ok(())}
fn text(value:&Value,limit:usize)->Result<()>{if value.as_str().is_none_or(|text|text.len()>limit){return Err(bad("Workbook text exceeds its supported limit"));}Ok(())}
fn optional_bool(value:&Value)->Result<()>{if !value.is_null()&&!value.is_boolean(){return Err(bad("Workbook flag has an invalid type"));}Ok(())}
fn finite(value:&Value)->bool{value.as_f64().is_some_and(f64::is_finite)}
// JavaScript/Yrs values can arrive as 140 or 140.0. Both encode the same
// bounded integer; fractional, negative and non-finite values remain invalid.
fn integer(value:&Value,min:f64,max:f64)->bool{value.as_f64().is_some_and(|n|n.is_finite()&&n.fract()==0.0&&n>=min&&n<=max)}
fn scalar(value:&Value)->Result<()>{if !(value.is_null()||value.is_boolean()||finite(value)||value.as_str().is_some_and(|s|s.len()<=32768)){return Err(bad("Cell scalar has an invalid type or size"));}Ok(())}
fn reference(value:&Value)->Result<()>{
    allowed(value,&["type","sheet","row","column","absoluteRow","absoluteColumn"])?;
    if value["type"]!="ref"{return Err(bad("Invalid formula reference"));}
    valid_id(value["sheet"].as_str().ok_or_else(||bad("Invalid reference sheet"))?)?;
    for name in ["row","column"]{let id=value[name].as_str().ok_or_else(||bad("Invalid reference axis"))?;if id!="deleted"{valid_id(id)?;}}
    if !value["absoluteRow"].is_boolean()||!value["absoluteColumn"].is_boolean(){return Err(bad("Invalid absolute reference flags"));}Ok(())
}
fn expression(value:&Value,depth:usize,count:&mut usize)->Result<()>{
    *count+=1;if depth>48||*count>512{return Err(bad("Formula complexity limit exceeded"));}
    match value["type"].as_str(){
        Some("value")=>{allowed(value,&["type","value"])?;scalar(&value["value"])?;},
        Some("ref")=>reference(value)?,
        Some("range")=>{allowed(value,&["type","from","to"])?;reference(&value["from"])?;reference(&value["to"])?;},
        Some("unary")=>{allowed(value,&["type","op","value"])?;if !["+","-"].contains(&value["op"].as_str().unwrap_or("")){return Err(bad("Invalid unary operator"));}expression(&value["value"],depth+1,count)?;},
        Some("binary")=>{allowed(value,&["type","op","left","right"])?;if !["+","-","*","/","^","&","=","<>",">","<",">=","<="].contains(&value["op"].as_str().unwrap_or("")){return Err(bad("Invalid binary operator"));}expression(&value["left"],depth+1,count)?;expression(&value["right"],depth+1,count)?;},
        Some("call")=>{allowed(value,&["type","name","args"])?;if !["SUM","AVERAGE","MIN","MAX","COUNT","COUNTA","IF","AND","OR","ROUND","COUNTIF","SUMIF","ABS","NOT","CONCAT"].contains(&value["name"].as_str().unwrap_or("")){return Err(bad("Unsupported formula function"));}let args=value["args"].as_array().ok_or_else(||bad("Invalid formula arguments"))?;if args.len()>128{return Err(bad("Too many formula arguments"));}for arg in args{expression(arg,depth+1,count)?;}},
        _=>return Err(bad("Invalid formula expression")),
    }Ok(())
}
fn style(value:&Value)->Result<()>{
    allowed(value,&["bold","italic","format","align","fill","wrap","border","precision","currency"])?;
    for flag in ["bold","italic","wrap","border"]{optional_bool(&value[flag])?;}
    if !value["format"].is_null()&&!["general","number","percent","currency","text","date"].contains(&value["format"].as_str().unwrap_or("")){return Err(bad("Invalid number format"));}
    if !value["align"].is_null()&&!["left","center","right"].contains(&value["align"].as_str().unwrap_or("")){return Err(bad("Invalid alignment"));}
    if let Some(fill)=value["fill"].as_str(){if !fill.is_empty()&&!(fill.len()==7&&fill.starts_with('#')&&fill[1..].bytes().all(|b|b.is_ascii_hexdigit())){return Err(bad("Invalid fill color"));}}else if !value["fill"].is_null(){return Err(bad("Invalid fill color"));}
    if !value["precision"].is_null()&&!integer(&value["precision"],0.0,10.0){return Err(bad("Invalid decimal precision"));}
    if let Some(currency)=value["currency"].as_str(){if currency.len()!=3||!currency.bytes().all(|b|b.is_ascii_uppercase()){return Err(bad("Invalid currency code"));}}else if !value["currency"].is_null(){return Err(bad("Invalid currency code"));}Ok(())
}
fn cell_parts(cell:&str)->Result<(&str,&str)>{let (row,column)=cell.split_once('|').ok_or_else(||bad("Invalid cell identity"))?;valid_id(row)?;valid_id(column)?;Ok((row,column))}

pub(crate) fn validate(value:&Value)->Result<()>{
    allowed(value,&["schema","sheets"])?;if !integer(&value["schema"],1.0,1.0){return Err(bad("Unsupported workbook schema"));}
    let sheets=object(&value["sheets"])?;if sheets.is_empty()||sheets.len()>20{return Err(bad("Workbook must contain 1–20 sheets"));}
    for (sheet_id,sheet) in sheets {
        valid_id(sheet_id)?;allowed(sheet,&["name","position","removed","rows","columns","ops","styles","structureEdits"])?;text(&sheet["name"],400)?;
        if !finite(&sheet["position"]){return Err(bad("Invalid sheet position"));}optional_bool(&sheet["removed"])?;
        for (name,limit) in [("rows",12000),("columns",512)]{
            let axis=object(&sheet[name])?;if axis.is_empty()||axis.len()>limit{return Err(bad("Workbook axis limit exceeded"));}
            let mut active=0;
            for (id,item) in axis {valid_id(id)?;allowed(item,&["id","position","removed","width"])?;if item["id"]!=id.as_str()||!finite(&item["position"]){return Err(bad("Invalid row or column identity"));}optional_bool(&item["removed"])?;if item["removed"]!=true{active+=1;}if !item["width"].is_null()&&!integer(&item["width"],60.0,600.0){return Err(bad("Invalid column width"));}}
            if active==0||active>if name=="rows"{10000}else{256}{return Err(bad("Unsupported active grid dimensions"));}
        }
        let ops=object(&sheet["ops"])?;if ops.len()>200000{return Err(bad("Workbook edit-history limit exceeded"));}
        for (id,op) in ops {
            valid_id(id)?;allowed(op,&["id","cell","input","parents","expression","parseError","literal","cached","imported"])?;
            if op["id"]!=id.as_str(){return Err(bad("Cell version identity mismatch"));}text(&op["input"],32768)?;
            let (row,col)=cell_parts(op["cell"].as_str().ok_or_else(||bad("Missing cell identity"))?)?;
            if sheet["rows"].get(row).is_none()||sheet["columns"].get(col).is_none(){return Err(bad("Cell version refers to an unknown axis"));}
            let parents=op["parents"].as_array().ok_or_else(||bad("Missing cell version parents"))?;if parents.len()>2000{return Err(bad("Cell conflict limit exceeded"));}
            for parent in parents {let parent_id=parent.as_str().ok_or_else(||bad("Invalid cell parent"))?;valid_id(parent_id)?;if parent_id==id{return Err(bad("Cell version cannot supersede itself"));}if let Some(old)=ops.get(parent_id){if old["cell"]!=op["cell"]{return Err(bad("A cell version cannot supersede a different cell"));}}}
            if !op["expression"].is_null(){expression(&op["expression"],0,&mut 0)?;}
            if !op["parseError"].is_null(){text(&op["parseError"],100)?;}
            scalar(&op["literal"])?;scalar(&op["cached"])?;optional_bool(&op["imported"])?;
        }
        let styles=object(&sheet["styles"])?;if styles.len()>200000{return Err(bad("Formatting limit exceeded"));}
        for (cell,value) in styles{let(row,col)=cell_parts(cell)?;if sheet["rows"].get(row).is_none()||sheet["columns"].get(col).is_none(){return Err(bad("Formatting refers to an unknown axis"));}style(value)?;}
        let history=object(&sheet["structureEdits"])?;if history.len()>20000{return Err(bad("Structure history limit exceeded"));}for(id,entry)in history{valid_id(id)?;text(entry,100)?;}
    }Ok(())
}

pub(super) fn validate_ranges(data:&Value,ranges:&[ProtectedRange])->Result<()>{
    if ranges.len()>100{return Err(bad("Use at most 100 protected ranges"));}let mut ids=BTreeSet::new();
    for range in ranges {
        valid_id(&range.id)?;valid_id(&range.sheet_id)?;
        if !ids.insert(&range.id)||range.label.len()>200||range.rows.is_empty()||range.columns.is_empty()||range.rows.len()>1000||range.columns.len()>256{return Err(bad("Invalid protected range"));}
        let sheet=&data["sheets"][&range.sheet_id];if !sheet.is_object()||sheet["removed"]==true{return Err(bad("Protected sheet is unavailable"));}
        for(name,axis)in[("rows",&range.rows),("columns",&range.columns)]{let mut seen=BTreeSet::new();for id in axis{valid_id(id)?;if !seen.insert(id)||!sheet[name][id].is_object()||sheet[name][id]["removed"]==true{return Err(bad("Protected range contains an unavailable row or column"));}}}
    }Ok(())
}
fn protected_view(data:&Value,range:&ProtectedRange)->Value{
    let sheet=&data["sheets"][&range.sheet_id];
    let contains=|cell:&str|cell.split_once('|').is_some_and(|(r,c)|range.rows.iter().any(|id|id==r)&&range.columns.iter().any(|id|id==c));
    let ops:BTreeMapCompat=sheet["ops"].as_object().map(|ops|ops.iter().filter(|(_,op)|op["cell"].as_str().is_some_and(contains)).map(|(id,op)|(id.clone(),op.clone())).collect()).unwrap_or_default();
    let styles:BTreeMapCompat=sheet["styles"].as_object().map(|styles|styles.iter().filter(|(cell,_)|contains(cell)).map(|(id,value)|(id.clone(),value.clone())).collect()).unwrap_or_default();
    let rows:Vec<_>=range.rows.iter().map(|id|sheet["rows"].get(id).map(|v|v["removed"]!=true).unwrap_or(false)).collect();
    let columns:Vec<_>=range.columns.iter().map(|id|sheet["columns"].get(id).map(|v|v["removed"]!=true).unwrap_or(false)).collect();
    json!({"exists":sheet.is_object()&&sheet["removed"]!=true,"rows":rows,"columns":columns,"ops":ops,"styles":styles})
}
type BTreeMapCompat=std::collections::BTreeMap<String,Value>;
pub(crate) fn enforce(before:&Value,after:&Value,ranges:&[ProtectedRange])->Result<()>{
    for range in ranges {if protected_view(before,range)!=protected_view(after,range){return Err(AppError::Forbidden("This update changes an owner-protected range. Your local work is retained; make a private copy or ask the owner to remove protection.".into()));}}Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn workspace_protection_blocks_value_style_and_deletion_but_not_other_cells(){
        let (sheet,row,column)=("a","r","c");
        let before=json!({"sheets":{"a":{"rows":{"r":{"removed":false}},"columns":{"c":{"removed":false}},"ops":{},"styles":{}}}});
        let range=ProtectedRange{id:"range".into(),sheet_id:sheet.into(),rows:vec![row.into()],columns:vec![column.into()],label:"Protected".into()};
        let mut after=before.clone();after["sheets"][sheet]["ops"]["new"]=json!({"cell":"other|c","input":"3"});assert!(enforce(&before,&after,std::slice::from_ref(&range)).is_ok());
        after["sheets"][sheet]["ops"]["new"]=json!({"cell":"r|c","input":"3"});assert!(enforce(&before,&after,std::slice::from_ref(&range)).is_err());
        after=before.clone();after["sheets"][sheet]["styles"]["r|c"]=json!({"bold":true});assert!(enforce(&before,&after,std::slice::from_ref(&range)).is_err());
        after=before.clone();after["sheets"][sheet]["rows"][row]["removed"]=json!(true);assert!(enforce(&before,&after,&[range]).is_err());
    }
    #[test] fn workspace_formula_validator_rejects_executable_and_unknown_nodes(){
        assert!(expression(&json!({"type":"call","name":"FETCH","args":[]}),0,&mut 0).is_err());
        assert!(expression(&json!({"type":"value","value":4}),0,&mut 0).is_ok());
        assert!(expression(&json!({"type":"value","value":{"script":"evil"}}),0,&mut 0).is_err());
    }
    #[test] fn workspace_integer_fields_accept_equivalent_yjs_numbers_only(){
        assert!(integer(&json!(140),60.0,600.0));assert!(integer(&json!(140.0),60.0,600.0));
        assert!(!integer(&json!(140.5),60.0,600.0));assert!(!integer(&json!("140"),60.0,600.0));
        assert!(style(&json!({"precision":2.0})).is_ok());assert!(style(&json!({"precision":2.5})).is_err());
    }
}
