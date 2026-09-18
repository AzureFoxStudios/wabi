//! Shared Documents and optional office artifacts. Server-owned ACLs and
//! protected ranges never live in the editor-controlled CRDT.
use axum::{extract::{DefaultBodyLimit,Path,State},routing::get,Json,Router};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{collections::BTreeMap,sync::Arc,time::{Instant,SystemTime,UNIX_EPOCH}};
use tokio::sync::Mutex;
use crate::{auth_extractor::AuthUser,channel_access,error::AppError,state::AppState};
use wabidb::{engine::wabi_store::WabiStore,projections::workspace::{WorkspaceDelta,WorkspaceRecord}};
use super::workspace_crdt as crdt;
#[path="workspace_sheets.rs"]
pub(super) mod sheet_rules;
use self::sheet_rules::ProtectedRange;
#[path="workspace_conversion.rs"]
pub(super) mod conversion;

type Result<T>=std::result::Result<T,AppError>;
#[derive(Clone,Copy,Debug,Serialize,Deserialize,PartialEq,Eq,PartialOrd,Ord)]
#[serde(rename_all="lowercase")]
pub(super) enum Role {Viewer,Commenter,Editor,Owner}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Review {
    pub id:String,pub author_user_id:u64,pub author_name:String,pub kind:String,pub body:String,
    pub anchor:Option<String>,pub proposal:Option<String>,pub base_hash:Option<String>,pub state:String,pub created_at:u64,
    #[serde(default)]pub parent_id:Option<String>,
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Artifact {
    pub id:String,pub owner_user_id:u64,pub kind:String,pub format:String,pub title:String,
    pub mode:String,pub generation:u64,pub access_revision:u64,pub sequence:u64,
    pub grants:BTreeMap<u64,Role>,pub channel_id:Option<String>,pub channel_role:Role,
    pub checkpoint:String,pub updates:Vec<String>,pub reviews:Vec<Review>,pub created_at:u64,pub updated_at:u64,
    #[serde(default)]pub protected_ranges:Vec<ProtectedRange>,
}
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Capabilities {pub sheets:bool,pub present:bool}
pub(super) struct Runtime {
    pub gate:Mutex<()>,pub instance:String,budget:Mutex<BTreeMap<i64,(Instant,u32)>>,
    pub presentations:Mutex<BTreeMap<String,super::workspace_present::Presence>>,
}
#[derive(Clone)]
pub(super) struct WorkspaceState {pub app:Arc<AppState>,pub runtime:Arc<Runtime>}
pub(super) fn now()->u64 {SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
pub(super) fn bad(text:&str)->AppError {AppError::BadRequest(text.into())}
pub(super) fn missing()->AppError {AppError::NotFound("Workspace not found or access denied".into())}
pub(super) fn valid_id(id:&str)->Result<()> {uuid::Uuid::parse_str(id).map(|_|()).map_err(|_|bad("Invalid workspace ID"))}
fn key(id:&str)->String {format!("artifact:{id}")}
pub(super) fn deserialize<T:serde::de::DeserializeOwned>(value:Value)->Result<T>{serde_json::from_value(value).map_err(|_|AppError::Internal("Stored workspace is damaged; original retained".into()))}
pub(super) fn serialize<T:Serialize>(value:&T)->Result<Value>{serde_json::to_value(value).map_err(|error|AppError::Internal(error.to_string()))}

pub fn routes(app:Arc<AppState>)->Router<Arc<AppState>> {
    let state=WorkspaceState{app,runtime:Arc::new(Runtime{gate:Mutex::new(()),instance:uuid::Uuid::new_v4().to_string(),budget:Mutex::new(BTreeMap::new()),presentations:Mutex::new(BTreeMap::new())})};
    Router::new().route("/capabilities",get(capabilities).put(set_capabilities))
        .route("/artifacts",get(list_artifacts).post(create_artifact))
        .route("/artifacts/{id}/sync",axum::routing::post(sync_artifact))
        .route("/artifacts/{id}/access",axum::routing::post(set_access))
        .route("/artifacts/{id}/protection",axum::routing::post(set_protection))
        .route("/artifacts/{id}/reviews",axum::routing::post(review))
        .merge(super::workspace_present::routes())
        .merge(conversion::routes())
        .layer(DefaultBodyLimit::max(18*1024*1024)).with_state(state)
}
impl axum::extract::FromRef<WorkspaceState> for Arc<AppState>{fn from_ref(state:&WorkspaceState)->Self{state.app.clone()}}
pub(super) async fn admit(state:&WorkspaceState,auth:&AuthUser)->Result<()> {
    if auth.user_id<=0||auth.is_guest||auth.is_bot{return Err(AppError::Forbidden("A registered account is required to share work".into()));}
    let user=state.app.wdb.get_user(auth.user_id as u64).await?.ok_or_else(missing)?;
    if !user.is_active||user.password_hash.is_empty(){return Err(missing());}
    let mut budget=state.runtime.budget.lock().await;budget.retain(|_,(start,_)|start.elapsed().as_secs()<60);
    if budget.len()>=4096&&!budget.contains_key(&auth.user_id){return Err(AppError::TooManyRequests("Workspace is busy".into()));}
    let entry=budget.entry(auth.user_id).or_insert((Instant::now(),0));
    if entry.1>=600{return Err(AppError::TooManyRequests("Workspace request budget exceeded".into()));}entry.1+=1;Ok(())
}
pub(super) fn caps(state:&WorkspaceState)->Result<Capabilities>{state.app.wdb.workspace_get("settings")?.map(|row|deserialize(row.value)).transpose().map(|value|value.unwrap_or_default())}
pub(super) fn require_cap(state:&WorkspaceState,kind:&str)->Result<()> {
    let capabilities=caps(state)?;
    if kind=="document"||(kind=="sheets"&&capabilities.sheets)||(kind=="present"&&capabilities.present){Ok(())}
    else{Err(AppError::Forbidden("This optional workspace is disabled on the server; local work is retained".into()))}
}
pub(super) fn artifact(state:&WorkspaceState,id:&str)->Result<(WorkspaceRecord,Artifact)>{valid_id(id)?;let row=state.app.wdb.workspace_get(&key(id))?.ok_or_else(missing)?;let artifact=deserialize(row.value.clone())?;Ok((row,artifact))}
pub(super) async fn role(state:&WorkspaceState,artifact:&Artifact,user:i64)->Option<Role>{
    if user as u64==artifact.owner_user_id{return Some(Role::Owner);}
    let direct=artifact.grants.get(&(user as u64)).copied();
    let channel=if let Some(id)=&artifact.channel_id{channel_access::require_access(&state.app,user,id).await.ok().map(|_|artifact.channel_role)}else{None};direct.max(channel)
}
pub(super) fn meta(row:&WorkspaceRecord,artifact:&Artifact,role:Role)->Value {
    json!({"id":artifact.id,"kind":artifact.kind,"format":artifact.format,"title":artifact.title,"mode":artifact.mode,"generation":artifact.generation,"accessRevision":artifact.access_revision,"sequence":artifact.sequence,"revision":row.revision,"ownerUserId":artifact.owner_user_id,"role":role,"grants":if role==Role::Owner{Some(&artifact.grants)}else{None},"channelId":artifact.channel_id,"channelRole":artifact.channel_role,"updatedAt":artifact.updated_at,"protectedRanges":artifact.protected_ranges})
}
pub(super) async fn save(state:&WorkspaceState,row:&WorkspaceRecord,artifact:&Artifact,user:u64)->Result<WorkspaceRecord>{state.app.wdb.workspace_put(user,&row.key,row.revision,artifact.owner_user_id,serialize(artifact)?).await}
async fn capabilities(State(state):State<WorkspaceState>,auth:AuthUser)->Result<Json<Value>> {
    admit(&state,&auth).await?;let capabilities=caps(&state)?;
    Ok(Json(json!({"documents":true,"sheets":capabilities.sheets,"present":capabilities.present,"officeConversion":capabilities.present&&conversion::configured(),"admin":state.app.is_admin(auth.user_id).await})))
}
async fn set_capabilities(State(state):State<WorkspaceState>,auth:AuthUser,Json(capabilities):Json<Capabilities>)->Result<Json<Value>> {
    admit(&state,&auth).await?;if !state.app.is_admin(auth.user_id).await{return Err(AppError::Forbidden("Server administrator required".into()));}
    let _lock=state.runtime.gate.lock().await;let old=state.app.wdb.workspace_get("settings")?;
    state.app.wdb.workspace_put(auth.user_id as u64,"settings",old.as_ref().map_or(0,|row|row.revision),old.as_ref().map_or(auth.user_id as u64,|row|row.owner_user_id),serialize(&capabilities)?).await?;
    Ok(Json(json!({"documents":true,"sheets":capabilities.sheets,"present":capabilities.present,"officeConversion":capabilities.present&&conversion::configured(),"admin":true})))
}
async fn list_artifacts(State(state):State<WorkspaceState>,auth:AuthUser)->Result<Json<Value>> {
    admit(&state,&auth).await?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;
    let mut result=Vec::new();for row in state.app.wdb.workspace_list("artifact:")?{let artifact:Artifact=deserialize(row.value.clone())?;if let Some(rights)=role(&state,&artifact,auth.user_id).await{result.push(meta(&row,&artifact,rights));}}
    result.sort_by_key(|value|std::cmp::Reverse(value["updatedAt"].as_u64().unwrap_or(0)));Ok(Json(json!({"artifacts":result})))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Create {id:String,kind:String,format:String,mode:String,update:String}
async fn create_artifact(State(state):State<WorkspaceState>,auth:AuthUser,Json(payload):Json<Create>)->Result<Json<Value>> {
    admit(&state,&auth).await?;valid_id(&payload.id)?;
    if !["snapshot","live"].contains(&payload.mode.as_str())||!["text","markdown","html","code","native"].contains(&payload.format.as_str()){return Err(bad("Unsupported document format or mode"));}
    let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;require_cap(&state,&payload.kind)?;
    if let Some(row)=state.app.wdb.workspace_get(&key(&payload.id))?{
        let artifact:Artifact=deserialize(row.value.clone())?;if artifact.owner_user_id!=auth.user_id as u64{return Err(missing());}
        if artifact.kind!=payload.kind||artifact.format!=payload.format{return Err(bad("Workspace identity already has a different content type"));}
        let copy=artifact.clone();let result=tokio::task::spawn_blocking(move||crdt::merge(&copy,None,"")).await.map_err(|_|bad("Invalid document update"))??;
        return Ok(Json(json!({"meta":meta(&row,&artifact,Role::Owner),"delta":result.snapshot,"reviews":artifact.reviews,"accepted":false})));
    }
    if state.app.wdb.workspace_list("artifact:")?.iter().filter(|row|row.owner_user_id==auth.user_id as u64).count()>=1000{return Err(bad("Account workspace limit reached"));}
    let mut artifact=Artifact{id:payload.id,owner_user_id:auth.user_id as u64,kind:payload.kind,format:payload.format,title:String::new(),mode:payload.mode,generation:1,access_revision:1,sequence:1,grants:BTreeMap::new(),channel_id:None,channel_role:Role::Viewer,checkpoint:String::new(),updates:vec![],reviews:vec![],created_at:now(),updated_at:now(),protected_ranges:vec![]};
    let copy=artifact.clone();let result=tokio::task::spawn_blocking(move||crdt::merge(&copy,Some(&payload.update),"")).await.map_err(|_|bad("Invalid document update"))??;
    artifact.checkpoint=result.snapshot.clone();artifact.title=result.title;
    let row=state.app.wdb.workspace_put(auth.user_id as u64,&key(&artifact.id),0,artifact.owner_user_id,serialize(&artifact)?).await?;
    Ok(Json(json!({"meta":meta(&row,&artifact,Role::Owner),"delta":result.snapshot,"reviews":[],"accepted":true})))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Sync {#[serde(default)]vector:String,update:Option<String>,generation:Option<u64>,#[serde(default)]publish:bool,base_sequence:Option<u64>}
async fn sync_artifact(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(payload):Json<Sync>)->Result<Json<Value>> {
    admit(&state,&auth).await?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;
    let (mut row,mut artifact)=artifact(&state,&id)?;let rights=role(&state,&artifact,auth.user_id).await.ok_or_else(missing)?;
    if payload.update.is_some(){
        require_cap(&state,&artifact.kind)?;if rights<Role::Editor{return Err(AppError::Forbidden("Editing is not permitted".into()));}
        if payload.generation!=Some(artifact.generation){return Err(AppError::Conflict("Editing mode changed; keep the pending work as a private copy".into()));}
        if artifact.mode=="snapshot"&&(rights!=Role::Owner||!payload.publish||payload.base_sequence!=Some(artifact.sequence)){return Err(AppError::Conflict("Publishing requires the current snapshot revision".into()));}
    }
    let copy=artifact.clone();let change=payload.update.clone();let vector=payload.vector;
    let result=tokio::task::spawn_blocking(move||{
        let result=crdt::merge(&copy,change.as_deref(),&vector)?;
        if change.is_some()&&rights!=Role::Owner&&copy.kind=="sheets"&&!copy.protected_ranges.is_empty(){crdt::enforce_protection(&copy,&result.snapshot)?;}
        Ok::<_,AppError>(result)
    }).await.map_err(|_|bad("Invalid document update"))??;
    if result.changed&&payload.update.is_some(){
        artifact.sequence=artifact.sequence.checked_add(1).ok_or_else(||bad("Sequence exhausted"))?;artifact.updated_at=now();artifact.title=result.title;
        let update=payload.update.unwrap();
        if artifact.updates.len()<31&&artifact.updates.iter().map(String::len).sum::<usize>()+update.len()<12*1024*1024{
            row=state.app.wdb.workspace_append(auth.user_id as u64,WorkspaceDelta{key:row.key.clone(),expected_revision:row.revision,update:update.clone(),title:artifact.title.clone(),sequence:artifact.sequence,updated_at:artifact.updated_at}).await?;artifact.updates.push(update);
        }else{artifact.checkpoint=result.snapshot;artifact.updates.clear();row=save(&state,&row,&artifact,auth.user_id as u64).await?;}
    }
    Ok(Json(json!({"meta":meta(&row,&artifact,rights),"delta":result.delta,"reviews":artifact.reviews,"accepted":true})))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Access {expected_revision:u64,grants:BTreeMap<u64,Role>,channel_id:Option<String>,channel_role:Role,mode:String}
async fn set_access(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(payload):Json<Access>)->Result<Json<Value>> {
    admit(&state,&auth).await?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;
    let(row,mut artifact)=artifact(&state,&id)?;if artifact.owner_user_id!=auth.user_id as u64{return Err(missing());}require_cap(&state,&artifact.kind)?;
    if payload.expected_revision!=artifact.access_revision{return Err(AppError::Conflict("Sharing changed elsewhere. Reload the access list before saving".into()));}
    if payload.grants.len()>100||payload.grants.values().any(|role|*role==Role::Owner)||payload.channel_role==Role::Owner||!["live","snapshot"].contains(&payload.mode.as_str()){return Err(bad("Invalid sharing options"));}
    for user in payload.grants.keys(){let recipient=state.app.wdb.get_user(*user).await?.ok_or_else(||bad("Recipient not found"))?;if !recipient.is_active||recipient.password_hash.is_empty(){return Err(bad("Recipient must be a registered account"));}}
    if let Some(channel)=&payload.channel_id{let target=channel_access::require_access(&state.app,auth.user_id,channel).await?;if channel_access::is_conversation(target.channel_kind){return Err(bad("Plaintext artifacts cannot be attached to encrypted/private conversations; use explicit account sharing"));}}
    if artifact.mode!=payload.mode{artifact.generation+=1;}artifact.mode=payload.mode;artifact.access_revision+=1;artifact.grants=payload.grants;artifact.channel_id=payload.channel_id;artifact.channel_role=payload.channel_role;artifact.updated_at=now();
    let row=save(&state,&row,&artifact,auth.user_id as u64).await?;Ok(Json(json!({"meta":meta(&row,&artifact,Role::Owner)})))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Protection {expected_revision:u64,ranges:Vec<ProtectedRange>}
async fn set_protection(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(payload):Json<Protection>)->Result<Json<Value>> {
    admit(&state,&auth).await?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;
    let(row,mut artifact)=artifact(&state,&id)?;if artifact.owner_user_id!=auth.user_id as u64{return Err(missing());}require_cap(&state,"sheets")?;
    if artifact.kind!="sheets"{return Err(bad("Only spreadsheets have protected cell ranges"));}
    if payload.expected_revision!=row.revision{return Err(AppError::Conflict("Spreadsheet changed. Refresh protection before saving".into()));}
    let copy=artifact.clone();let ranges=payload.ranges;
    artifact.protected_ranges=tokio::task::spawn_blocking(move||{let document=crdt::load(&copy)?;sheet_rules::validate_ranges(&crdt::data(&document)?,&ranges)?;Ok::<_,AppError>(ranges)}).await.map_err(|_|bad("Invalid protection request"))??;
    artifact.updated_at=now();let row=save(&state,&row,&artifact,auth.user_id as u64).await?;Ok(Json(json!({"meta":meta(&row,&artifact,Role::Owner)})))
}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct ReviewAction {action:String,id:String,kind:Option<String>,body:Option<String>,anchor:Option<String>,proposal:Option<String>,base_sequence:Option<u64>,parent_id:Option<String>}
async fn review(State(state):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(payload):Json<ReviewAction>)->Result<Json<Value>> {
    admit(&state,&auth).await?;valid_id(&payload.id)?;let _membership=state.app.membership_gate.read().await;let _lock=state.runtime.gate.lock().await;
    let(row,mut artifact)=artifact(&state,&id)?;let rights=role(&state,&artifact,auth.user_id).await.ok_or_else(missing)?;require_cap(&state,&artifact.kind)?;
    if rights<Role::Commenter{return Err(AppError::Forbidden("Comment permission required".into()));}
    if payload.action=="add"{
        if let Some(previous)=artifact.reviews.iter().find(|review|review.id==payload.id){if previous.author_user_id!=auth.user_id as u64{return Err(bad("Review ID already exists"));}return Ok(Json(json!({"meta":meta(&row,&artifact,rights),"reviews":artifact.reviews})));}
        let kind=payload.kind.unwrap_or_else(||"comment".into());let body=payload.body.unwrap_or_default();
        if artifact.reviews.len()>=200||!["comment","suggestion"].contains(&kind.as_str())||body.len()>32768||payload.anchor.as_ref().is_some_and(|anchor|anchor.len()>4096){return Err(bad("Review exceeds supported limits"));}
        if kind=="comment"&&(body.trim().is_empty()||payload.proposal.is_some()){return Err(bad("A comment needs text and cannot carry a proposed replacement"));}
        let (parent_id,anchor)=if let Some(parent)=payload.parent_id{
            valid_id(&parent)?;let original=artifact.reviews.iter().find(|review|review.id==parent).ok_or_else(||bad("Reply target was not found"))?;
            if kind!="comment"{return Err(bad("Suggestions must be separate review entries"));}(Some(parent),original.anchor.clone())
        }else{(None,payload.anchor)};
        let base_hash=if kind=="suggestion"{
            if artifact.kind!="document"||payload.base_sequence!=Some(artifact.sequence)||payload.proposal.as_ref().is_none_or(|proposal|proposal.len()>1024*1024){return Err(AppError::Conflict("Suggestion needs the current document revision".into()));}
            let copy=artifact.clone();Some(tokio::task::spawn_blocking(move||crdt::body_hash(&copy)).await.map_err(|_|bad("Invalid document"))??)
        }else{None};
        artifact.reviews.push(Review{id:payload.id,author_user_id:auth.user_id as u64,author_name:auth.username.clone(),kind,body,anchor,proposal:payload.proposal,base_hash,state:"open".into(),created_at:now(),parent_id});
    }else{
        let index=artifact.reviews.iter().position(|review|review.id==payload.id).ok_or_else(missing)?;
        if rights<Role::Editor&&artifact.reviews[index].author_user_id!=auth.user_id as u64{return Err(AppError::Forbidden("Only the author or an editor may change this review".into()));}
        match payload.action.as_str(){
            "accept"=>{
                if rights<Role::Editor||artifact.mode!="live"||artifact.reviews[index].kind!="suggestion"||artifact.reviews[index].state!="open"{return Err(bad("This suggestion cannot be applied"));}
                let copy=artifact.clone();let suggestion=artifact.reviews[index].clone();
                artifact.checkpoint=tokio::task::spawn_blocking(move||crdt::replace_body(&copy,suggestion.base_hash.as_deref().unwrap_or(""),suggestion.proposal.as_deref().unwrap_or(""))).await.map_err(|_|bad("Invalid proposal"))??;
                artifact.updates.clear();artifact.sequence+=1;artifact.reviews[index].state="accepted".into();
            },
            "resolve"=>artifact.reviews[index].state="resolved".into(),"reopen"=>artifact.reviews[index].state="open".into(),"reject"=>artifact.reviews[index].state="rejected".into(),_=>return Err(bad("Unknown review action")),
        }
    }
    artifact.updated_at=now();let row=save(&state,&row,&artifact,auth.user_id as u64).await?;Ok(Json(json!({"meta":meta(&row,&artifact,rights),"reviews":artifact.reviews})))
}
