//! Yjs v1 wire format, UTF-16 text offsets, bounded materialization.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest,Sha256};
use yrs::{Doc,GetString,Map,Options,ReadTxn,StateVector,Text,Transact,Update,updates::decoder::Decode,types::ToJson};
use crate::error::AppError;
use super::workspace::{Artifact,bad};
type Result<T>=std::result::Result<T,AppError>;
pub(super) const MAX_DOCUMENT:usize=12*1024*1024;
fn bytes(text:&str,limit:usize)->Result<Vec<u8>>{if text.len()>limit*4/3+8{return Err(bad("Encoded update exceeds limit"));}let b=STANDARD.decode(text).map_err(|_|bad("Invalid update encoding"))?;if b.len()>limit{return Err(bad("Update exceeds limit"));}Ok(b)}
fn empty()->Doc{let mut options=Options::default();options.offset_kind=yrs::OffsetKind::Utf16;let doc=Doc::with_options(options);doc.get_or_insert_text("title");doc.get_or_insert_text("body");doc.get_or_insert_map("data");doc}
fn apply(doc:&Doc,b64:&str)->Result<()>{if b64.is_empty(){return Ok(());}let raw=bytes(b64,MAX_DOCUMENT)?;let update=Update::decode_v1(&raw).map_err(|_|bad("Invalid collaborative update"))?;doc.transact_mut().apply_update(update).map_err(|_|bad("Update cannot be integrated"))?;Ok(())}
pub(super) fn load(a:&Artifact)->Result<Doc>{let doc=empty();apply(&doc,&a.checkpoint)?;for update in &a.updates{apply(&doc,update)?;}Ok(doc)}
fn snapshot(doc:&Doc)->Vec<u8>{doc.transact().encode_state_as_update_v1(&StateVector::default())}
pub(super) fn data(doc:&Doc)->Result<Value>{let map=doc.get_or_insert_map("data");serde_json::to_value(map.to_json(&doc.transact())).map_err(|_|bad("Invalid workspace data"))}
fn walk(v:&Value,depth:usize,count:&mut usize)->Result<()>{*count+=1;if depth>12||*count>300_000{return Err(bad("Workspace complexity limit exceeded"));}match v{Value::String(s) if s.len()>3*1024*1024=>return Err(bad("Cell or asset exceeds limit")),Value::Array(a)=>{if a.len()>100_000{return Err(bad("Array limit exceeded"));}for child in a{walk(child,depth+1,count)?;}},Value::Object(o)=>{if o.len()>100_000{return Err(bad("Object limit exceeded"));}for(k,child)in o{if k.len()>256{return Err(bad("Key limit exceeded"));}walk(child,depth+1,count)?;}},_=>{}}Ok(())}
fn validate(doc:&Doc,kind:&str)->Result<String>{
    let txn=doc.transact();
    if txn.root_refs().any(|(name,_)| !["title","body","data"].contains(&name)){return Err(bad("Unknown workspace root"));}
    drop(txn);
    let title=doc.get_or_insert_text("title").get_string(&doc.transact());
    if title.trim().is_empty()||title.chars().count()>200{return Err(bad("Title must contain 1–200 characters"));}
    if doc.get_or_insert_text("body").get_string(&doc.transact()).len()>1024*1024{return Err(bad("Document text exceeds limit"));}
    let value=data(doc)?;walk(&value,0,&mut 0)?;
    match kind{
        "document"=>{if value.as_object().is_none_or(|m|!m.is_empty()){return Err(bad("Document has unexpected structured data"));}},
        "sheets"=>{if value["schema"]!=1||!value["sheets"].is_object(){return Err(bad("Unsupported workbook schema"));}},
        "present"=>super::workspace_present::validate_deck(&value)?,
        _=>return Err(bad("Unsupported workspace kind")),
    }
    if snapshot(doc).len()>MAX_DOCUMENT{return Err(bad("Workspace exceeds supported size"));}
    Ok(title)
}
pub(super) struct MergeResult{pub snapshot:String,pub delta:String,pub title:String,pub changed:bool}
pub(super) fn merge(a:&Artifact,update:Option<&str>,vector:&str)->Result<MergeResult>{
    let doc=load(a)?;let before=snapshot(&doc);if let Some(update)=update{apply(&doc,update)?;}
    let title=validate(&doc,&a.kind)?;let after=snapshot(&doc);
    let vector=if vector.is_empty(){StateVector::default()}else{StateVector::decode_v1(&bytes(vector,65536)?).map_err(|_|bad("Invalid state vector"))?};
    let delta=doc.transact().encode_state_as_update_v1(&vector);
    Ok(MergeResult{changed:before!=after,snapshot:STANDARD.encode(after),delta:STANDARD.encode(delta),title})
}
pub(super) fn body_hash(a:&Artifact)->Result<String>{let doc=load(a)?;let text=doc.get_or_insert_text("body").get_string(&doc.transact());Ok(Sha256::digest(text.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>())}
pub(super) fn replace_body(a:&Artifact,expected:&str,proposal:&str)->Result<String>{
    let doc=load(a)?;let body=doc.get_or_insert_text("body");let current=body.get_string(&doc.transact());
    if Sha256::digest(current.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>()!=expected{return Err(AppError::Conflict("Text changed after this suggestion was made. Review it against the current text; nothing was replaced.".into()));}
    {let mut tx=doc.transact_mut();let len=body.len(&tx);body.remove_range(&mut tx,0,len);body.insert(&mut tx,0,proposal);}
    validate(&doc,&a.kind)?;Ok(STANDARD.encode(snapshot(&doc)))
}
