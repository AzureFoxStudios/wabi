//! Authenticated workspace artifacts. Uses the existing WabiDB command/commit/projection path.
//! No disk sidecar, cloud dependency, automatic upload, or client-controlled ACL fields.
use std::{collections::{BTreeMap, HashMap}, sync::Arc, time::{Instant, SystemTime, UNIX_EPOCH}};
use axum::{extract::{DefaultBodyLimit, Path, Query, State}, Extension, Json, Router, routing::{get, post}, response::{IntoResponse, Response}, http::StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use wabidb::{engine::wabi_store::WabiStore, format::record::RecordKind, sequencer::types::{CommandCommit, EventToWrite}, projections::workspace_artifacts as ws};
use crate::{auth_extractor::AuthUser, error::{AppError, Result}, state::AppState};

#[derive(Default)]
struct Runtime {
    // One Authority owns this router. Validation and durable submission are serialized together.
    writer: Mutex<()>,
    heartbeats: std::sync::Mutex<HashMap<String, (i64,u64,Instant,Option<Pointer>)>>,
}
type Run = Extension<Arc<Runtime>>;
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/capabilities",get(capabilities).put(configure))
        .route("/people",get(people))
        .route("/presentations",get(list_presentations).post(start_presentation))
        .route("/presentations/{id}",get(get_presentation))
        .route("/presentations/{id}/control",post(control_presentation))
        .route("/presentations/{id}/revision",axum::routing::put(update_presentation))
        .route("/presentations/{id}/heartbeat",post(heartbeat))
        .route("/{id}",get(read).patch(change).delete(remove))
        .route("/{id}/permissions",axum::routing::put(permissions))
        .route("/{id}/mode",axum::routing::put(set_mode))
        .route("/{id}/reviews",post(review))
        .route("/{id}/reviews/{review_id}",axum::routing::put(review_status))
        .layer(DefaultBodyLimit::max(34*1024*1024))
        .layer(Extension(Arc::new(Runtime::default())))
        .layer(axum::middleware::from_fn(|request: axum::extract::Request, next: axum::middleware::Next| async move {
            let mut response=next.run(request).await;
            response.headers_mut().insert(axum::http::header::CACHE_CONTROL,axum::http::HeaderValue::from_static("private, no-store"));
            response
        }))
        .with_state(state)
}
fn now()->u64 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
fn missing()->AppError{AppError::NotFound("Workspace artifact not found or access removed".into())}
fn invalid(message:impl Into<String>)->AppError{AppError::BadRequest(message.into())}
fn check_id(id:&str)->Result<()>{if ws::valid_id(id){Ok(())}else{Err(invalid("Invalid workspace id"))}}
fn load<T:serde::de::DeserializeOwned>(state:&AppState,key:&str)->Result<Option<T>>{
    state.wdb.engine().projection_state().get(ws::INDEX,key.as_bytes()).map(|b|ws::decode(&b).map_err(AppError::from)).transpose()
}
pub(super) fn policy(state:&AppState)->Result<ws::Capabilities>{Ok(load(state,"policy")?.unwrap_or_default())}
fn require_kind(state:&AppState,kind:ws::Kind)->Result<()>{
    let p=policy(state)?;
    if matches!(kind,ws::Kind::Sheet)&&!p.sheets || matches!(kind,ws::Kind::Deck)&&!p.present {return Err(AppError::Forbidden("This server has not enabled this workspace addon. Local work remains available.".into()));}Ok(())
}
async fn registered(state:&AppState,id:i64)->Result<()>{
    let user=state.wdb.get_user(id as u64).await?;
    if id<=0 || !user.is_some_and(|u|u.is_registered&&u.is_active){return Err(AppError::Forbidden("A registered account is required to publish durable workspace artifacts".into()));}Ok(())
}
async fn ordinary_channel(state:&AppState,user:i64,id:&str)->Result<()>{
    let c=crate::channel_access::require_access(state,user,id).await?;
    if crate::channel_access::is_conversation(c.channel_kind){return Err(AppError::Forbidden("Shared workspace artifacts are server-readable and cannot be published into encrypted/private conversations".into()));}Ok(())
}
async fn access_meta(state:&AppState,user:i64,a:&ws::Metadata)->Result<Option<ws::Access>>{
    if a.deleted{return Ok(None);}if user==a.owner_id{return Ok(Some(ws::Access::Editor));}
    let direct=a.grants.get(&user.to_string()).copied();
    let inherited=if let Some(channel)=&a.channel_id {if crate::channel_access::require_access(state,user,channel).await.is_ok(){Some(a.channel_access)}else{None}}else{None};
    Ok(direct.max(inherited))
}
async fn get_artifact(state:&AppState,user:i64,id:&str)->Result<(ws::Artifact,ws::Access)>{
    check_id(id)?;let a:ws::Artifact=load(state,&ws::artifact_key(id))?.ok_or_else(missing)?;
    let role=access_meta(state,user,&ws::Metadata::from(&a)).await?.ok_or_else(missing)?;Ok((a,role))
}
fn view(mut a:ws::Artifact,role:ws::Access,user:i64)->Value{
    let access=if a.owner_id==user{"owner"}else{match role{ws::Access::Editor=>"editor",ws::Access::Commenter=>"commenter",ws::Access::Viewer=>"viewer"}};
    if a.owner_id!=user{a.grants.clear();}
    json!({"artifact":a,"access":access})
}
async fn validate_grants(state:&AppState,grants:&BTreeMap<String,ws::Access>)->Result<()>{
    if grants.len()>256{return Err(invalid("Too many recipients"));}
    for key in grants.keys(){let id=key.parse::<i64>().map_err(|_|invalid("Invalid recipient"))?;registered(state,id).await?;}Ok(())
}
async fn commit(state:&AppState,id:&str,op_id:&str,actor:i64,command:ws::Command)->Result<()>{
    check_id(id)?;check_id(op_id)?;
    let receipt=format!("receipt:{id}:{actor}:{op_id}");
    if let Some(prior)=state.wdb.engine().projection_state().get(ws::INDEX,receipt.as_bytes()){
        if prior==ws::command_digest(&command)?{return Ok(());}return Err(AppError::Conflict("Operation id was already used for another command".into()));
    }
    let env=ws::Envelope{v:1,id:id.into(),op_id:op_id.into(),actor,at:now(),command};
    let payload=ws::encode(&env)?;
    // Reject oversize events BEFORE the durable writer; a serializer/record
    // failure after submission must never poison the Authority's writer.
    if payload.len() > wabidb::format::record::MAX_PAYLOAD_LEN as usize - 1024 {
        return Err(invalid("This publication exceeds WabiDB's 16 MiB event limit including metadata. Your local copy is unchanged; split the content before sharing."));
    }
    let stream=format!("workspace:{id}");let engine=state.wdb.engine();
    engine.get_or_create_stream_key(&stream).await?;
    engine.run_command(CommandCommit{caller_user_id:actor as u64,caller_device_id:"workspace-v1".into(),command_name:"workspace_artifact_v1".into(),idempotency_key:Some(format!("workspace:{actor}:{id}:{op_id}")),events:vec![EventToWrite{stream_id:stream,event_type:ws::EVENT.into(),stream_kind:1,record_kind:RecordKind::Event,plaintext:payload}],essential:true,response_tx:tokio::sync::oneshot::channel().0}).await?;
    Ok(())
}
fn already_committed(state:&AppState,id:&str,op:&str,actor:i64,command:&ws::Command)->Result<bool>{
    let key=format!("receipt:{id}:{actor}:{op}");
    match state.wdb.engine().projection_state().get(ws::INDEX,key.as_bytes()){
        None=>Ok(false),Some(prior)if prior==ws::command_digest(command)?=>Ok(true),Some(_)=>Err(AppError::Conflict("Operation id collision".into()))
    }
}
#[derive(Deserialize,Default)]
#[serde(rename_all="camelCase")]
struct ReadQuery{since:Option<u64>,after:Option<String>,channel:Option<String>,q:Option<String>}
async fn list(State(state):State<Arc<AppState>>,auth:AuthUser,Query(q):Query<ReadQuery>)->Result<Json<Value>>{
    let mut records=vec![];let mut decode_error=None;
    state.wdb.engine().projection_state().prefix_scan(ws::INDEX,b"meta:",|_,bytes|{match ws::decode::<ws::Metadata>(bytes){Ok(a)=>records.push(a),Err(e)=>{decode_error=Some(e);return;}}});
    if let Some(e)=decode_error{return Err(e.into());}
    let mut items=vec![];
    for a in records {if q.after.as_ref().is_some_and(|s|&a.id<=s)||a.deleted{continue;}if q.channel.as_ref().is_some_and(|s|a.channel_id.as_ref()!=Some(s)){continue;}
        if let Some(role)=access_meta(&state,auth.user_id,&a).await?{items.push(json!({"id":a.id,"kind":a.kind,"title":a.title,"revision":a.revision,"updatedAt":a.updated_at,"mode":a.mode,"access":if a.owner_id==auth.user_id{"owner"}else{match role{ws::Access::Viewer=>"viewer",ws::Access::Commenter=>"commenter",ws::Access::Editor=>"editor"}}}));if items.len()==101{break;}}
    }
    let more=items.len()>100;items.truncate(100);let next=if more{items.last().and_then(|x|x.get("id")).cloned()}else{None};
    Ok(Json(json!({"artifacts":items,"next":next})))
}
async fn read(State(state):State<Arc<AppState>>,auth:AuthUser,Path(id):Path<String>,Query(q):Query<ReadQuery>)->Result<Response>{
    check_id(&id)?;let meta:ws::Metadata=load(&state,&format!("meta:{id}"))?.ok_or_else(missing)?;
    access_meta(&state,auth.user_id,&meta).await?.ok_or_else(missing)?;
    if q.since==Some(meta.revision){return Ok(StatusCode::NO_CONTENT.into_response());}
    let(a,role)=get_artifact(&state,auth.user_id,&id).await?;
    if q.since==Some(a.revision){return Ok(StatusCode::NO_CONTENT.into_response());}Ok(Json(view(a,role,auth.user_id)).into_response())
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Create {id:String,op_id:String,kind:ws::Kind,fields:ws::Fields,mode:ws::Mode,channel_id:Option<String>,channel_access:ws::Access,grants:BTreeMap<String,ws::Access>}
async fn create(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Json(p):Json<Create>)->Result<Json<Value>>{
    registered(&state,auth.user_id).await?;require_kind(&state,p.kind)?;check_id(&p.id)?;check_id(&p.op_id)?;
    ws::validate_fields(p.kind,&p.fields).map_err(|e|invalid(e.to_string()))?;validate_grants(&state,&p.grants).await?;
    if let Some(c)=&p.channel_id{ordinary_channel(&state,auth.user_id,c).await?;}
    let _lock=run.writer.lock().await;
    if let Some(a)=load::<ws::Artifact>(&state,&ws::artifact_key(&p.id))?{
        // A durable client-assigned id makes creation retries recoverable without minting copies.
        if a.owner_id==auth.user_id&&!a.deleted&&a.kind==p.kind{return Err(AppError::Conflict("A prior publication already exists. Fetch it and review the local copy before publishing more changes.".into()));}
        return Err(AppError::Conflict("Artifact id already exists".into()));
    }
    let versions=p.fields.keys().map(|k|(k.clone(),1)).collect();
    let a=ws::Artifact{v:1,id:p.id.clone(),kind:p.kind,owner_id:auth.user_id,channel_id:p.channel_id,channel_access:p.channel_access,grants:p.grants,revision:1,generation:1,mode:p.mode,fields:p.fields,versions,reviews:vec![],updated_at:now(),deleted:false};
    commit(&state,&p.id,&p.op_id,auth.user_id,ws::Command::Create{artifact:a.clone()}).await?;
    Ok(Json(view(a,ws::Access::Editor,auth.user_id)))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Patch {op_id:String,generation:u64,changes:Vec<ws::Change>}
async fn change(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<Patch>)->Result<Json<Value>>{
    let _lock=run.writer.lock().await;let(mut a,role)=get_artifact(&state,auth.user_id,&id).await?;require_kind(&state,a.kind)?;
    if role!=ws::Access::Editor || (a.mode==ws::Mode::Snapshot&&a.owner_id!=auth.user_id){return Err(AppError::Forbidden("This artifact is not editable by this account".into()));}
    let command=ws::Command::Change{generation:p.generation,changes:p.changes};
    if !already_committed(&state,&id,&p.op_id,auth.user_id,&command)?{
        let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};
        if let ws::Command::Change{generation,changes}=&command {
            if *generation!=a.generation || changes.iter().any(|c| a.versions.get(&c.key).copied().unwrap_or(0)!=c.expected) {
                return Err(AppError::Conflict("A field or permission generation changed; fetch and reconcile".into()));
            }
        }
        ws::apply_artifact(&mut a,&env).map_err(|e|invalid(e.to_string()))?;
        commit(&state,&id,&p.op_id,auth.user_id,command).await?;
    }
    let(a,role)=get_artifact(&state,auth.user_id,&id).await?;Ok(Json(view(a,role,auth.user_id)))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct PermissionChange{op_id:String,revision:u64,grants:BTreeMap<String,ws::Access>,channel_id:Option<String>,channel_access:ws::Access}
async fn permissions(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<PermissionChange>)->Result<Json<Value>>{
    let _lock=run.writer.lock().await;let(mut a,_)=get_artifact(&state,auth.user_id,&id).await?;if a.owner_id!=auth.user_id{return Err(AppError::Forbidden("Only the owner can change access".into()));}
    validate_grants(&state,&p.grants).await?;if let Some(c)=&p.channel_id{ordinary_channel(&state,auth.user_id,c).await?;}
    let command=ws::Command::Permissions{revision:p.revision,grants:p.grants,channel_id:p.channel_id,channel_access:p.channel_access};
    if !already_committed(&state,&id,&p.op_id,auth.user_id,&command)?{let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};ws::apply_artifact(&mut a,&env).map_err(|e|AppError::Conflict(e.to_string()))?;commit(&state,&id,&p.op_id,auth.user_id,command).await?;}
    let(a,r)=get_artifact(&state,auth.user_id,&id).await?;Ok(Json(view(a,r,auth.user_id)))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct ModeChange{op_id:String,generation:u64,mode:ws::Mode}
async fn set_mode(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<ModeChange>)->Result<Json<Value>>{
    let _lock=run.writer.lock().await;let(mut a,_)=get_artifact(&state,auth.user_id,&id).await?;require_kind(&state,a.kind)?;if a.owner_id!=auth.user_id{return Err(AppError::Forbidden("Only the owner can change collaboration mode".into()));}
    let command=ws::Command::SetMode{generation:p.generation,mode:p.mode};
    if !already_committed(&state,&id,&p.op_id,auth.user_id,&command)?{let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};ws::apply_artifact(&mut a,&env).map_err(|e|AppError::Conflict(e.to_string()))?;commit(&state,&id,&p.op_id,auth.user_id,command).await?;}
    let(a,r)=get_artifact(&state,auth.user_id,&id).await?;Ok(Json(view(a,r,auth.user_id)))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Remove{op_id:String,revision:u64}
async fn remove(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<Remove>)->Result<Json<Value>>{
    let _lock=run.writer.lock().await;let(mut a,_)=get_artifact(&state,auth.user_id,&id).await?;if a.owner_id!=auth.user_id{return Err(AppError::Forbidden("Only the owner can delete this artifact".into()));}
    let command=ws::Command::Delete{revision:p.revision};let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};ws::apply_artifact(&mut a,&env).map_err(|e|AppError::Conflict(e.to_string()))?;commit(&state,&id,&p.op_id,auth.user_id,command).await?;Ok(Json(json!({"deleted":true})))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct NewReview{op_id:String,id:String,body:String,field:Option<String>,proposal:Option<Value>,base_field_version:u64,is_suggestion:bool}
async fn review(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<NewReview>)->Result<Json<Value>>{
    let _lock=run.writer.lock().await;let(mut a,role)=get_artifact(&state,auth.user_id,&id).await?;require_kind(&state,a.kind)?;
    if role<ws::Access::Commenter{return Err(AppError::Forbidden("Comment access is required".into()));}
    check_id(&p.id)?;if p.body.trim().is_empty()||p.body.len()>16000{return Err(invalid("Review text is required (maximum 16,000 bytes)"));}
    if let Some(key)=&p.field{if !ws::valid_key(key)||!a.fields.contains_key(key){return Err(invalid("Review target is missing"));}}
    if p.is_suggestion{
        let key=p.field.as_ref().ok_or_else(||invalid("Suggestion target is required"))?;
        if p.base_field_version!=ws::field_version(&a,key)||p.proposal.is_none(){return Err(AppError::Conflict("Refresh the suggestion target before submitting".into()));}
        let mut proposed=a.fields.clone();proposed.insert(key.clone(),p.proposal.clone().unwrap());ws::validate_fields(a.kind,&proposed).map_err(|e|invalid(e.to_string()))?;
    }
    // Retry by a stable review id cannot fabricate a second author or duplicate a thread.
    if let Some(r)=a.reviews.iter().find(|r|r.id==p.id){if r.author_id==auth.user_id&&r.body==p.body&&r.proposal==p.proposal&&r.field==p.field&&r.is_suggestion==p.is_suggestion&&r.base_field_version==p.base_field_version{return Ok(Json(view(a,role,auth.user_id)));}return Err(AppError::Conflict("Review id collision".into()));}
    let command=ws::Command::AddReview{review:ws::Review{id:p.id,author_id:auth.user_id,body:p.body,field:p.field,proposal:p.proposal,base_field_version:p.base_field_version,is_suggestion:p.is_suggestion,status:"open".into(),at:now()}};
    let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};ws::apply_artifact(&mut a,&env).map_err(|e|invalid(e.to_string()))?;commit(&state,&id,&p.op_id,auth.user_id,command).await?;
    let(a,r)=get_artifact(&state,auth.user_id,&id).await?;Ok(Json(view(a,r,auth.user_id)))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct ReviewStatus{op_id:String,status:String}
async fn review_status(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path((id,review_id)):Path<(String,String)>,Json(p):Json<ReviewStatus>)->Result<Json<Value>>{
    let _lock=run.writer.lock().await;let(mut a,role)=get_artifact(&state,auth.user_id,&id).await?;require_kind(&state,a.kind)?;
    let r=a.reviews.iter().find(|r|r.id==review_id).ok_or_else(missing)?;
    if role<ws::Access::Commenter || (role<ws::Access::Editor&&(r.author_id!=auth.user_id||p.status=="accepted")){return Err(AppError::Forbidden("Editor or review-author permission is required".into()));}
    if p.status=="accepted"&&(a.mode!=ws::Mode::Live&&a.owner_id!=auth.user_id){return Err(AppError::Forbidden("A snapshot cannot be edited by a reviewer".into()));}
    let command=ws::Command::ReviewStatus{review_id,status:p.status};
    if !already_committed(&state,&id,&p.op_id,auth.user_id,&command)?{let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};ws::apply_artifact(&mut a,&env).map_err(|e|AppError::Conflict(e.to_string()))?;commit(&state,&id,&p.op_id,auth.user_id,command).await?;}
    let(a,r)=get_artifact(&state,auth.user_id,&id).await?;Ok(Json(view(a,r,auth.user_id)))
}
async fn capabilities(State(state):State<Arc<AppState>>,auth:AuthUser)->Result<Json<Value>>{let p=policy(&state)?;Ok(Json(json!({"documents":true,"sheets":p.sheets,"present":p.present,"canConfigure":state.is_admin(auth.user_id).await,"protocol":1})))}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Configure{op_id:String,sheets:bool,present:bool}
async fn configure(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Json(p):Json<Configure>)->Result<Json<Value>>{
    if !state.is_admin(auth.user_id).await{return Err(AppError::Forbidden("Administrator permission is required".into()));}let _lock=run.writer.lock().await;
    commit(&state,"policy",&p.op_id,auth.user_id,ws::Command::Configure{capabilities:ws::Capabilities{sheets:p.sheets,present:p.present}}).await?;
    Ok(Json(json!({"documents":true,"sheets":p.sheets,"present":p.present,"canConfigure":true,"protocol":1})))
}
async fn people(State(state):State<Arc<AppState>>,auth:AuthUser,Query(q):Query<ReadQuery>)->Result<Json<Value>>{
    registered(&state,auth.user_id).await?;let needle=q.q.unwrap_or_default().trim().trim_start_matches('@').to_lowercase();
    if needle.chars().count()<2{return Ok(Json(json!({"people":[]})));}
    let users=state.wdb.list_users().await?.into_iter().filter(|u|u.is_registered&&u.is_active&&(u.username.to_lowercase().contains(&needle)||u.handle.as_deref().is_some_and(|h|h.to_lowercase().contains(&needle)))).take(20).map(|u|json!({"id":u.user_id,"name":u.username,"handle":u.handle})).collect::<Vec<_>>();
    Ok(Json(json!({"people":users})))
}
fn validate_pages(pages:&[ws::Page])->Result<()>{
    if pages.is_empty()||pages.len()>300||ws::encode(&pages)?.len()>ws::MAX_BYTES{return Err(invalid("Presentation must contain 1–300 slides within 32 MiB"));}
    let mut ids=std::collections::HashSet::new();
    for p in pages{check_id(&p.id)?;if !ids.insert(&p.id)||p.title.len()>2000||p.body.len()>50000||!["title","body","image","split"].contains(&p.layout.as_str()){return Err(invalid("Invalid audience slide"));}
        if let Some(image)=&p.image{if !ws::valid_image(image){return Err(invalid("Audience images must be bounded PNG, JPEG, or WebP data; no external URLs"));}}
        if p.aspect.is_some_and(|n|n<0.5||n>3.0)||p.theme.as_deref().is_some_and(|t|!["paper","night","sage"].contains(&t)){return Err(invalid("Invalid slide theme or aspect ratio"));}
    }Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Start{op_id:String,id:String,channel_id:String,title:String,pages:Vec<ws::Page>}
async fn start_presentation(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Json(p):Json<Start>)->Result<Json<Value>>{
    require_kind(&state,ws::Kind::Deck)?;registered(&state,auth.user_id).await?;ordinary_channel(&state,auth.user_id,&p.channel_id).await?;validate_pages(&p.pages)?;check_id(&p.id)?;
    if p.title.len()>1000{return Err(invalid("Title is too long"));}let _lock=run.writer.lock().await;
    if let Some(s)=load::<ws::Presentation>(&state,&ws::session_key(&p.id))?{if s.owner_id==auth.user_id&&!s.ended{return Ok(Json(json!({"presentation":s,"controllerOnline":false})));}return Err(AppError::Conflict("Session id exists".into()));}
    let s=ws::Presentation{v:1,id:p.id.clone(),channel_id:p.channel_id,owner_id:auth.user_id,controller_id:auth.user_id,generation:1,sequence:1,title:p.title,pages:p.pages.clone(),slide_id:p.pages[0].id.clone(),blank:false,ended:false,updated_at:now()};
    commit(&state,&p.id,&p.op_id,auth.user_id,ws::Command::Start{presentation:s.clone()}).await?;
    Ok(Json(json!({"presentation":s,"controllerOnline":false})))
}
async fn session(state:&AppState,user:i64,id:&str)->Result<ws::Presentation>{
    check_id(id)?;require_kind(state,ws::Kind::Deck)?;let s=load::<ws::Presentation>(state,&ws::session_key(id))?.ok_or_else(missing)?;
    ordinary_channel(state,user,&s.channel_id).await.map_err(|_|missing())?;Ok(s)
}
fn online(run:&Runtime,s:&ws::Presentation)->bool{!s.ended&&run.heartbeats.lock().ok().and_then(|h|h.get(&s.id).cloned()).is_some_and(|(id,g,at,_)|id==s.controller_id&&g==s.generation&&at.elapsed().as_secs()<15)}
async fn get_presentation(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Query(q):Query<ReadQuery>)->Result<Json<Value>>{
    let s=session(&state,auth.user_id,&id).await?;let connected=online(&run,&s);
    if q.since==Some(s.sequence){return Ok(Json(json!({"unchanged":true,"controllerOnline":connected,"pointer":get_pointer(&run,&s)})));}
    Ok(Json(json!({"presentation":s,"controllerOnline":connected,"pointer":get_pointer(&run,&s)})))
}
async fn list_presentations(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Query(q):Query<ReadQuery>)->Result<Json<Value>>{
    require_kind(&state,ws::Kind::Deck)?;let channel=q.channel.ok_or_else(||invalid("Channel is required"))?;ordinary_channel(&state,auth.user_id,&channel).await?;
    let mut records=vec![];let mut error=None;
    state.wdb.engine().projection_state().prefix_scan(ws::INDEX,b"session:",|_,b|{match ws::decode::<ws::Presentation>(b){Ok(s)=>records.push(s),Err(e)=>{error=Some(e);return;}}});if let Some(e)=error{return Err(e.into());}
    let out=records.into_iter().filter(|s|s.channel_id==channel&&!s.ended).take(100).map(|s|json!({"id":s.id,"title":s.title,"controllerId":s.controller_id,"controllerOnline":online(&run,&s)})).collect::<Vec<_>>();Ok(Json(json!({"presentations":out})))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Control{op_id:String,generation:u64,sequence:u64,slide_id:Option<String>,controller_id:Option<i64>,blank:Option<bool>,#[serde(default)]end:bool}
async fn control_presentation(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<Control>)->Result<Json<Value>>{
    let _lock=run.writer.lock().await;let mut s=session(&state,auth.user_id,&id).await?;
    if s.controller_id!=auth.user_id && !(p.end&&p.slide_id.is_none()&&p.controller_id.is_none()&&p.blank.is_none()&&(s.owner_id==auth.user_id||state.is_admin(auth.user_id).await)){return Err(AppError::Forbidden("Only the current presenter can control this session".into()));}
    if let Some(id)=p.controller_id{registered(&state,id).await?;ordinary_channel(&state,id,&s.channel_id).await?;}
    let command=ws::Command::Control{generation:p.generation,sequence:p.sequence,slide_id:p.slide_id,controller_id:p.controller_id,blank:p.blank,end:p.end};
    if !already_committed(&state,&id,&p.op_id,auth.user_id,&command)?{let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};ws::apply_control(&mut s,&env).map_err(|e|AppError::Conflict(e.to_string()))?;commit(&state,&id,&p.op_id,auth.user_id,command).await?;}
    let s=session(&state,auth.user_id,&id).await?;Ok(Json(json!({"controllerOnline":online(&run,&s),"presentation":s})))
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Heartbeat{generation:u64,#[serde(default)]pointer:Option<Pointer>}
#[derive(Debug,Clone,Copy,serde::Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct Pointer{x:f64,y:f64}
fn get_pointer(run:&Runtime,s:&ws::Presentation)->Option<Pointer>{if !online(run,s){return None;}run.heartbeats.lock().ok().and_then(|h|h.get(&s.id).and_then(|(_,_,_,p)|*p))}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct UpdatePresentation{op_id:String,generation:u64,sequence:u64,title:String,pages:Vec<ws::Page>,slide_id:String}
async fn update_presentation(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<UpdatePresentation>)->Result<Json<Value>>{
    validate_pages(&p.pages)?;if p.title.len()>1000{return Err(invalid("Title exceeds limit"));}let _lock=run.writer.lock().await;let mut s=session(&state,auth.user_id,&id).await?;
    if s.controller_id!=auth.user_id{return Err(AppError::Forbidden("Only the current presenter can replace the audience revision".into()));}
    let command=ws::Command::UpdatePresentation{generation:p.generation,sequence:p.sequence,title:p.title,pages:p.pages,slide_id:p.slide_id};
    if !already_committed(&state,&id,&p.op_id,auth.user_id,&command)?{let env=ws::Envelope{v:1,id:id.clone(),op_id:p.op_id.clone(),actor:auth.user_id,at:now(),command:command.clone()};ws::apply_control(&mut s,&env).map_err(|e|AppError::Conflict(e.to_string()))?;commit(&state,&id,&p.op_id,auth.user_id,command).await?;}
    let s=session(&state,auth.user_id,&id).await?;Ok(Json(json!({"presentation":s,"controllerOnline":online(&run,&s)})))
}
async fn heartbeat(State(state):State<Arc<AppState>>,Extension(run):Run,auth:AuthUser,Path(id):Path<String>,Json(p):Json<Heartbeat>)->Result<Json<Value>>{
    let s=session(&state,auth.user_id,&id).await?;if s.ended||s.controller_id!=auth.user_id||s.generation!=p.generation{return Err(AppError::Conflict("Presenter lease changed".into()));}
    let mut beats=run.heartbeats.lock().map_err(|_|AppError::Internal("Presentation presence unavailable".into()))?;
    beats.retain(|_,(_,_,at,_)|at.elapsed().as_secs()<30);if beats.len()>=1000&&!beats.contains_key(&id){return Err(AppError::TooManyRequests("Too many live presentation sessions".into()));}if p.pointer.is_some_and(|p|!p.x.is_finite()||!p.y.is_finite()||!(0.0..=1.0).contains(&p.x)||!(0.0..=1.0).contains(&p.y)){return Err(invalid("Invalid pointer position"));}
    if beats.get(&id).is_some_and(|(_,_,at,_)|at.elapsed().as_millis()<100){return Err(AppError::TooManyRequests("Pointer updates are limited to 10 per second".into()));}
    beats.insert(id,(auth.user_id,p.generation,Instant::now(),p.pointer));Ok(Json(json!({"ok":true})))
}
