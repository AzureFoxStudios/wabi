//! Versioned workspace events. Existing postcard record layouts are unchanged.
//! Content fields, Authority-owned ACLs, review actions and audience sessions are separate.
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::{engine::locks::ProjectionState, error::{Result, WabiError}, projections::handler::{DurableEvent, Projection}};

pub const INDEX: &str = "workspace_artifacts_v1";
pub const EVENT: &str = "workspace_artifact_v1";
pub const MAX_FIELDS: usize = 250_000;
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub type Fields = BTreeMap<String, Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access { Viewer, Commenter, Editor }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Document, Sheet, Deck }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode { Snapshot, Live }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    pub id: String, pub author_id: i64, pub body: String, pub field: Option<String>,
    pub proposal: Option<Value>, pub base_field_version: u64, pub is_suggestion: bool,
    pub status: String, pub at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub v: u8, pub id: String, pub kind: Kind, pub owner_id: i64,
    pub channel_id: Option<String>, pub channel_access: Access, pub grants: BTreeMap<String, Access>,
    pub revision: u64, pub generation: u64, pub mode: Mode,
    pub fields: Fields, pub versions: BTreeMap<String, u64>, pub reviews: Vec<Review>,
    pub updated_at: u64, pub deleted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change { pub key: String, pub expected: u64, pub value: Value, pub remove: bool, #[serde(default)] pub text_patch: Option<TextPatch> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct TextPatch {pub start:usize,pub delete:usize,pub insert:String}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Metadata {pub id:String,pub kind:Kind,pub owner_id:i64,pub channel_id:Option<String>,pub channel_access:Access,pub grants:BTreeMap<String,Access>,pub revision:u64,pub generation:u64,pub mode:Mode,pub title:String,pub updated_at:u64,pub deleted:bool}
impl From<&Artifact> for Metadata {fn from(a:&Artifact)->Self{Self{id:a.id.clone(),kind:a.kind,owner_id:a.owner_id,channel_id:a.channel_id.clone(),channel_access:a.channel_access,grants:a.grants.clone(),revision:a.revision,generation:a.generation,mode:a.mode,title:a.fields.get("title").and_then(Value::as_str).unwrap_or("").into(),updated_at:a.updated_at,deleted:a.deleted}}}
fn store_artifact(state:&ProjectionState,a:&Artifact,seq:u64)->Result<()>{state.insert(INDEX,artifact_key(&a.id).into_bytes(),encode(a)?,seq);state.insert(INDEX,format!("meta:{}",a.id).into_bytes(),encode(&Metadata::from(a))?,seq);Ok(())}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page { pub id: String, pub title: String, pub body: String, pub layout: String, pub image: Option<String>, #[serde(default)] pub theme: Option<String>, #[serde(default)] pub aspect: Option<f64> }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    pub v: u8, pub id: String, pub channel_id: String, pub owner_id: i64, pub controller_id: i64,
    pub generation: u64, pub sequence: u64, pub title: String, pub pages: Vec<Page>,
    pub slide_id: String, pub blank: bool, pub ended: bool, pub updated_at: u64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities { pub sheets: bool, pub present: bool }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Create { artifact: Artifact },
    Change { generation: u64, changes: Vec<Change> },
    Permissions { revision: u64, grants: BTreeMap<String, Access>, channel_id: Option<String>, channel_access: Access },
    SetMode { generation: u64, mode: Mode },
    AddReview { review: Review },
    ReviewStatus { review_id: String, status: String },
    Delete { revision: u64 },
    Start { presentation: Presentation },
    Control { generation: u64, sequence: u64, slide_id: Option<String>, controller_id: Option<i64>, blank: Option<bool>, end: bool },
    UpdatePresentation {generation:u64,sequence:u64,title:String,pages:Vec<Page>,slide_id:String},
    Configure { capabilities: Capabilities },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope { pub v: u8, pub id: String, pub op_id: String, pub actor: i64, pub at: u64, pub command: Command }
fn bad(reason: impl Into<String>) -> WabiError { WabiError::Validation { command: "workspace_artifact_v1".into(), reason: reason.into() } }
pub fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> { serde_json::from_slice(bytes).map_err(|e| bad(e.to_string())) }
pub fn encode<T: Serialize>(data: &T) -> Result<Vec<u8>> { serde_json::to_vec(data).map_err(|e| bad(e.to_string())) }
pub fn command_digest(command: &Command) -> Result<Vec<u8>> { Ok(blake3::hash(&encode(command)?).as_bytes().to_vec()) }
pub fn artifact_key(id: &str) -> String { format!("artifact:{id}") }
pub fn session_key(id: &str) -> String { format!("session:{id}") }
pub fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 100 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') }
pub fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 192 && key.as_bytes()[0].is_ascii_alphanumeric()
        && key.bytes().all(|c| c.is_ascii_alphanumeric() || b":._/-".contains(&c))
        && !key.split([':', '.', '/']).any(|s| matches!(s, "__proto__" | "prototype" | "constructor"))
}
fn object_only<'a>(value:&'a Value,allowed:&[&str])->Result<&'a serde_json::Map<String,Value>> {let obj=value.as_object().ok_or_else(||bad("Expected an object"))?;if obj.keys().any(|k|!allowed.contains(&k.as_str())){return Err(bad("Unsupported object property"));}Ok(obj)}
fn text_bound(value:Option<&Value>,max:usize)->bool{value.and_then(Value::as_str).is_some_and(|v|v.len()<=max)}
fn ids(value:Option<&Value>,max:usize)->Result<Vec<&str>>{let values=value.and_then(Value::as_array).ok_or_else(||bad("Expected an id list"))?;if values.is_empty()||values.len()>max{return Err(bad("Id list exceeds its limit"));}let mut seen=std::collections::HashSet::new();values.iter().map(|v|{let id=v.as_str().filter(|v|valid_id(v)).ok_or_else(||bad("Invalid object id"))?;if !seen.insert(id){return Err(bad("Duplicate object id"));}Ok(id)}).collect()}
fn reference(value:&Value)->Result<()>{let o=object_only(value,&["sheet","row","col","absRow","absCol"])?;for k in ["sheet","row","col"]{if !o.get(k).and_then(Value::as_str).is_some_and(valid_id){return Err(bad("Invalid formula reference"));}}for k in ["absRow","absCol"]{if !o.get(k).is_some_and(Value::is_boolean){return Err(bad("Invalid reference flag"));}}Ok(())}
fn expression(value:&Value,depth:usize,nodes:&mut usize)->Result<()>{
    *nodes+=1;if depth>64||*nodes>2048{return Err(bad("Formula exceeds the expression limit"));}
    let obj=value.as_object().ok_or_else(||bad("Invalid formula expression"))?;
    let kind=obj.get("type").and_then(Value::as_str).ok_or_else(||bad("Missing expression type"))?;
    let get=|k:&str|obj.get(k).ok_or_else(||bad("Incomplete expression"));
    match kind {
        "value"=>{object_only(value,&["type","value"])?;if !get("value")?.is_string()&&!get("value")?.is_number()&&!get("value")?.is_boolean(){return Err(bad("Invalid scalar"));}},
        "ref"=>{object_only(value,&["type","ref"])?;reference(get("ref")?)?;},
        "range"=>{object_only(value,&["type","from","to"])?;reference(get("from")?)?;reference(get("to")?)?;},
        "unary"=>{object_only(value,&["type","op","right"])?;if !["+","-","%"].contains(&get("op")?.as_str().unwrap_or("")){return Err(bad("Unsupported operator"));}expression(get("right")?,depth+1,nodes)?;},
        "binary"=>{object_only(value,&["type","op","left","right"])?;if !["+","-","*","/","^","&","=","<>","<",">","<=",">="].contains(&get("op")?.as_str().unwrap_or("")){return Err(bad("Unsupported operator"));}expression(get("left")?,depth+1,nodes)?;expression(get("right")?,depth+1,nodes)?;},
        "call"=>{object_only(value,&["type","name","args"])?;if !["SUM","AVERAGE","MIN","MAX","COUNT","COUNTA","IF","AND","OR","ROUND","COUNTIF","SUMIF"].contains(&get("name")?.as_str().unwrap_or("")){return Err(bad("Unsupported formula function"));}let args=get("args")?.as_array().ok_or_else(||bad("Invalid arguments"))?;for a in args{expression(a,depth+1,nodes)?;}},
        _=>return Err(bad("Unsupported formula expression"))
    }Ok(())
}
pub fn validate_fields(kind: Kind, fields: &Fields) -> Result<()> {
    if fields.len()>MAX_FIELDS||encode(fields)?.len()>MAX_BYTES{return Err(bad("Artifact exceeds the workspace limit"));}
    if !text_bound(fields.get("title"),1000){return Err(bad("A title is required (maximum 1,000 bytes)"));}
    for (key,value) in fields{
        if !valid_key(key){return Err(bad("Invalid field key"));}
        let valid=match kind{
            Kind::Document=>matches!(key.as_str(),"title"|"text"|"format"|"language")&&value.is_string(),
            Kind::Sheet=>matches!(key.as_str(),"title"|"sheets"|"dateSystem")||key.starts_with("s:")||key.starts_with("c:")||key.starts_with("f:")||key.starts_with("chart:"),
            Kind::Deck=>matches!(key.as_str(),"title"|"slides"|"theme"|"aspect")||key.starts_with("slide:")
        };if !valid{return Err(bad(format!("Invalid field for artifact kind: {key}")));}
    }
    match kind{
        Kind::Document=>{
            if !text_bound(fields.get("text"),MAX_BYTES){return Err(bad("Document text is required"));}
            if fields.get("format").is_some_and(|f|!["text","markdown","html","code"].contains(&f.as_str().unwrap_or(""))){return Err(bad("Unsupported document format"));}
        },
        Kind::Sheet=>{
            let sheets=ids(fields.get("sheets"),100)?;let mut dimensions=BTreeMap::new();let mut names=std::collections::HashSet::new();
            for id in &sheets{
                let obj=object_only(fields.get(&format!("s:{id}")).ok_or_else(||bad("Sheet metadata missing"))?,&["name","rows","columns"])?;
                if !text_bound(obj.get("name"),200)||!names.insert(obj["name"].as_str().unwrap().to_lowercase()){return Err(bad("Sheet names must be unique"));}
                dimensions.insert(*id,(ids(obj.get("rows"),100_000)?.into_iter().collect::<std::collections::HashSet<_>>(),ids(obj.get("columns"),256)?.into_iter().collect::<std::collections::HashSet<_>>()));
            }
            if fields.get("dateSystem").is_some_and(|v|!["1900","1904"].contains(&v.as_str().unwrap_or(""))){return Err(bad("Unsupported date system"));}
            for (key,value) in fields{
                if key.starts_with("s:")&&!sheets.contains(&&key[2..]){return Err(bad("Orphaned sheet metadata"));}
                if key.starts_with("c:")||key.starts_with("f:"){
                    let parts=key.split(':').collect::<Vec<_>>();if parts.len()!=4{return Err(bad("Invalid cell key"));}
                    let (rows,columns)=dimensions.get(parts[1]).ok_or_else(||bad("Cell refers to a deleted sheet"))?;
                    if !rows.contains(parts[2])||!columns.contains(parts[3]){return Err(bad("Cell refers to a deleted row or column; recover the competing edit"));}
                    if key.starts_with("c:"){
                        let obj=object_only(value,&["raw","ast","unsupported","cached"])?;
                        if !text_bound(obj.get("raw"),65536){return Err(bad("Cell text exceeds its limit"));}
                        if let Some(ast)=obj.get("ast"){expression(ast,0,&mut 0)?;}
                        if obj.get("unsupported").is_some_and(|v|!v.is_boolean()){return Err(bad("Invalid formula state"));}
                        if obj.get("cached").is_some_and(|v|!v.is_string()&&!v.is_number()&&!v.is_boolean()){return Err(bad("Invalid cached value"));}
                    }else{
                        let obj=object_only(value,&["bold","italic","wrap","format","align","decimals","fill","color","border"])?;
                        for (k,v) in obj{if ["bold","italic","wrap","border"].contains(&k.as_str())&&!v.is_boolean(){return Err(bad("Invalid format flag"));}
                            if ["color","fill"].contains(&k.as_str())&&!v.as_str().is_some_and(|s|s.len()==7&&s.starts_with('#')&&s[1..].bytes().all(|c|c.is_ascii_hexdigit())){return Err(bad("Invalid format color"));}
                            if k=="format"&&!["general","number","currency","percent","date","text"].contains(&v.as_str().unwrap_or("")){return Err(bad("Unsupported number format"));}
                            if k=="align"&&!["left","center","right"].contains(&v.as_str().unwrap_or("")){return Err(bad("Invalid alignment"));}
                            if k=="decimals"&&!v.as_u64().is_some_and(|n|n<=12){return Err(bad("Invalid decimal precision"));}
                        }
                    }
                }
                if key.starts_with("chart:"){let obj=object_only(value,&["title","type","sheet","rows","columns"])?;if !text_bound(obj.get("title"),1000)||!["bar","line","pie"].contains(&obj.get("type").and_then(Value::as_str).unwrap_or("")){return Err(bad("Invalid chart"));}if !obj.get("sheet").and_then(Value::as_str).is_some_and(|s|sheets.contains(&s)){return Err(bad("Chart sheet is missing"));}ids(obj.get("rows"),1000)?;ids(obj.get("columns"),20)?;}
            }
        },
        Kind::Deck=>{
            let slides=ids(fields.get("slides"),300)?;
            if fields.get("theme").is_some_and(|v|!["paper","night","sage"].contains(&v.as_str().unwrap_or(""))){return Err(bad("Unsupported slide theme"));}
            if fields.get("aspect").is_some_and(|v|!v.as_f64().is_some_and(|n|n>=0.5&&n<=3.0)){return Err(bad("Invalid slide aspect ratio"));}
            for id in slides{
                let obj=object_only(fields.get(&format!("slide:{id}")).ok_or_else(||bad("Slide is missing"))?,&["title","body","layout","image","hidden"])?;
                if !text_bound(obj.get("title"),2000)||!text_bound(obj.get("body"),50000)||!["title","body","image","split"].contains(&obj.get("layout").and_then(Value::as_str).unwrap_or("")){return Err(bad("Invalid slide"));}
                if obj.get("hidden").is_some_and(|v|!v.is_boolean()){return Err(bad("Invalid hidden slide flag"));}
                if let Some(v)=obj.get("image"){if !v.is_null()&&!v.as_str().is_some_and(valid_image){return Err(bad("Slide images must be bounded raster data, not external URLs"));}}
            }
            for (key,value) in fields{if key.starts_with("slide:"){object_only(value,&["title","body","layout","image","hidden"])?;}}
        }
    }Ok(())
}
pub fn valid_image(s:&str)->bool{s.len()<=4*1024*1024&&["data:image/png;base64,","data:image/jpeg;base64,","data:image/webp;base64,"].iter().any(|prefix|s.starts_with(prefix))&&s.split_once(',').is_some_and(|(_,b)|!b.is_empty()&&b.bytes().all(|c|c.is_ascii_alphanumeric()||b"+/=\r\n".contains(&c)))}
pub fn patch_text(text:&str,p:&TextPatch)->Result<String>{let mut chars=text.chars().collect::<Vec<_>>();if p.start>chars.len()||p.delete>chars.len()-p.start||p.insert.len()>MAX_BYTES{return Err(bad("Invalid text edit span"));}chars.splice(p.start..p.start+p.delete,p.insert.chars());Ok(chars.into_iter().collect())}
pub fn field_version(a: &Artifact, key: &str) -> u64 { *a.versions.get(key).unwrap_or(&0) }
pub fn apply_artifact(a: &mut Artifact, env: &Envelope) -> Result<()> {
    if a.deleted { return Err(bad("Artifact is deleted")); }
    let next = a.revision.checked_add(1).filter(|n| *n < 9_007_199_254_740_991).ok_or_else(|| bad("Revision exhausted"))?;
    match &env.command {
        Command::Change { generation, changes } => {
            if *generation != a.generation || changes.is_empty() || changes.len() > 4096 { return Err(bad("Invalid generation or change batch")); }
            let mut keys = std::collections::BTreeSet::new();
            for c in changes {
                if !keys.insert(&c.key) || !valid_key(&c.key) || field_version(a, &c.key) != c.expected { return Err(bad(format!("Conflicting field: {}", c.key))); }
            }
            for c in changes {
                if let Some(patch)=&c.text_patch{if a.kind!=Kind::Document||c.key!="text"||c.remove||!c.value.is_null(){return Err(bad("Text spans only edit document text"));}let old=a.fields.get("text").and_then(Value::as_str).ok_or_else(||bad("Text field missing"))?;a.fields.insert("text".into(),Value::String(patch_text(old,patch)?));}
                else if c.remove { a.fields.remove(&c.key); } else { a.fields.insert(c.key.clone(), c.value.clone()); }
                a.versions.insert(c.key.clone(), next);
            }
            validate_fields(a.kind, &a.fields)?;
        }
        Command::Permissions {revision, grants, channel_id, channel_access} => {
            if *revision != a.revision || grants.len()>256 { return Err(bad("Permission revision conflict")); }
            a.grants=grants.clone();a.channel_id=channel_id.clone();a.channel_access=*channel_access;
            a.generation+=1;
        }
        Command::SetMode {generation, mode} => {
            if *generation!=a.generation{return Err(bad("Mode revision conflict"));}a.mode=*mode;a.generation+=1;
        }
        Command::AddReview {review} => {
            if a.reviews.len()>=500 || a.reviews.iter().any(|r|r.id==review.id) {return Err(bad("Review limit or duplicate"));}
            if review.body.len()>16000||encode(&review.proposal)?.len()>1024*1024||!valid_id(&review.id){return Err(bad("Review exceeds its limit"));}
            a.reviews.push(review.clone());
        }
        Command::ReviewStatus {review_id,status} => {
            let i=a.reviews.iter().position(|r|&r.id==review_id).ok_or_else(||bad("Review not found"))?;
            if !["open","resolved","accepted","rejected"].contains(&status.as_str()) {return Err(bad("Invalid review status"));}
            if status=="accepted" {
                let r=&a.reviews[i];let key=r.field.as_ref().ok_or_else(||bad("Suggestion has no target"))?;
                if !r.is_suggestion || r.status!="open" || field_version(a,key)!=r.base_field_version {return Err(bad("Suggestion needs rebase"));}
                a.fields.insert(key.clone(),r.proposal.clone().ok_or_else(||bad("Suggestion has no proposal"))?);a.versions.insert(key.clone(),next);
                validate_fields(a.kind,&a.fields)?;
            }
            if a.reviews[i].status=="accepted" && status!="accepted" {return Err(bad("Accepted suggestions cannot be reopened"));}
            a.reviews[i].status=status.clone();
        }
        Command::Delete {revision} => {if *revision!=a.revision{return Err(bad("Delete revision conflict"));}a.deleted=true;a.generation+=1;}
        _ => return Err(bad("Not an artifact mutation")),
    }
    if encode(&a)?.len()>48*1024*1024{return Err(bad("Artifact history exceeds its limit"));}
    a.revision=next;a.updated_at=env.at;Ok(())
}
pub fn apply_control(s:&mut Presentation, env:&Envelope) -> Result<()> {
    if let Command::UpdatePresentation{generation,sequence,title,pages,slide_id}=&env.command{if s.ended||*generation!=s.generation||*sequence!=s.sequence||!pages.iter().any(|p|&p.id==slide_id){return Err(bad("Presentation revision conflict"));}s.title=title.clone();s.pages=pages.clone();s.slide_id=slide_id.clone();s.generation+=1;s.sequence+=1;s.updated_at=env.at;return Ok(());}
    let Command::Control{generation,sequence,slide_id,controller_id,blank,end}=&env.command else{return Err(bad("Not a controller command"));};
    if s.ended || s.generation!=*generation || s.sequence!=*sequence {return Err(bad("Stale controller command"));}
    if let Some(id)=slide_id {if !s.pages.iter().any(|p|&p.id==id){return Err(bad("Slide is not in the audience rendition"));}s.slide_id=id.clone();}
    if let Some(id)=controller_id{s.controller_id=*id;s.generation+=1;}
    if let Some(blank)=blank{s.blank=*blank;}s.ended=*end;s.sequence+=1;s.updated_at=env.at;Ok(())
}
pub struct WorkspaceProjection;
impl Projection for WorkspaceProjection {
    fn event_type(&self)->&str{EVENT}
    fn apply(&self,event:&DurableEvent,state:&ProjectionState)->Result<()> {
        let env:Envelope=decode(&event.payload)?;
        if env.v!=1 || !valid_id(&env.id) || !valid_id(&env.op_id) || env.actor<=0 {return Err(bad("Invalid workspace envelope"));}
        let receipt=format!("receipt:{}:{}:{}",env.id,env.actor,env.op_id);
        if let Some(prior)=state.get(INDEX,receipt.as_bytes()){if prior!=command_digest(&env.command)?{return Err(bad("Conflicting replay receipt"));}return Ok(());}
        match &env.command {
            Command::Create{artifact}=>{
                let key=artifact_key(&env.id);
                if artifact.v!=1 || artifact.id!=env.id || artifact.owner_id!=env.actor || artifact.revision!=1 || state.get(INDEX,key.as_bytes()).is_some(){return Err(bad("Invalid creation"));}
                validate_fields(artifact.kind,&artifact.fields)?;
                store_artifact(state,artifact,event.commit_seq)?;
            }
            Command::Start{presentation}=>{
                let key=session_key(&env.id);
                if presentation.id!=env.id || presentation.owner_id!=env.actor || state.get(INDEX,key.as_bytes()).is_some(){return Err(bad("Invalid presentation creation"));}
                state.insert(INDEX,key.into_bytes(),encode(presentation)?,event.commit_seq);
            }
            Command::Control{..}|Command::UpdatePresentation{..}=>{
                let key=session_key(&env.id);let bytes=state.get(INDEX,key.as_bytes()).ok_or_else(||bad("Session missing"))?;
                let mut s:Presentation=decode(&bytes)?;apply_control(&mut s,&env)?;state.insert(INDEX,key.into_bytes(),encode(&s)?,event.commit_seq);
            }
            Command::Configure{capabilities}=>{state.insert(INDEX,b"policy".to_vec(),encode(capabilities)?,event.commit_seq);}
            _=>{
                let key=artifact_key(&env.id);let bytes=state.get(INDEX,key.as_bytes()).ok_or_else(||bad("Artifact missing"))?;
                let mut a:Artifact=decode(&bytes)?;apply_artifact(&mut a,&env)?;store_artifact(state,&a,event.commit_seq)?;
            }
        }
        // Receipt binds the request bytes. The API rejects reuse with another command.
        state.insert(INDEX,receipt.into_bytes(),command_digest(&env.command)?,event.commit_seq);Ok(())
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    fn artifact()->Artifact{Artifact{v:1,id:"test".into(),kind:Kind::Document,owner_id:1,channel_id:None,channel_access:Access::Viewer,grants:BTreeMap::new(),revision:1,generation:1,mode:Mode::Live,fields:BTreeMap::from([("title".into(),Value::String("Test".into())),("text".into(),Value::String("Hello".into()))]),versions:BTreeMap::from([("title".into(),1),("text".into(),1)]),reviews:vec![],updated_at:1,deleted:false}}
    fn env(command:Command)->Envelope{Envelope{v:1,id:"test".into(),op_id:"edit".into(),actor:1,at:2,command}}
    #[test]fn independent_fields_merge(){let mut a=artifact();apply_artifact(&mut a,&env(Command::Change{generation:1,changes:vec![Change{key:"title".into(),expected:1,value:"New".into(),remove:false,text_patch:None}]})).unwrap();apply_artifact(&mut a,&env(Command::Change{generation:1,changes:vec![Change{key:"text".into(),expected:1,value:"Other".into(),remove:false,text_patch:None}]})).unwrap();assert_eq!(a.fields["title"],"New");assert_eq!(a.fields["text"],"Other");}
    #[test]fn same_field_and_aba_conflict(){let mut a=artifact();for (expected,value) in [(1,"New"),(2,"Test")]{apply_artifact(&mut a,&env(Command::Change{generation:1,changes:vec![Change{key:"title".into(),expected,value:value.into(),remove:false,text_patch:None}]})).unwrap();}assert!(apply_artifact(&mut a,&env(Command::Change{generation:1,changes:vec![Change{key:"title".into(),expected:1,value:"Old tab".into(),remove:false,text_patch:None}]})).is_err());}
    #[test]fn permission_epoch_rejects_offline_writes(){let mut a=artifact();apply_artifact(&mut a,&env(Command::Permissions{revision:1,grants:BTreeMap::new(),channel_id:None,channel_access:Access::Viewer})).unwrap();assert!(apply_artifact(&mut a,&env(Command::Change{generation:1,changes:vec![Change{key:"text".into(),expected:1,value:"Late".into(),remove:false,text_patch:None}]})).is_err());}
    #[test]fn notes_not_an_editor_field(){let mut a=artifact();a.kind=Kind::Deck;a.fields=BTreeMap::from([("title".into(),"Deck".into()),("slide:one".into(),serde_json::json!({"title":"x","notes":"SECRET"}))]);assert!(validate_fields(a.kind,&a.fields).is_err());}
    #[test]fn projection_replay_deduplicates(){let state=ProjectionState::new();let e=env(Command::Create{artifact:artifact()});let event=DurableEvent{commit_seq:1,stream_id:"workspace:test".into(),event_type:EVENT.into(),payload:encode(&e).unwrap()};WorkspaceProjection.apply(&event,&state).unwrap();WorkspaceProjection.apply(&event,&state).unwrap();let restored:Artifact=decode(&state.get(INDEX,b"artifact:test").unwrap()).unwrap();assert_eq!(restored.revision,1);}
    #[test]fn rejects_schema_and_prototype_keys(){assert!(!valid_key("x:__proto__:value"));let mut a=artifact();a.fields.insert("grants".into(),Value::Null);assert!(validate_fields(a.kind,&a.fields).is_err());}
}
