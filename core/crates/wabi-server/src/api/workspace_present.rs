//! Audience DTOs are constructed field by field. Never serialize the authoring document to viewers.
use axum::{extract::{Path,Query,State},Json,Router};
use serde::{Deserialize,Serialize};use serde_json::{json,Value};
use base64::{engine::general_purpose::STANDARD,Engine};
use super::{workspace::*,workspace_crdt as crdt};
use crate::{auth_extractor::AuthUser,error::AppError,channel_access};
use wabidb::engine::wabi_store::WabiStore;
type Result<T>=std::result::Result<T,AppError>;
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct Slide{pub id:String,pub title:String,pub body:String,pub layout:String,pub image:Option<String>}
fn image_allowed(s:&str)->bool{
    if s.len()>2*1024*1024{return false;}
    let Some((prefix,encoded))=s.split_once(',')else{return false;};
    let Ok(raw)=STANDARD.decode(encoded)else{return false;};
    match prefix{"data:image/png;base64"=>raw.starts_with(b"\x89PNG\r\n\x1a\n"),"data:image/jpeg;base64"=>raw.starts_with(b"\xff\xd8\xff"),"data:image/webp;base64"=>raw.starts_with(b"RIFF")&&raw.get(8..12)==Some(b"WEBP"),_=>false}
}
pub(super) fn validate_deck(v:&Value)->Result<()>{
    if v["schema"]!=1{return Err(bad("Unsupported deck schema"));}
    if v.as_object().is_none_or(|m|m.keys().any(|k|!["schema","aspect","slides"].contains(&k.as_str()))){return Err(bad("Unknown deck property; private notes must remain separate"));}
    let slides=v["slides"].as_object().ok_or_else(||bad("Deck has no slides"))?;
    if slides.len()>200{return Err(bad("Deck slide limit exceeded"));}
    for(id,slide)in slides{valid_id(id)?;let object=slide.as_object().ok_or_else(||bad("Invalid slide"))?;
        if object.keys().any(|key|!["title","body","layout","image","position","removed","hidden"].contains(&key.as_str())){return Err(bad("Private notes and unknown slide fields cannot be published"));}
        for(k,max)in [("title",2000),("body",16000)]{if slide.get(k).is_some_and(|x|x.as_str().is_none_or(|s|s.len()>max)){return Err(bad("Slide text exceeds limits"));}}
        if let Some(image)=slide.get("image"){if !image.is_null()&&image.as_str().is_none_or(|s|!image_allowed(s)){return Err(bad("Only bounded inline PNG, JPEG, or WebP images are supported"));}}
        if slide.get("position").is_some_and(|x|x.as_f64().is_none_or(|n|!n.is_finite())){return Err(bad("Invalid slide position"));}
        if slide.get("hidden").is_some_and(|x|!x.is_boolean())||slide.get("removed").is_some_and(|x|!x.is_boolean()){return Err(bad("Invalid slide visibility"));}
    }Ok(())
}
pub(super) fn rendition(v:&Value)->Result<Vec<Slide>>{
    validate_deck(v)?;let mut slides:Vec<_>=v["slides"].as_object().unwrap().iter().filter(|(_,s)|s["removed"]!=true&&s["hidden"]!=true).collect();
    slides.sort_by(|(ai,a),(bi,b)|a["position"].as_f64().unwrap_or(0.0).total_cmp(&b["position"].as_f64().unwrap_or(0.0)).then_with(||ai.cmp(bi)));
    if slides.is_empty()||slides.len()>100{return Err(bad("A presentation needs 1–100 visible slides"));}
    Ok(slides.into_iter().map(|(id,s)|Slide{id:id.clone(),title:s["title"].as_str().unwrap_or("").into(),body:s["body"].as_str().unwrap_or("").into(),layout:match s["layout"].as_str(){Some(k@("title"|"text"|"image"|"split"|"quote"))=>k,_=>"text"}.into(),image:s["image"].as_str().map(str::to_owned)}).collect())
}
#[derive(Clone,Serialize,Deserialize)]#[serde(rename_all="camelCase")]
struct Session{id:String,artifact_id:String,owner_user_id:u64,channel_id:Option<String>,controller:u64,controller_generation:u64,sequence:u64,slide_id:String,edition:String,slides:Vec<Slide>,source_sequence:u64,blank:bool,paused:bool,ended:bool,instance:String,aspect:f64}
pub(super) fn routes()->Router<WorkspaceState>{Router::new().route("/presentations",axum::routing::post(start)).route("/presentations/{id}",axum::routing::get(read).post(control))}
async fn allowed(s:&WorkspaceState,p:&Session,uid:i64)->Result<()>{
    if p.owner_user_id==uid as u64{return Ok(());}
    if let Some(channel)=&p.channel_id{channel_access::require_access(&s.app,uid,channel).await?;return Ok(());}
    let(_,a)=artifact(s,&p.artifact_id)?;role(s,&a,uid).await.ok_or_else(missing)?;Ok(())
}
fn response(p:&Session,uid:i64,edition:Option<&str>)->Value{json!({"id":p.id,"artifactId":if p.owner_user_id==uid as u64{Some(&p.artifact_id)}else{None},"controller":p.controller,"canControl":p.controller==uid as u64,"generation":p.controller_generation,"sequence":p.sequence,"slideId":p.slide_id,"edition":p.edition,"slides":if edition==Some(p.edition.as_str()){None}else{Some(&p.slides)},"sourceSequence":p.source_sequence,"blank":p.blank,"paused":p.paused,"ended":p.ended,"aspect":p.aspect})}
async fn store(s:&WorkspaceState,row:&wabidb::projections::workspace::WorkspaceRecord,p:&Session,uid:u64)->Result<()>{s.app.wdb.workspace_put(uid,&row.key,row.revision,p.owner_user_id,serialize(p)?).await?;Ok(())}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Start{id:String,artifact_id:String,channel_id:Option<String>,source_sequence:u64}
async fn start(State(s):State<WorkspaceState>,auth:AuthUser,Json(input):Json<Start>)->Result<Json<Value>>{
    admit(&s,&auth).await?;require_cap(&s,"present")?;valid_id(&input.id)?;
    let _membership=s.app.membership_gate.read().await;let _lock=s.runtime.gate.lock().await;
    if let Some(row)=s.app.wdb.workspace_get(&format!("session:{}",input.id))?{let p:Session=deserialize(row.value)?;if p.owner_user_id!=auth.user_id as u64{return Err(missing());}return Ok(Json(response(&p,auth.user_id,None)));}
    let(_,a)=artifact(&s,&input.artifact_id)?;if a.kind!="present"||role(&s,&a,auth.user_id).await.is_none_or(|r|r<Role::Editor){return Err(missing());}
    if a.sequence!=input.source_sequence{return Err(AppError::Conflict("Deck changed; preview the current revision before presenting".into()));}
    if let Some(channel)=&input.channel_id{let c=channel_access::require_access(&s.app,auth.user_id,channel).await?;if channel_access::is_conversation(c.channel_kind){return Err(bad("Plaintext presentation sharing is unavailable in encrypted/private conversations"));}}
    if s.app.wdb.workspace_list("session:")?.iter().filter(|r|r.owner_user_id==auth.user_id as u64).count()>=1000{return Err(bad("Presentation record limit reached"));}
    let copy=a.clone();let(slides,aspect)=tokio::task::spawn_blocking(move||{let doc=crdt::load(&copy)?;let data=crdt::data(&doc)?;let ratio=data["aspect"].as_f64().unwrap_or(16.0/9.0);Ok::<_,AppError>((rendition(&data)?,ratio.clamp(0.5,3.0)))}).await.map_err(|_|bad("Invalid deck"))??;
    let p=Session{id:input.id,artifact_id:a.id,owner_user_id:auth.user_id as u64,channel_id:input.channel_id,controller:auth.user_id as u64,controller_generation:1,sequence:1,slide_id:slides[0].id.clone(),edition:uuid::Uuid::new_v4().to_string(),slides,source_sequence:a.sequence,blank:false,paused:false,ended:false,instance:s.runtime.instance.clone(),aspect};
    s.app.wdb.workspace_put(auth.user_id as u64,&format!("session:{}",p.id),0,p.owner_user_id,serialize(&p)?).await?;
    Ok(Json(response(&p,auth.user_id,None)))
}
#[derive(Deserialize)]struct Read{edition:Option<String>}
async fn read(State(s):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Query(q):Query<Read>)->Result<Json<Value>>{
    admit(&s,&auth).await?;require_cap(&s,"present")?;valid_id(&id)?;let _membership=s.app.membership_gate.read().await;let _lock=s.runtime.gate.lock().await;
    let row=s.app.wdb.workspace_get(&format!("session:{id}"))?.ok_or_else(missing)?;let mut p:Session=deserialize(row.value.clone())?;allowed(&s,&p,auth.user_id).await?;
    if p.instance!=s.runtime.instance&&!p.ended{p.paused=true;p.controller_generation+=1;p.sequence+=1;p.instance=s.runtime.instance.clone();store(&s,&row,&p,auth.user_id as u64).await?;}
    Ok(Json(response(&p,auth.user_id,q.edition.as_deref())))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Control{action:String,generation:u64,sequence:u64,slide_id:Option<String>,target_user_id:Option<u64>,source_sequence:Option<u64>}
async fn control(State(s):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(input):Json<Control>)->Result<Json<Value>>{
    admit(&s,&auth).await?;require_cap(&s,"present")?;valid_id(&id)?;let _membership=s.app.membership_gate.read().await;let _lock=s.runtime.gate.lock().await;
    let row=s.app.wdb.workspace_get(&format!("session:{id}"))?.ok_or_else(missing)?;let mut p:Session=deserialize(row.value.clone())?;allowed(&s,&p,auth.user_id).await?;
    let may_end=input.action=="end"&&(auth.user_id as u64==p.owner_user_id||s.app.is_admin(auth.user_id).await);
    if auth.user_id as u64!=p.controller&&!may_end{return Err(AppError::Forbidden("Only the current presenter can control slides".into()));}
    if input.generation!=p.controller_generation||input.sequence!=p.sequence||p.instance!=s.runtime.instance{return Err(AppError::Conflict("Presentation state changed; refresh before controlling".into()));}
    if p.ended{return Err(bad("Presentation has ended"));}
    match input.action.as_str(){
        "slide"=>{let slide=input.slide_id.ok_or_else(||bad("Slide required"))?;if !p.slides.iter().any(|s|s.id==slide){return Err(bad("Slide is not published to this audience"));}p.slide_id=slide;},
        "blank"=>p.blank=!p.blank,"pause"=>p.paused=true,"resume"=>p.paused=false,"end"=>{p.ended=true;p.paused=true;},
        "handoff"=>{let uid=input.target_user_id.ok_or_else(||bad("Presenter required"))?;let user=s.app.wdb.get_user(uid).await?.ok_or_else(missing)?;if !user.is_active||user.password_hash.is_empty(){return Err(missing());}allowed(&s,&p,uid as i64).await?;p.controller=uid;p.controller_generation+=1;},
        "update"=>{let(_,a)=artifact(&s,&p.artifact_id)?;if role(&s,&a,auth.user_id).await.is_none_or(|r|r<Role::Editor){return Err(missing());}if input.source_sequence!=Some(a.sequence){return Err(AppError::Conflict("Preview the latest deck before updating".into()));}let copy=a.clone();let slides=tokio::task::spawn_blocking(move||rendition(&crdt::data(&crdt::load(&copy)?)?)).await.map_err(|_|bad("Invalid deck"))??;let target=input.slide_id.unwrap_or(p.slide_id.clone());if !slides.iter().any(|s|s.id==target){return Err(AppError::Conflict("Current slide was removed; choose a replacement".into()));}p.slide_id=target;p.slides=slides;p.edition=uuid::Uuid::new_v4().to_string();p.source_sequence=a.sequence;},
        _=>return Err(bad("Unknown presentation action")),
    }
    p.sequence+=1;store(&s,&row,&p,auth.user_id as u64).await?;Ok(Json(response(&p,auth.user_id,None)))
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn audience_payload_excludes_hidden_slides_and_rejects_notes(){
        let id=uuid::Uuid::new_v4().to_string();let hidden=uuid::Uuid::new_v4().to_string();
        let mut v=json!({"schema":1,"slides":{}});v["slides"][&id]=json!({"title":"Visible","body":"Body","position":0});v["slides"][&hidden]=json!({"title":"SECRET","body":"hidden","hidden":true,"position":1});
        let result=rendition(&v).unwrap();assert_eq!(result.len(),1);assert!(!serde_json::to_string(&result).unwrap().contains("SECRET"));
        v["slides"][&id]["notes"]=json!("PRIVATE");assert!(rendition(&v).is_err());
    }
    #[test]fn external_and_svg_images_are_rejected(){assert!(!image_allowed("https://example.test/tracker.png"));assert!(!image_allowed("data:image/svg+xml;base64,PHN2Zz4="));assert!(!image_allowed("data:image/png;base64,eA=="));}
}
