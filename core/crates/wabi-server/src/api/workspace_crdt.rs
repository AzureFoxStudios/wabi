//! Yjs v1 wire format, UTF-16 text offsets, bounded materialization.
use base64::{engine::general_purpose::STANDARD,Engine};
use serde_json::Value;
use sha2::{Digest,Sha256};
use yrs::{Doc,GetString,Map,Options,ReadTxn,StateVector,Text,Transact,Update,updates::decoder::Decode,types::ToJson};
use crate::error::AppError;
use super::workspace::{Artifact,bad,sheet_rules};
type Result<T>=std::result::Result<T,AppError>;
pub(super) const MAX_DOCUMENT:usize=12*1024*1024;
fn bytes(text:&str,limit:usize)->Result<Vec<u8>>{if text.len()>limit*4/3+8{return Err(bad("Encoded update exceeds limit"));}let bytes=STANDARD.decode(text).map_err(|_|bad("Invalid update encoding"))?;if bytes.len()>limit{return Err(bad("Update exceeds limit"));}Ok(bytes)}
fn empty()->Doc{let mut options=Options::default();options.offset_kind=yrs::OffsetKind::Utf16;let doc=Doc::with_options(options);doc.get_or_insert_text("title");doc.get_or_insert_text("body");doc.get_or_insert_map("data");doc}
fn apply(doc:&Doc,encoded:&str)->Result<()>{if encoded.is_empty(){return Ok(());}let raw=bytes(encoded,MAX_DOCUMENT)?;let update=Update::decode_v1(&raw).map_err(|_|bad("Invalid collaborative update"))?;doc.transact_mut().apply_update(update).map_err(|_|bad("Update cannot be integrated"))?;Ok(())}
pub(super) fn load(artifact:&Artifact)->Result<Doc>{let doc=empty();apply(&doc,&artifact.checkpoint)?;for update in &artifact.updates{apply(&doc,update)?;}Ok(doc)}
fn snapshot(doc:&Doc)->Vec<u8>{doc.transact().encode_state_as_update_v1(&StateVector::default())}
pub(super) fn data(doc:&Doc)->Result<Value>{let map=doc.get_or_insert_map("data");serde_json::to_value(map.to_json(&doc.transact())).map_err(|_|bad("Invalid workspace data"))}
fn walk(value:&Value,depth:usize,count:&mut usize)->Result<()>{
    *count+=1;if depth>64||*count>300000{return Err(bad("Workspace complexity limit exceeded"));}
    match value{
        Value::String(text)if text.len()>3*1024*1024=>return Err(bad("Cell or asset exceeds limit")),
        Value::Array(array)=>{if array.len()>100000{return Err(bad("Array limit exceeded"));}for item in array{walk(item,depth+1,count)?;}},
        Value::Object(object)=>{if object.len()>200000{return Err(bad("Object limit exceeded"));}for(key,item)in object{if key.len()>256{return Err(bad("Key limit exceeded"));}walk(item,depth+1,count)?;}},_=>{}
    }Ok(())
}
fn validate(doc:&Doc,kind:&str)->Result<String>{
    let transaction=doc.transact();if transaction.root_refs().any(|(name,_)|!["title","body","data"].contains(&name)){return Err(bad("Unknown workspace root"));}drop(transaction);
    let title=doc.get_or_insert_text("title").get_string(&doc.transact());if title.trim().is_empty()||title.chars().count()>200{return Err(bad("Title must contain 1–200 characters"));}
    if doc.get_or_insert_text("body").get_string(&doc.transact()).len()>1024*1024{return Err(bad("Document text exceeds limit"));}
    let value=data(doc)?;walk(&value,0,&mut 0)?;
    match kind{
        "document"=>{if value.as_object().is_none_or(|map|!map.is_empty()){return Err(bad("Document has unexpected structured data"));}},
        "sheets"=>sheet_rules::validate(&value)?,
        "present"=>super::workspace_present::validate_deck(&value)?,
        _=>return Err(bad("Unsupported workspace kind")),
    }
    if snapshot(doc).len()>MAX_DOCUMENT{return Err(bad("Workspace exceeds supported size"));}Ok(title)
}
pub(super) struct MergeResult{pub snapshot:String,pub delta:String,pub title:String,pub changed:bool}
pub(super) fn merge(artifact:&Artifact,update:Option<&str>,vector:&str)->Result<MergeResult>{
    let doc=load(artifact)?;let before=snapshot(&doc);if let Some(update)=update{apply(&doc,update)?;}
    let title=validate(&doc,&artifact.kind)?;let after=snapshot(&doc);
    let vector=if vector.is_empty(){StateVector::default()}else{StateVector::decode_v1(&bytes(vector,65536)?).map_err(|_|bad("Invalid state vector"))?};
    let delta=doc.transact().encode_state_as_update_v1(&vector);
    Ok(MergeResult{changed:before!=after,snapshot:STANDARD.encode(after),delta:STANDARD.encode(delta),title})
}
pub(super) fn enforce_protection(artifact:&Artifact,merged:&str)->Result<()>{
    let before=data(&load(artifact)?)?;let after=empty();apply(&after,merged)?;
    sheet_rules::enforce(&before,&data(&after)?,&artifact.protected_ranges)
}
pub(super) fn body_hash(artifact:&Artifact)->Result<String>{let doc=load(artifact)?;let text=doc.get_or_insert_text("body").get_string(&doc.transact());Ok(Sha256::digest(text.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>())}
pub(super) fn replace_body(artifact:&Artifact,expected:&str,proposal:&str)->Result<String>{
    let doc=load(artifact)?;let body=doc.get_or_insert_text("body");let current=body.get_string(&doc.transact());
    if Sha256::digest(current.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>()!=expected{return Err(AppError::Conflict("Text changed after this suggestion was made. Review it against the current text; nothing was replaced.".into()));}
    {let mut transaction=doc.transact_mut();let length=body.len(&transaction);body.remove_range(&mut transaction,0,length);body.insert(&mut transaction,0,proposal);}
    validate(&doc,&artifact.kind)?;Ok(STANDARD.encode(snapshot(&doc)))
}
