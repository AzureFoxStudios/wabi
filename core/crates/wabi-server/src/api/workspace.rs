//! Shared Documents and optional office artifacts. Server-owned ACLs never live in a CRDT.
use axum::{extract::{DefaultBodyLimit, Path, State}, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::{Instant, SystemTime, UNIX_EPOCH}};
use tokio::sync::Mutex;
use crate::{auth_extractor::AuthUser, channel_access, error::AppError, state::AppState};
use wabidb::{engine::wabi_store::WabiStore, projections::workspace::{WorkspaceDelta, WorkspaceRecord}};
use super::workspace_crdt as crdt;

type Result<T> = std::result::Result<T, AppError>;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub(super) enum Role { Viewer, Commenter, Editor, Owner }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Review { pub id:String, pub author_user_id:u64, pub author_name:String, pub kind:String, pub body:String, pub anchor:Option<String>, pub proposal:Option<String>, pub base_hash:Option<String>, pub state:String, pub created_at:u64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Artifact {
    pub id:String, pub owner_user_id:u64, pub kind:String, pub format:String, pub title:String,
    pub mode:String, pub generation:u64, pub access_revision:u64, pub sequence:u64,
    pub grants:BTreeMap<u64,Role>, pub channel_id:Option<String>, pub channel_role:Role,
    pub checkpoint:String, pub updates:Vec<String>, pub reviews:Vec<Review>, pub created_at:u64, pub updated_at:u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Capabilities { pub sheets:bool, pub present:bool }
pub(super) struct Runtime { pub gate:Mutex<()>, pub instance:String, budget:Mutex<BTreeMap<i64,(Instant,u32)>> }
#[derive(Clone)]
pub(super) struct WorkspaceState { pub app:Arc<AppState>, pub runtime:Arc<Runtime> }
pub(super) fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
pub(super) fn bad(s: &str) -> AppError { AppError::BadRequest(s.into()) }
pub(super) fn missing() -> AppError { AppError::NotFound("Workspace not found or access denied".into()) }
pub(super) fn valid_id(s:&str) -> Result<()> { uuid::Uuid::parse_str(s).map(|_|()).map_err(|_|bad("Invalid workspace ID")) }
fn key(id:&str)->String { format!("artifact:{id}") }
pub(super) fn deserialize<T:serde::de::DeserializeOwned>(v:Value)->Result<T> { serde_json::from_value(v).map_err(|_|AppError::Internal("Stored workspace is damaged; original retained".into())) }
pub(super) fn serialize<T:Serialize>(v:&T)->Result<Value> { serde_json::to_value(v).map_err(|e|AppError::Internal(e.to_string())) }

pub fn routes(app:Arc<AppState>) -> Router<Arc<AppState>> {
    let state=WorkspaceState{app,runtime:Arc::new(Runtime{gate:Mutex::new(()),instance:uuid::Uuid::new_v4().to_string(),budget:Mutex::new(BTreeMap::new())})};
    Router::new()
        .route("/capabilities",get(capabilities).put(set_capabilities))
        .route("/artifacts",get(list_artifacts).post(create_artifact))
        .route("/artifacts/{id}/sync",axum::routing::post(sync_artifact))
        .route("/artifacts/{id}/access",axum::routing::post(set_access))
        .route("/artifacts/{id}/reviews",axum::routing::post(review))
        .merge(super::workspace_present::routes())
        .layer(DefaultBodyLimit::max(18*1024*1024))
        .with_state(state)
}
// AuthUser's normal extractor needs the underlying AppState.
impl axum::extract::FromRef<WorkspaceState> for Arc<AppState> { fn from_ref(s:&WorkspaceState)->Self{s.app.clone()} }

pub(super) async fn admit(state:&WorkspaceState, auth:&AuthUser)->Result<()> {
    if auth.user_id<=0 || auth.is_guest || auth.is_bot { return Err(AppError::Forbidden("A registered account is required to share work".into())); }
    let user=state.app.wdb.get_user(auth.user_id as u64).await?.ok_or_else(missing)?;
    if !user.is_active || user.password_hash.is_empty() { return Err(missing()); }
    let mut budget=state.runtime.budget.lock().await;
    budget.retain(|_,(start,_)|start.elapsed().as_secs()<60);
    if budget.len()>=4096 && !budget.contains_key(&auth.user_id){return Err(AppError::TooManyRequests("Workspace is busy".into()));}
    let entry=budget.entry(auth.user_id).or_insert((Instant::now(),0));
    if entry.1>=600{return Err(AppError::TooManyRequests("Workspace request budget exceeded".into()));} entry.1+=1;
    Ok(())
}
pub(super) fn caps(state:&WorkspaceState)->Result<Capabilities> {
    state.app.wdb.workspace_get("settings")?.map(|r|deserialize(r.value)).transpose().map(|v|v.unwrap_or_default())
}
pub(super) fn require_cap(state:&WorkspaceState,kind:&str)->Result<()> {
    let c=caps(state)?;
    if kind=="document" || (kind=="sheets"&&c.sheets) || (kind=="present"&&c.present){Ok(())}
    else{Err(AppError::Forbidden("This optional workspace is disabled on the server; local work is retained".into()))}
}
pub(super) fn artifact(state:&WorkspaceState,id:&str)->Result<(WorkspaceRecord,Artifact)> {
    valid_id(id)?; let row=state.app.wdb.workspace_get(&key(id))?.ok_or_else(missing)?;
    let art=deserialize(row.value.clone())?; Ok((row,art))
}
pub(super) async fn role(state:&WorkspaceState,art:&Artifact,uid:i64)->Option<Role> {
    if uid as u64==art.owner_user_id{return Some(Role::Owner);}
    let direct=art.grants.get(&(uid as u64)).copied();
    let channel=if let Some(id)=&art.channel_id {
        channel_access::require_access(&state.app,uid,id).await.ok().map(|_|art.channel_role)
    }else{None};
    direct.max(channel)
}
pub(super) fn meta(row:&WorkspaceRecord,a:&Artifact,r:Role)->Value {
    json!({"id":a.id,"kind":a.kind,"format":a.format,"title":a.title,"mode":a.mode,"generation":a.generation,"accessRevision":a.access_revision,"sequence":a.sequence,"revision":row.revision,"ownerUserId":a.owner_user_id,"role":r,"grants":if r==Role::Owner{Some(&a.grants)}else{None},"channelId":a.channel_id,"channelRole":a.channel_role,"updatedAt":a.updated_at})
}
pub(super) async fn save(state:&WorkspaceState,row:&WorkspaceRecord,a:&Artifact,uid:u64)->Result<WorkspaceRecord>{state.app.wdb.workspace_put(uid,&row.key,row.revision,a.owner_user_id,serialize(a)?).await}

async fn capabilities(State(s):State<WorkspaceState>,auth:AuthUser)->Result<Json<Value>>{
    admit(&s,&auth).await?; let c=caps(&s)?; Ok(Json(json!({"documents":true,"sheets":c.sheets,"present":c.present,"officeConversion":false,"admin":s.app.is_admin(auth.user_id).await})))
}
async fn set_capabilities(State(s):State<WorkspaceState>,auth:AuthUser,Json(c):Json<Capabilities>)->Result<Json<Value>>{
    admit(&s,&auth).await?; if !s.app.is_admin(auth.user_id).await{return Err(AppError::Forbidden("Server administrator required".into()));}
    let _lock=s.runtime.gate.lock().await; let old=s.app.wdb.workspace_get("settings")?;
    s.app.wdb.workspace_put(auth.user_id as u64,"settings",old.as_ref().map_or(0,|r|r.revision),old.as_ref().map_or(auth.user_id as u64,|r|r.owner_user_id),serialize(&c)?).await?;
    Ok(Json(json!({"documents":true,"sheets":c.sheets,"present":c.present,"officeConversion":false,"admin":true})))
}
async fn list_artifacts(State(s):State<WorkspaceState>,auth:AuthUser)->Result<Json<Value>>{
    admit(&s,&auth).await?; let _membership=s.app.membership_gate.read().await; let _lock=s.runtime.gate.lock().await;
    let mut result=Vec::new(); for row in s.app.wdb.workspace_list("artifact:")? { let a:Artifact=deserialize(row.value.clone())?; if let Some(r)=role(&s,&a,auth.user_id).await {result.push(meta(&row,&a,r));} }
    result.sort_by_key(|v|std::cmp::Reverse(v["updatedAt"].as_u64().unwrap_or(0)));
    Ok(Json(json!({"artifacts":result})))
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Create {id:String,kind:String,format:String,mode:String,update:String}
async fn create_artifact(State(s):State<WorkspaceState>,auth:AuthUser,Json(p):Json<Create>)->Result<Json<Value>>{
    admit(&s,&auth).await?;valid_id(&p.id)?;require_cap(&s,&p.kind)?;
    if !["snapshot","live"].contains(&p.mode.as_str()) || !["text","markdown","html","code","native"].contains(&p.format.as_str()){return Err(bad("Unsupported document format or mode"));}
    let _membership=s.app.membership_gate.read().await;let _lock=s.runtime.gate.lock().await;
    if let Some(row)=s.app.wdb.workspace_get(&key(&p.id))? {
        let a:Artifact=deserialize(row.value.clone())?;if a.owner_user_id!=auth.user_id as u64{return Err(missing());}
        let copy=a.clone();let result=tokio::task::spawn_blocking(move||crdt::merge(&copy,None,"")).await.map_err(|_|bad("Invalid document update"))??;
        return Ok(Json(json!({"meta":meta(&row,&a,Role::Owner),"delta":result.snapshot,"reviews":a.reviews,"accepted":false})));
    }
    if s.app.wdb.workspace_list("artifact:")?.iter().filter(|r|r.owner_user_id==auth.user_id as u64).count()>=1000{return Err(bad("Account workspace limit reached"));}
    let mut a=Artifact{id:p.id,owner_user_id:auth.user_id as u64,kind:p.kind,format:p.format,title:String::new(),mode:p.mode,generation:1,access_revision:1,sequence:1,grants:BTreeMap::new(),channel_id:None,channel_role:Role::Viewer,checkpoint:String::new(),updates:vec![],reviews:vec![],created_at:now(),updated_at:now()};
    let copy=a.clone();let result=tokio::task::spawn_blocking(move||crdt::merge(&copy,Some(&p.update),"")).await.map_err(|_|bad("Invalid document update"))??;
    a.checkpoint=result.snapshot.clone();a.title=result.title;
    let row=s.app.wdb.workspace_put(auth.user_id as u64,&key(&a.id),0,a.owner_user_id,serialize(&a)?).await?;
    Ok(Json(json!({"meta":meta(&row,&a,Role::Owner),"delta":result.snapshot,"reviews":[],"accepted":true})))
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Sync {#[serde(default)]vector:String,update:Option<String>,generation:Option<u64>,#[serde(default)]publish:bool,base_sequence:Option<u64>}
async fn sync_artifact(State(s):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(p):Json<Sync>)->Result<Json<Value>>{
    admit(&s,&auth).await?;let _membership=s.app.membership_gate.read().await;let _lock=s.runtime.gate.lock().await;
    let (mut row,mut a)=artifact(&s,&id)?;let r=role(&s,&a,auth.user_id).await.ok_or_else(missing)?;
    if p.update.is_some(){
        require_cap(&s,&a.kind)?;
        if r<Role::Editor{return Err(AppError::Forbidden("Editing is not permitted".into()));}
        if p.generation!=Some(a.generation){return Err(AppError::Conflict("Editing mode changed; keep the pending work as a private copy".into()));}
        if a.mode=="snapshot" && (r!=Role::Owner || !p.publish || p.base_sequence!=Some(a.sequence)){return Err(AppError::Conflict("Publishing requires the current snapshot revision".into()));}
    }
    let copy=a.clone();let change=p.update.clone();let vector=p.vector;
    let result=tokio::task::spawn_blocking(move||crdt::merge(&copy,change.as_deref(),&vector)).await.map_err(|_|bad("Invalid document update"))??;
    if result.changed && p.update.is_some(){
        a.sequence=a.sequence.checked_add(1).ok_or_else(||bad("Sequence exhausted"))?;a.updated_at=now();a.title=result.title;
        let update=p.update.unwrap();
        if a.updates.len()<31 && a.updates.iter().map(String::len).sum::<usize>()+update.len()<12*1024*1024{
            row=s.app.wdb.workspace_append(auth.user_id as u64,WorkspaceDelta{key:row.key.clone(),expected_revision:row.revision,update:update.clone(),title:a.title.clone(),sequence:a.sequence,updated_at:a.updated_at}).await?;
            a.updates.push(update);
        }else{a.checkpoint=result.snapshot;a.updates.clear();row=save(&s,&row,&a,auth.user_id as u64).await?;}
    }
    Ok(Json(json!({"meta":meta(&row,&a,r),"delta":result.delta,"reviews":a.reviews,"accepted":true})))
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Access {expected_revision:u64,grants:BTreeMap<u64,Role>,channel_id:Option<String>,channel_role:Role,mode:String}
async fn set_access(State(s):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(p):Json<Access>)->Result<Json<Value>>{
    admit(&s,&auth).await?;let _membership=s.app.membership_gate.read().await;let _lock=s.runtime.gate.lock().await;
    let (row,mut a)=artifact(&s,&id)?;if a.owner_user_id!=auth.user_id as u64{return Err(missing());}require_cap(&s,&a.kind)?;
    if p.expected_revision!=a.access_revision{return Err(AppError::Conflict("Sharing changed elsewhere. Reload the access list before saving".into()));}
    if p.grants.len()>100 || p.grants.values().any(|r|*r==Role::Owner) || p.channel_role==Role::Owner || !["live","snapshot"].contains(&p.mode.as_str()){return Err(bad("Invalid sharing options"));}
    for uid in p.grants.keys(){let user=s.app.wdb.get_user(*uid).await?.ok_or_else(||bad("Recipient not found"))?;if !user.is_active||user.password_hash.is_empty(){return Err(bad("Recipient must be a registered account"));}}
    if let Some(channel)=&p.channel_id {let c=channel_access::require_access(&s.app,auth.user_id,channel).await?;if channel_access::is_conversation(c.channel_kind){return Err(bad("Plaintext artifacts cannot be attached to encrypted/private conversations; use explicit account sharing"));}}
    if a.mode!=p.mode{a.generation+=1;}a.mode=p.mode;a.access_revision+=1;a.grants=p.grants;a.channel_id=p.channel_id;a.channel_role=p.channel_role;a.updated_at=now();
    let row=save(&s,&row,&a,auth.user_id as u64).await?;Ok(Json(json!({"meta":meta(&row,&a,Role::Owner)})))
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct ReviewAction {action:String,id:String,kind:Option<String>,body:Option<String>,anchor:Option<String>,proposal:Option<String>,base_sequence:Option<u64>}
async fn review(State(s):State<WorkspaceState>,auth:AuthUser,Path(id):Path<String>,Json(p):Json<ReviewAction>)->Result<Json<Value>>{
    admit(&s,&auth).await?;valid_id(&p.id)?;let _membership=s.app.membership_gate.read().await;let _lock=s.runtime.gate.lock().await;
    let(row,mut a)=artifact(&s,&id)?;let r=role(&s,&a,auth.user_id).await.ok_or_else(missing)?;require_cap(&s,&a.kind)?;
    if r<Role::Commenter{return Err(AppError::Forbidden("Comment permission required".into()));}
    if p.action=="add" {
        if let Some(previous)=a.reviews.iter().find(|v|v.id==p.id){if previous.author_user_id!=auth.user_id as u64{return Err(bad("Review ID already exists"));}return Ok(Json(json!({"meta":meta(&row,&a,r),"reviews":a.reviews})));}
        let kind=p.kind.unwrap_or_else(||"comment".into());let body=p.body.unwrap_or_default();
        if a.reviews.len()>=200 || !["comment","suggestion"].contains(&kind.as_str()) || body.len()>8192 || p.anchor.as_ref().is_some_and(|v|v.len()>4096){return Err(bad("Review exceeds supported limits"));}
        let base_hash=if kind=="suggestion" {
            if a.kind!="document" || p.base_sequence!=Some(a.sequence) || p.proposal.as_ref().is_none_or(|v|v.len()>1024*1024){return Err(AppError::Conflict("Suggestion needs the current document revision".into()));}
            let copy=a.clone();Some(tokio::task::spawn_blocking(move||crdt::body_hash(&copy)).await.map_err(|_|bad("Invalid document"))??)
        }else{None};
        a.reviews.push(Review{id:p.id,author_user_id:auth.user_id as u64,author_name:auth.username.clone(),kind,body,anchor:p.anchor,proposal:p.proposal,base_hash,state:"open".into(),created_at:now()});
    }else{
        let index=a.reviews.iter().position(|v|v.id==p.id).ok_or_else(missing)?;
        if r<Role::Editor && a.reviews[index].author_user_id!=auth.user_id as u64{return Err(AppError::Forbidden("Only the author or an editor may change this review".into()));}
        match p.action.as_str(){
            "accept"=>{
                if r<Role::Editor || a.mode!="live" || a.reviews[index].kind!="suggestion" || a.reviews[index].state!="open"{return Err(bad("This suggestion cannot be applied"));}
                let copy=a.clone();let suggestion=a.reviews[index].clone();
                a.checkpoint=tokio::task::spawn_blocking(move||crdt::replace_body(&copy,suggestion.base_hash.as_deref().unwrap_or(""),suggestion.proposal.as_deref().unwrap_or(""))).await.map_err(|_|bad("Invalid proposal"))??;
                a.updates.clear();a.sequence+=1;a.reviews[index].state="accepted".into();
            },
            "resolve"=>a.reviews[index].state="resolved".into(),"reopen"=>a.reviews[index].state="open".into(),"reject"=>a.reviews[index].state="rejected".into(),_=>return Err(bad("Unknown review action")),
        }
    }
    a.updated_at=now();let row=save(&s,&row,&a,auth.user_id as u64).await?;Ok(Json(json!({"meta":meta(&row,&a,r),"reviews":a.reviews})))
}
