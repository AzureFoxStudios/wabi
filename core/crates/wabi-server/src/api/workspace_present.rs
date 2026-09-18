//! Audience DTOs are explicit. Private notes never enter shared deck/session
//! payloads. Controller leases and pointers are ephemeral, not durable polling.
use axum::{extract::{Path,Query,State},Json,Router};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use base64::{engine::general_purpose::STANDARD,Engine};
use std::time::{Duration,Instant};
use super::{workspace::*,workspace_crdt as crdt};
use crate::{auth_extractor::AuthUser,error::AppError,channel_access};
use wabidb::{engine::wabi_store::WabiStore,projections::workspace::WorkspaceRecord};
type Result<T>=std::result::Result<T,AppError>;
const LEASE:Duration=Duration::from_secs(15);
#[path="workspace_scene.rs"]mod scene;
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct Slide{pub id:String,pub title:String,pub body:String,pub layout:String,pub image:Option<String>,#[serde(default,skip_serializing_if="Option::is_none")]pub design:Option<scene::Design>}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct Pointer{pub x:f64,pub y:f64,pub slide_id:String}
pub(super) struct Presence{generation:u64,seen:Instant,pointer:Option<Pointer>,pointer_at:Instant}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Question{id:String,slide_id:String,author_user_id:u64,author_name:String,body:String,created_at:u64,resolved:bool}
fn image_allowed(image:&str)->bool{
    if image.len()>2*1024*1024{return false;}let Some((prefix,encoded))=image.split_once(',')else{return false;};let Ok(raw)=STANDARD.decode(encoded)else{return false;};
    match prefix{"data:image/png;base64"=>raw.starts_with(b"\x89PNG\r\n\x1a\n"),"data:image/jpeg;base64"=>raw.starts_with(b"\xff\xd8\xff"),"data:image/webp;base64"=>raw.starts_with(b"RIFF")&&raw.get(8..12)==Some(b"WEBP"),_=>false}
}
pub(super) fn validate_deck(value:&Value)->Result<()>{
    if value["schema"].as_f64()!=Some(1.0){return Err(bad("Unsupported deck schema"));}
    if value.as_object().is_none_or(|map|map.keys().any(|key|!["schema","aspect","slides"].contains(&key.as_str()))){return Err(bad("Unknown deck property; private notes must remain separate"));}
    if !value["aspect"].is_null()&&value["aspect"].as_f64().is_none_or(|ratio|!ratio.is_finite()||!(0.5..=3.0).contains(&ratio)){return Err(bad("Invalid slide aspect ratio"));}
    let slides=value["slides"].as_object().ok_or_else(||bad("Deck has no slides"))?;if slides.len()>200{return Err(bad("Deck slide limit exceeded"));}
    for(id,slide)in slides{
        valid_id(id)?;let object=slide.as_object().ok_or_else(||bad("Invalid slide"))?;
        if object.keys().any(|key|!["title","body","layout","image","position","removed","hidden","design"].contains(&key.as_str())){return Err(bad("Private notes and unknown slide fields cannot be published"));}
        for(key,max)in[("title",2000),("body",16000)]{if slide.get(key).is_some_and(|value|value.as_str().is_none_or(|text|text.len()>max)){return Err(bad("Slide text exceeds limits"));}}
        if let Some(image)=slide.get("image"){if !image.is_null()&&image.as_str().is_none_or(|image|!image_allowed(image)){return Err(bad("Only bounded inline PNG, JPEG, or WebP images are supported"));}}
        if let Some(design)=slide.get("design"){scene::project(design)?;}
        if slide["layout"]=="canvas"&&slide.get("design").is_none(){return Err(bad("Canvas slide requires a native design"));}
        if slide.get("position").is_some_and(|value|value.as_f64().is_none_or(|n|!n.is_finite())){return Err(bad("Invalid slide position"));}
        if slide.get("hidden").is_some_and(|value|!value.is_boolean())||slide.get("removed").is_some_and(|value|!value.is_boolean()){return Err(bad("Invalid slide visibility"));}
        if slide.get("layout").is_some_and(|value|!["title","text","image","split","quote","canvas"].contains(&value.as_str().unwrap_or(""))){return Err(bad("Unsupported slide layout"));}
    }Ok(())
}
pub(super) fn rendition(value:&Value)->Result<Vec<Slide>>{
    validate_deck(value)?;let mut slides:Vec<_>=value["slides"].as_object().unwrap().iter().filter(|(_,slide)|slide["removed"]!=true&&slide["hidden"]!=true).collect();
    slides.sort_by(|(ai,a),(bi,b)|a["position"].as_f64().unwrap_or(0.0).total_cmp(&b["position"].as_f64().unwrap_or(0.0)).then_with(||ai.cmp(bi)));
    if slides.is_empty()||slides.len()>100{return Err(bad("A presentation needs 1–100 visible slides"));}
    slides.into_iter().map(|(id,slide)|{
        let canvas=slide["layout"]=="canvas";
        Ok(Slide{id:id.clone(),title:slide["title"].as_str().unwrap_or("").into(),
            body:if canvas{String::new()}else{slide["body"].as_str().unwrap_or("").into()},
            layout:slide["layout"].as_str().unwrap_or("text").into(),
            image:if canvas{None}else{slide["image"].as_str().map(str::to_owned)},
            design:if canvas{Some(scene::audience(&slide["design"])?)}else{None}})
    }).collect()
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Session{
    id:String,artifact_id:String,owner_user_id:u64,channel_id:Option<String>,controller:u64,
    controller_generation:u64,sequence:u64,slide_id:String,edition:String,slides:Vec<Slide>,
    source_sequence:u64,blank:bool,paused:bool,ended:bool,instance:String,aspect:f64,
    #[serde(default)]controller_lost:bool,#[serde(default)]questions:Vec<Question>,
}
pub(super) fn routes()->Router<WorkspaceState>{
    Router::new().route("/presentations",axum::routing::post(start))
        .route("/presentations/{id}",axum::routing::get(read).post(control))
        .route("/presentations/{id}/heartbeat",axum::routing::post(heartbeat))
        .route("/presentations/{id}/questions",axum::routing::post(question))
}
async fn allowed(state:&WorkspaceState,session:&Session,user:i64)->Result<()>{
    if session.owner_user_id==user as u64{return Ok(());}
    if let Some(channel)=&session.channel_id{channel_access::require_access(&state.app,user,channel).await?;return Ok(());}
    let(_,artifact)=artifact(state,&session.artifact_id)?;role(state,&artifact,user).await.ok_or_else(missing)?;Ok(())
}
async fn renew(state:&WorkspaceState,session:&Session,pointer:Option<Pointer>){
    let mut active=state.runtime.presentations.lock().await;
    active.retain(|_,presence|presence.seen.elapsed()<Duration::from_secs(60));
    if active.len()>=4096&&!active.contains_key(&session.id){return;}
    active.insert(session.id.clone(),Presence{generation:session.controller_generation,seen:Instant::now(),pointer,pointer_at:Instant::now()});
}
async fn response(state:&WorkspaceState,session:&Session,user:i64,edition:Option<&str>)->Value{
    let active=state.runtime.presentations.lock().await;
    let presence=active.get(&session.id).filter(|presence|presence.generation==session.controller_generation&&presence.seen.elapsed()<LEASE);
    let connected=presence.is_some()&&!session.controller_lost&&!session.ended;
    let pointer=presence.filter(|presence|presence.pointer_at.elapsed()<Duration::from_secs(3)).and_then(|presence|presence.pointer.clone()).filter(|pointer|pointer.slide_id==session.slide_id);
    json!({"id":session.id,"artifactId":if session.owner_user_id==user as u64{Some(&session.artifact_id)}else{None},"controller":session.controller,"canControl":session.controller==user as u64&&!session.ended,"generation":session.controller_generation,"sequence":session.sequence,"slideId":session.slide_id,"edition":session.edition,"slides":if session.ended{Some(Vec::<Slide>::new())}else if edition==Some(session.edition.as_str()){None}else{Some(session.slides.clone())},"sourceSequence":session.source_sequence,"blank":session.blank,"paused":session.paused,"ended":session.ended,"aspect":session.aspect,"controllerConnected":connected,"controllerLost":session.controller_lost,"pointer":if connected{pointer}else{None},"questions":session.questions})
}
async fn store(state:&WorkspaceState,row:&WorkspaceRecord,session:&Session,user:u64)->Result<WorkspaceRecord>{state.app.wdb.workspace_put(user,&row.key,row.revision,session.owner_user_id,serialize(session)?).await}
async fn load_current(state:&WorkspaceState,id:&str,user:i64)->Result<(WorkspaceRecord,Session)>{
    let mut row=state.app.wdb.workspace_get(&format!("session:{id}"))?.ok_or_else(missing)?;let mut session:Session=deserialize(row.value.clone())?;allowed(state,&session,user).await?;
    let lost={let active=state.runtime.presentations.lock().await;active.get(id).is_none_or(|presence|presence.generation!=session.controller_generation||presence.seen.elapsed()>=LEASE)};
    if !session.ended&&(session.instance!=state.runtime.instance||(!session.controller_lost&&lost)){
        session.paused=true;session.controller_lost=true;session.controller_generation+=1;session.sequence+=1;session.instance=state.runtime.instance.clone();
        row=store(state,&row,&session,user as u64).await?;state.runtime.presentations.lock().await.remove(id);
    }Ok((row,session))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Start{id:String,artifact_id:String,channel_id:Option<String>,source_sequence:u64}
async fn start(State(state):State<WorkspaceState>,auth:AuthUser,Json(input):Json<Start>)->Result<Json<Value>>{
    admit(&state,&auth).await?;valid_id(&input.id)?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;require_cap(&state,"present")?;
    if state.app.wdb.workspace_get(&format!("session:{}",input.id))?.is_some(){let(_,session)=load_current(&state,&input.id,auth.user_id).await?;if session.owner_user_id!=auth.user_id as u64{return Err(missing());}return Ok(Json(response(&state,&session,auth.user_id,None).await));}
    let(_,artifact)=artifact(&state,&input.artifact_id)?;if artifact.kind!="present"||role(&state,&artifact,auth.user_id).await.is_none_or(|role|role<Role::Editor){return Err(missing());}
    if artifact.sequence!=input.source_sequence{return Err(AppError::Conflict("Deck changed; preview the current revision before presenting".into()));}
    if let Some(channel)=&input.channel_id{let target=channel_access::require_access(&state.app,auth.user_id,channel).await?;if channel_access::is_conversation(target.channel_kind){return Err(bad("Plaintext presentation sharing is unavailable in encrypted/private conversations"));}}
    if state.app.wdb.workspace_list("session:")?.iter().filter(|row|row.owner_user_id==auth.user_id as u64).count()>=1000{return Err(bad("Presentation record limit reached"));}
    let copy=artifact.clone();let(slides,aspect)=tokio::task::spawn_blocking(move||{let data=crdt::data(&crdt::load(&copy)?)?;Ok::<_,AppError>((rendition(&data)?,data["aspect"].as_f64().unwrap_or(16.0/9.0)))}).await.map_err(|_|bad("Invalid deck"))??;
    let session=Session{id:input.id,artifact_id:artifact.id,owner_user_id:auth.user_id as u64,channel_id:input.channel_id,controller:auth.user_id as u64,controller_generation:1,sequence:1,slide_id:slides[0].id.clone(),edition:uuid::Uuid::new_v4().to_string(),slides,source_sequence:artifact.sequence,blank:false,paused:false,ended:false,instance:state.runtime.instance.clone(),aspect,controller_lost:false,questions:vec![]};
    state.app.wdb.workspace_put(auth.user_id as u64,&format!("session:{}",session.id),0,session.owner_user_id,serialize(&session)?).await?;renew(&state,&session,None).await;
    Ok(Json(response(&state,&session,auth.user_id,None).await))
}
#[derive(Deserialize)]struct Read{edition:Option<String>}
async fn read(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Query(query):Query<Read>)->Result<Json<Value>>{
    admit(&state,&auth).await?;valid_id(&id)?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;require_cap(&state,"present")?;
    let(_,session)=load_current(&state,&id,auth.user_id).await?;Ok(Json(response(&state,&session,auth.user_id,query.edition.as_deref()).await))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Beat{generation:u64,pointer:Option<Pointer>}
async fn heartbeat(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(input):Json<Beat>)->Result<Json<Value>>{
    admit(&state,&auth).await?;valid_id(&id)?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;require_cap(&state,"present")?;
    let(_,session)=load_current(&state,&id,auth.user_id).await?;
    if session.controller!=auth.user_id as u64{return Err(AppError::Forbidden("Only the current presenter may send a heartbeat".into()));}
    if session.ended||session.controller_lost||input.generation!=session.controller_generation{return Err(AppError::Conflict("Refresh and explicitly resume the current presentation".into()));}
    if let Some(pointer)=&input.pointer{if !pointer.x.is_finite()||!pointer.y.is_finite()||!(0.0..=1.0).contains(&pointer.x)||!(0.0..=1.0).contains(&pointer.y)||pointer.slide_id!=session.slide_id{return Err(bad("Pointer is outside the current published slide"));}}
    renew(&state,&session,input.pointer).await;Ok(Json(json!({"accepted":true,"generation":session.controller_generation})))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Control{action:String,generation:u64,sequence:u64,slide_id:Option<String>,target_user_id:Option<u64>,source_sequence:Option<u64>}
async fn control(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(input):Json<Control>)->Result<Json<Value>>{
    admit(&state,&auth).await?;valid_id(&id)?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;require_cap(&state,"present")?;
    let(row,mut session)=load_current(&state,&id,auth.user_id).await?;
    let may_end=input.action=="end"&&(auth.user_id as u64==session.owner_user_id||state.app.is_admin(auth.user_id).await);
    let owner_recovery=input.action=="handoff"&&session.controller_lost&&auth.user_id as u64==session.owner_user_id;
    if auth.user_id as u64!=session.controller&&!may_end&&!owner_recovery{return Err(AppError::Forbidden("Only the current presenter can control slides".into()));}
    if input.generation!=session.controller_generation||input.sequence!=session.sequence{return Err(AppError::Conflict("Presentation state changed; refresh before controlling".into()));}
    if session.ended{return Err(bad("Presentation has ended"));}
    if session.controller_lost&&!["resume","handoff","end"].contains(&input.action.as_str()){return Err(AppError::Conflict("The presenter disconnected. Resume or hand off explicitly".into()));}
    match input.action.as_str(){
        "slide"=>{let slide=input.slide_id.ok_or_else(||bad("Slide required"))?;if !session.slides.iter().any(|item|item.id==slide){return Err(bad("Slide is not published to this audience"));}session.slide_id=slide;},
        "blank"=>session.blank=!session.blank,"pause"=>session.paused=true,
        "resume"=>{session.paused=false;session.controller_lost=false;},
        "end"=>{session.ended=true;session.paused=true;},
        "handoff"=>{let user=input.target_user_id.ok_or_else(||bad("Presenter required"))?;let account=state.app.wdb.get_user(user).await?.ok_or_else(missing)?;if !account.is_active||account.password_hash.is_empty(){return Err(missing());}allowed(&state,&session,user as i64).await?;session.controller=user;session.controller_generation+=1;session.controller_lost=false;},
        "update"=>{
            let(_,artifact)=artifact(&state,&session.artifact_id)?;if role(&state,&artifact,auth.user_id).await.is_none_or(|role|role<Role::Editor){return Err(missing());}
            if input.source_sequence!=Some(artifact.sequence){return Err(AppError::Conflict("Preview the latest deck before updating".into()));}
            let copy=artifact.clone();let(slides,aspect)=tokio::task::spawn_blocking(move||{let data=crdt::data(&crdt::load(&copy)?)?;Ok::<_,AppError>((rendition(&data)?,data["aspect"].as_f64().unwrap_or(16.0/9.0)))}).await.map_err(|_|bad("Invalid deck"))??;
            let target=input.slide_id.unwrap_or(session.slide_id.clone());if !slides.iter().any(|slide|slide.id==target){return Err(AppError::Conflict("Current slide was removed; choose a replacement".into()));}
            session.slide_id=target;session.slides=slides;session.aspect=aspect;session.edition=uuid::Uuid::new_v4().to_string();session.source_sequence=artifact.sequence;
        },
        _=>return Err(bad("Unknown presentation action")),
    }
    session.sequence+=1;store(&state,&row,&session,auth.user_id as u64).await?;
    if session.ended{state.runtime.presentations.lock().await.remove(&session.id);}else{renew(&state,&session,None).await;}
    Ok(Json(response(&state,&session,auth.user_id,None).await))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct QuestionAction{action:String,id:String,slide_id:Option<String>,body:Option<String>}
async fn question(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(input):Json<QuestionAction>)->Result<Json<Value>>{
    admit(&state,&auth).await?;valid_id(&id)?;valid_id(&input.id)?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;require_cap(&state,"present")?;
    let(row,mut session)=load_current(&state,&id,auth.user_id).await?;
    if session.ended{return Err(bad("Presentation has ended"));}
    if input.action=="add"{
        if let Some(question)=session.questions.iter().find(|question|question.id==input.id){if question.author_user_id!=auth.user_id as u64{return Err(bad("Question ID is already in use"));}return Ok(Json(response(&state,&session,auth.user_id,None).await));}
        let slide=input.slide_id.ok_or_else(||bad("Select a slide for this question"))?;let body=input.body.unwrap_or_default();
        if !session.slides.iter().any(|item|item.id==slide)||body.trim().is_empty()||body.len()>8192||session.questions.len()>=300{return Err(bad("Question or published slide exceeds the supported limits"));}
        session.questions.push(Question{id:input.id,slide_id:slide,author_user_id:auth.user_id as u64,author_name:auth.username,body,created_at:now(),resolved:false});
    }else{
        let question=session.questions.iter_mut().find(|question|question.id==input.id).ok_or_else(missing)?;
        if auth.user_id as u64!=question.author_user_id&&auth.user_id as u64!=session.controller&&auth.user_id as u64!=session.owner_user_id{return Err(AppError::Forbidden("Only the author or presenter can resolve a question".into()));}
        match input.action.as_str(){"resolve"=>question.resolved=true,"reopen"=>question.resolved=false,_=>return Err(bad("Unknown question action"))}
    }
    session.sequence+=1;store(&state,&row,&session,auth.user_id as u64).await?;Ok(Json(response(&state,&session,auth.user_id,None).await))
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn audience_payload_excludes_hidden_slides_and_rejects_notes(){
        let id=uuid::Uuid::new_v4().to_string();let hidden=uuid::Uuid::new_v4().to_string();let mut value=json!({"schema":1,"slides":{}});
        value["slides"][&id]=json!({"title":"Visible","body":"Body","position":0});value["slides"][&hidden]=json!({"title":"SECRET","body":"hidden","hidden":true,"position":1});
        let result=rendition(&value).unwrap();assert_eq!(result.len(),1);assert!(!serde_json::to_string(&result).unwrap().contains("SECRET"));value["slides"][&id]["notes"]=json!("PRIVATE");assert!(rendition(&value).is_err());
    }
    #[test]fn external_and_svg_images_are_rejected(){assert!(!image_allowed("https://example.test/tracker.png"));assert!(!image_allowed("data:image/svg+xml;base64,PHN2Zz4="));assert!(!image_allowed("data:image/png;base64,eA=="));}
    #[test]fn workspace_controller_lease_expires_without_client_wall_clocks(){let expired=Presence{generation:1,seen:Instant::now()-Duration::from_secs(16),pointer:None,pointer_at:Instant::now()};assert!(expired.seen.elapsed()>=LEASE);}
}
