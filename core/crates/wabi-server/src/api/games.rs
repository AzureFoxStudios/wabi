//! Core curated game board. Steam is an optional source, never its owner.
use axum::{http::{header,HeaderValue},middleware::Next,response::Response,extract::{DefaultBodyLimit,Path,State,Request},Json,Router};
use serde::Deserialize;
use serde_json::{json,Value};
use std::{collections::HashSet,sync::Arc};
use crate::{auth_extractor::AuthUser,error::{AppError,Result},state::AppState};
use wabidb::{engine::wabi_store::WabiStore,projections::game_profiles::{GameSelection,Visibility}};
pub(crate) async fn no_store(request:Request,next:Next)->Response {
    let mut response=next.run(request).await;
    response.headers_mut().insert(header::CACHE_CONTROL,HeaderValue::from_static("no-store, private"));
    response.headers_mut().insert("referrer-policy",HeaderValue::from_static("no-referrer"));
    response.headers_mut().insert("x-content-type-options",HeaderValue::from_static("nosniff"));response
}
pub fn routes(state:Arc<AppState>)->Router<Arc<AppState>> {
    Router::new().route("/me",axum::routing::get(me).put(save))
        .route("/profile/{id}",axum::routing::get(profile))
        .route("/match",axum::routing::post(matches))
        .route("/members/{channel_id}",axum::routing::get(members))
        .layer(DefaultBodyLimit::max(131072))
        .layer(axum::middleware::from_fn(no_store))
        .with_state(state)
}
pub(crate) async fn account(state:&AppState,auth:&AuthUser)->Result<u64> {
    if auth.user_id<=0 || auth.is_guest || auth.is_bot {return Err(AppError::Forbidden("A registered personal account is required".into()));}
    let uid=auth.user_id as u64;
    let row=state.wdb.get_user(uid).await?.ok_or_else(||AppError::Unauthorized("Account no longer exists".into()))?;
    if !row.is_active || row.password_hash.is_empty() {return Err(AppError::Unauthorized("Account unavailable".into()));}
    Ok(uid)
}
pub(crate) fn bad(message:&str)->AppError {AppError::BadRequest(message.into())}
pub(crate) fn text(v:&str,max:usize,required:bool)->bool {
    (!required || !v.trim().is_empty()) && v.chars().count()<=max &&
        !v.chars().any(|c|c.is_control() && c!='\n' && c!='\t')
}
pub(crate) fn app_id(raw:&str)->Option<u32> {
    if raw.starts_with('0') || raw.is_empty() || !raw.bytes().all(|b|b.is_ascii_digit()) {return None;}
    raw.parse::<u32>().ok().filter(|n|*n>0)
}
pub(crate) fn valid_key(key:&str)->bool {
    if let Some(id)=key.strip_prefix("steam:") {return app_id(id).is_some();}
    key.strip_prefix("local:").and_then(|s|uuid::Uuid::parse_str(s).ok().map(|u|(s,u)))
        .is_some_and(|(s,u)|u.get_version_num()==4 && u.get_variant()==uuid::Variant::RFC4122 && u.to_string()==s)
}
pub(crate) fn validate_entries(entries:&[GameSelection])->Result<()> {
    if entries.len()>64 {return Err(bad("Choose at most 64 games"));}
    let mut keys=HashSet::new();
    for e in entries {
        if !valid_key(&e.key) || !keys.insert(&e.key) || !text(&e.title,120,true) || !text(&e.platform,40,false) || !text(&e.note,300,false)
            || e.tags.len()>8 || e.tags.iter().any(|t|!text(t,24,true)) || e.tags.iter().collect::<HashSet<_>>().len()!=e.tags.len() {
            return Err(bad("Invalid or duplicate game selection"));
        }
    } Ok(())
}
async fn me(auth:AuthUser,State(state):State<Arc<AppState>>)->Result<Json<Value>> {
    let uid=account(&state,&auth).await?; let row=state.wdb.get_game_profile(uid)?;
    Ok(Json(json!({"revision":row.revision,"entries":row.entries,"steamId":row.steam_id,"showSteamLink":row.show_steam_link})))
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Save {revision:String,entries:Vec<GameSelection>,show_steam_link:bool}
async fn save(auth:AuthUser,State(state):State<Arc<AppState>>,Json(body):Json<Save>)->Result<Json<Value>> {
    let uid=account(&state,&auth).await?;validate_entries(&body.entries)?;
    let row=state.wdb.mutate_game_profile(uid,&body.revision,|r|{r.entries=body.entries;r.show_steam_link=body.show_steam_link && r.steam_id.is_some();Ok(())}).await?;
    Ok(Json(json!({"revision":row.revision,"entries":row.entries,"steamId":row.steam_id,"showSteamLink":row.show_steam_link})))
}
async fn profile(auth:AuthUser,State(state):State<Arc<AppState>>,Path(id):Path<u64>)->Result<Json<Value>> {
    account(&state,&auth).await?;
    if !state.wdb.get_user(id).await?.is_some_and(|u|u.is_active && !u.password_hash.is_empty()) {return Err(AppError::NotFound("Profile not found".into()));}
    let row=state.wdb.get_game_profile(id)?;
    let entries:Vec<_>=row.entries.into_iter().filter(|e|e.visibility==Visibility::Server).collect();
    let url=if row.show_steam_link {row.steam_id.map(|id|format!("https://steamcommunity.com/profiles/{id}/"))}else{None};
    Ok(Json(json!({"entries":entries,"steamProfileUrl":url})))
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct MatchRequest {channel_id:String,participant_ids:Vec<String>}
fn parse_participants(ids:&[String],self_id:u64)->Result<Vec<u64>> {
    let result:Option<Vec<_>>=ids.iter().map(|s|s.parse::<u64>().ok().filter(|n|*n>0 && n.to_string()==*s)).collect();
    let ids=result.ok_or_else(||bad("Invalid participant"))?;
    if ids.len()<2 || ids.len()>12 || !ids.contains(&self_id) || ids.iter().collect::<HashSet<_>>().len()!=ids.len() {return Err(bad("Choose yourself and 1–11 other channel members"));}
    Ok(ids)
}
pub(crate) fn intersection(boards:&[Vec<GameSelection>])->Vec<Value> {
    if boards.len()<2 || boards.len()>12 {return vec![];}
    boards[0].iter().filter(|e|e.visibility==Visibility::Server && e.invitations)
        .filter(|e|boards.iter().skip(1).all(|b|b.iter().any(|g|g.key==e.key && g.visibility==Visibility::Server && g.invitations)))
        .map(|e|json!({"key":e.key,"title":e.title})).collect()
}
async fn members(auth:AuthUser,State(state):State<Arc<AppState>>,Path(channel_id):Path<String>)->Result<Json<Value>> {
    account(&state,&auth).await?;
    crate::channel_access::require_access(&state,auth.user_id,&channel_id).await?;
    // Unlike ordinary-channel discovery, group comparison always requires actual membership.
    if !crate::channel_access::is_member(&state,auth.user_id,&channel_id).await? {return Err(AppError::Forbidden("Join the conversation first".into()));}
    let mut members=Vec::new();
    for m in state.wdb.list_channel_members(&channel_id).await? {
        if let Some(u)=state.wdb.get_user(m.user_id).await? {
            if u.is_active && !u.password_hash.is_empty() && !u.is_bot {members.push(json!({"id":u.user_id.to_string(),"name":u.username}));}
        }
    }
    crate::channel_access::require_access(&state,auth.user_id,&channel_id).await?;
    Ok(Json(json!({"members":members})))
}
async fn matches(auth:AuthUser,State(state):State<Arc<AppState>>,Json(body):Json<MatchRequest>)->Result<Json<Value>> {
    let uid=account(&state,&auth).await?;
    let ids=parse_participants(&body.participant_ids,uid)?;
    let verify=|| async {
        crate::channel_access::require_access(&state,auth.user_id,&body.channel_id).await?;
        for &id in &ids {
            if id>i64::MAX as u64 || !state.wdb.get_user(id).await?.is_some_and(|u|u.is_active && !u.password_hash.is_empty() && !u.is_bot) || !crate::channel_access::is_member(&state,id as i64,&body.channel_id).await? {
                return Err(AppError::Forbidden("Only current members of this conversation can be compared".into()));
            }
        } Ok::<(),AppError>(())
    };
    verify().await?;
    // Serialize with selection visibility changes; never consult full libraries.
    let _guard=crate::adapter::game_profiles::GAME_PROFILE_WRITES.lock().await;
    let mut boards=Vec::new();
    for &id in &ids {boards.push(state.wdb.get_game_profile(id)?.entries);}
    let games=intersection(&boards);
    verify().await?;
    Ok(Json(json!({"games":games,"participantCount":ids.len(),"basis":"shared-invitation-choices","compatibilityVerified":false})))
}
#[cfg(test)] mod tests {
    use super::*;
    fn entry(visibility:Visibility,invitations:bool)->GameSelection {GameSelection {key:"steam:570".into(),title:"Dota 2".into(),platform:"".into(),tags:vec![],note:"".into(),rotation:true,favorite:false,invitations,visibility}}
    #[test] fn private_games_never_change_intersection() {
        assert_eq!(intersection(&[vec![entry(Visibility::Server,true)],vec![entry(Visibility::Private,true)]]),Vec::<Value>::new());
        assert_eq!(intersection(&[vec![entry(Visibility::Server,true)],vec![entry(Visibility::Server,false)]]),Vec::<Value>::new());
        assert_eq!(intersection(&[vec![entry(Visibility::Server,true)],vec![entry(Visibility::Server,true)]]).len(),1);
    }
    #[test] fn identities_and_participants_are_exact() {
        for id in ["0","01","-1","4294967296","570/--flag"] {assert!(app_id(id).is_none());}
        assert_eq!(app_id("570"),Some(570));
        assert!(parse_participants(&["1".into(),"1".into()],1).is_err());
        assert!(parse_participants(&["2".into(),"3".into()],1).is_err());
    }
    #[test] fn selection_bounds_and_duplicates() {
        let e=entry(Visibility::Private,false);assert!(validate_entries(&[e.clone()]).is_ok());
        assert!(validate_entries(&[e.clone(),e]).is_err());
    }
}
