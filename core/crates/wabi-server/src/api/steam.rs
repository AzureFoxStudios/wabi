//! Opt-in Steam adapter. Libraries are owner-only, on demand, and never broadcast.
//! OpenID uses a browser receipt AND the initiating Wabi session; no password or
//! Wabi bearer token appears in a redirect, callback page, or imported library.
use axum::{extract::{DefaultBodyLimit, RawQuery, State}, http::{header, HeaderValue}, response::{Html, IntoResponse, Response}, Json, Router};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, sync::Arc, time::{Duration, Instant}};
use crate::{auth_extractor::AuthUser, error::{AppError, Result}, state::AppState};
use super::games::{account, bad, text};

const OP: &str = "https://steamcommunity.com/openid/login";
const NS: &str = "http://specs.openid.net/auth/2.0";
const LIBRARY: &str = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
const FLOW_TTL: Duration = Duration::from_secs(600);
pub type SharedHttpClient = Arc<reqwest::Client>;
pub fn shared_http_client() -> SharedHttpClient {
    Arc::new(reqwest::Client::builder().https_only(true)
        .redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(12))
        .build().expect("Steam HTTPS client configuration"))
}
pub fn enabled() -> bool { std::env::var("WABI_STEAM_ENABLED").as_deref() == Ok("1") }
fn key() -> Option<String> { std::env::var("STEAM_API_KEY").ok().map(|s|s.trim().to_string()).filter(|s|!s.is_empty()) }
fn require_enabled() -> Result<()> { if enabled() { Ok(()) } else { Err(AppError::NotFound("Steam addon is disabled on this server".into())) } }
fn origin(raw: &str) -> Result<String> {
    let u = reqwest::Url::parse(raw).map_err(|_|bad("Configure WABI_STEAM_PUBLIC_URL as an HTTPS origin"))?;
    let loopback = matches!(u.host_str(), Some("localhost"|"127.0.0.1"|"[::1]"));
    if (u.scheme() != "https" && !(u.scheme()=="http" && loopback)) || u.host_str().is_none()
        || !u.username().is_empty() || u.password().is_some() || u.path()!="/" || u.query().is_some() || u.fragment().is_some() {
        return Err(bad("WABI_STEAM_PUBLIC_URL must be an HTTPS origin without path, credentials, query, or fragment"));
    }
    Ok(u.origin().ascii_serialization())
}
fn configured_origin() -> Result<String> {
    origin(&std::env::var("WABI_STEAM_PUBLIC_URL").map_err(|_|bad("WABI_STEAM_PUBLIC_URL is not configured"))?)
}
fn secret() -> String { let mut b=[0u8;32]; rand::rngs::OsRng.fill_bytes(&mut b); hex::encode(b) }
fn digest(s: &str) -> [u8;32] { Sha256::digest(s.as_bytes()).into() }
fn same_secret(a: &[u8;32], b: &[u8;32]) -> bool { a.iter().zip(b).fold(0u8, |v,(a,b)|v|(a^b)) == 0 }
fn valid_secret(s: &str) -> bool { s.len()==64 && s.bytes().all(|b|b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }
fn steam_id(s: &str) -> bool {
    s.len()==17 && s.bytes().all(|b|b.is_ascii_digit()) && s.parse::<u64>().ok().is_some_and(|n|
        n >> 56 == 1 && (n >> 52) & 15 == 1 && (n >> 32) & 0xfffff == 1)
}

// All runtime data belongs to one AppState, never a process-global user map.
// The old public-ID status cache is intentionally retired.
#[derive(Default)]
pub struct SteamCache {
    flows: HashMap<String, Flow>,
    nonces: HashMap<String, Instant>,
    limits: HashMap<(u64, &'static str), (Instant, u8)>,
}
struct Flow {
    owner: u64, session: String, expires: Instant, return_to: String,
    proof: [u8;32], revision: String, stage: Stage,
}
enum Stage { Waiting, Verifying, Verified { steam_id: String, receipt: [u8;32] } }
impl SteamCache {
    fn prune(&mut self) {
        let now=Instant::now();
        self.flows.retain(|_,f|f.expires>now);
        self.nonces.retain(|_,until|*until>now);
        self.limits.retain(|_,(start,_)|start.elapsed()<FLOW_TTL);
    }
    fn admit(&mut self, uid: u64, action: &'static str, max: u8) -> Result<()> {
        self.prune();
        if self.limits.len()>=2048 && !self.limits.contains_key(&(uid,action)) {return Err(AppError::TooManyRequests("Steam service is busy".into()));}
        let e=self.limits.entry((uid,action)).or_insert((Instant::now(),0));
        if e.0.elapsed()>=Duration::from_secs(60) { *e=(Instant::now(),0); }
        if e.1>=max {return Err(AppError::TooManyRequests("Please wait before trying Steam again".into()));}
        e.1+=1; Ok(())
    }
}
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/capabilities",axum::routing::get(capabilities))
        .route("/link/start",axum::routing::post(start))
        .route("/link/callback",axum::routing::get(callback))
        .route("/link/complete",axum::routing::post(complete))
        .route("/unlink",axum::routing::post(unlink))
        .route("/library",axum::routing::post(library))
        .route("/status",axum::routing::get(retired_status))
        .route("/rich-presence",axum::routing::get(retired_status))
        .layer(DefaultBodyLimit::max(16384))
        .layer(axum::middleware::from_fn(super::games::no_store))
        .with_state(state)
}
async fn capabilities(auth: AuthUser, State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    account(&state,&auth).await?;
    Ok(Json(json!({"enabled":enabled(),"linking":enabled() && configured_origin().is_ok(),
        "library":enabled() && key().is_some(),"liveActivity":false,"sessionJoining":false})))
}
async fn retired_status(auth: AuthUser, State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    account(&state,&auth).await?;
    Ok(Json(json!({"enabled":false,"status":null,"reason":"Live activity sharing is not implemented. Use the curated game board."})))
}
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
struct Revision { revision: String }
async fn start(auth: AuthUser, State(state): State<Arc<AppState>>, Json(body): Json<Revision>) -> Result<Json<Value>> {
    require_enabled()?; let uid=account(&state,&auth).await?;
    if auth.jti.is_empty() {return Err(AppError::Unauthorized("Sign in again before linking Steam".into()));}
    let base=configured_origin()?;
    let row=state.wdb.get_game_profile(uid)?;
    if row.revision!=body.revision || row.steam_id.is_some() {return Err(AppError::Conflict("Reload your profile; unlink an existing account before replacing it".into()));}
    let ticket=secret(); let proof=secret();
    let return_to=format!("{base}/api/steam/link/callback?ticket={ticket}");
    let mut url=reqwest::Url::parse(OP).expect("constant URL");
    url.query_pairs_mut().extend_pairs([
        ("openid.ns",NS),("openid.mode","checkid_setup"),("openid.realm",base.as_str()),
        ("openid.return_to",return_to.as_str()),
        ("openid.identity","http://specs.openid.net/auth/2.0/identifier_select"),
        ("openid.claimed_id","http://specs.openid.net/auth/2.0/identifier_select")]);
    let mut runtime=state.steam_cache.lock().await;
    runtime.admit(uid,"start",4)?;
    if runtime.flows.len()>=256 {return Err(AppError::TooManyRequests("Too many pending Steam connections".into()));}
    // Starting again invalidates this account's older handoffs.
    runtime.flows.retain(|_,f|f.owner!=uid);
    runtime.flows.insert(ticket.clone(),Flow { owner:uid,session:auth.jti,expires:Instant::now()+FLOW_TTL,
        return_to,proof:digest(&proof),revision:row.revision,stage:Stage::Waiting });
    Ok(Json(json!({"ticket":ticket,"proof":proof,"authorizeUrl":url.as_str(),"expiresIn":600})))
}
fn callback_fields(raw: &str) -> Result<HashMap<String,String>> {
    if raw.len()>12288 {return Err(bad("Oversized Steam callback"));}
    let url=reqwest::Url::parse(&format!("https://callback.invalid/?{raw}")).map_err(|_|bad("Invalid callback"))?;
    let mut fields=HashMap::new();
    for (k,v) in url.query_pairs() {
        if fields.len()>=24 || k.len()>64 || v.len()>4096 || (k!="ticket" && !k.starts_with("openid."))
            || fields.insert(k.into_owned(),v.into_owned()).is_some() {return Err(bad("Invalid or duplicate callback parameter"));}
    } Ok(fields)
}
fn assertion(fields: &HashMap<String,String>, expected_return: &str, now: i64) -> Result<(String,String)> {
    let get=|k: &str|fields.get(k).map(String::as_str).unwrap_or("");
    if get("openid.ns")!=NS || get("openid.mode")!="id_res" || get("openid.op_endpoint")!=OP
        || get("openid.return_to")!=expected_return || get("openid.identity")!=get("openid.claimed_id") {
        return Err(bad("Steam assertion does not match this connection"));
    }
    // Fixed Steam-owned identifier namespace: no arbitrary provider discovery or SSRF.
    let id=get("openid.claimed_id").strip_prefix("https://steamcommunity.com/openid/id/")
        .or_else(||get("openid.claimed_id").strip_prefix("http://steamcommunity.com/openid/id/"))
        .filter(|id|steam_id(id)).ok_or_else(||bad("Invalid Steam identity"))?;
    let signed:HashSet<_>=get("openid.signed").split(',').collect();
    if ["op_endpoint","claimed_id","identity","return_to","response_nonce","assoc_handle"].iter().any(|k|!signed.contains(k))
        || get("openid.sig").is_empty() || get("openid.assoc_handle").is_empty() {return Err(bad("Incomplete signed Steam assertion"));}
    let nonce=get("openid.response_nonce");
    if nonce.len()<20 || nonce.len()>255 || !nonce.is_ascii() || nonce.bytes().any(|b|b<=32 || b>=127) || &nonce[19..20]!="Z" {
        return Err(bad("Invalid Steam nonce"));
    }
    let stamp=chrono::DateTime::parse_from_rfc3339(&nonce[..20]).map_err(|_|bad("Invalid Steam nonce timestamp"))?.timestamp();
    if stamp<now-600 || stamp>now+60 {return Err(bad("Steam connection expired; start again"));}
    Ok((id.into(),nonce.into()))
}
async fn bounded(mut response: reqwest::Response, maximum: usize) -> Result<Vec<u8>> {
    if !response.status().is_success() {return Err(AppError::BadRequest("Steam is unavailable or rejected the request; nothing was imported".into()));}
    if response.content_length().is_some_and(|n|n>maximum as u64) {return Err(bad("Steam response exceeds the size limit"));}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|bad("Steam response could not be read"))? {
        if chunk.len()>maximum.saturating_sub(bytes.len()) {return Err(bad("Steam response exceeds the size limit"));}
        bytes.extend_from_slice(&chunk);
    } Ok(bytes)
}
fn verified_body(bytes: &[u8]) -> bool {
    let Ok(body)=std::str::from_utf8(bytes) else {return false;};
    let mut fields=HashMap::new();
    for line in body.lines().filter(|s|!s.is_empty()) {
        let Some((k,v))=line.split_once(':') else {return false;};
        if fields.insert(k,v).is_some() {return false;}
    }
    fields.get("ns")==Some(&NS) && fields.get("is_valid")==Some(&"true")
}
async fn callback(State(state): State<Arc<AppState>>, RawQuery(raw): RawQuery) -> Result<Response> {
    require_enabled()?;
    let fields=callback_fields(raw.as_deref().unwrap_or(""))?;
    let ticket=fields.get("ticket").filter(|s|valid_secret(s)).ok_or_else(||bad("Missing connection ticket"))?;
    let (steam_id, nonce)={
        let mut runtime=state.steam_cache.lock().await; runtime.prune();
        let flow=runtime.flows.get(ticket).ok_or_else(||bad("Connection expired; start again in Wabi"))?;
        if !matches!(flow.stage,Stage::Waiting) {return Err(bad("This callback has already been used"));}
        let result=assertion(&fields,&flow.return_to,chrono::Utc::now().timestamp())?;
        if runtime.nonces.contains_key(&result.1) || runtime.nonces.len()>=4096 {return Err(bad("Steam nonce was already used or service is busy"));}
        runtime.nonces.insert(result.1.clone(),Instant::now()+FLOW_TTL+Duration::from_secs(60));
        runtime.flows.get_mut(ticket).expect("flow exists").stage=Stage::Verifying;
        result
    };
    let mut form=reqwest::Url::parse("https://form.invalid/").expect("constant URL");
    for (k,v) in &fields {if k.starts_with("openid.") {form.query_pairs_mut().append_pair(k,if k=="openid.mode" {"check_authentication"} else {v});}}
    let response=state.steam_http.post(OP).header(header::CONTENT_TYPE,"application/x-www-form-urlencoded")
        .body(form.query().unwrap_or("").to_string()).send().await.map_err(|_|bad("Could not verify with Steam; start again"))?;
    if !verified_body(&bounded(response,8192).await?) {return Err(bad("Steam rejected the verification"));}
    let receipt=secret();
    {
        let mut runtime=state.steam_cache.lock().await; runtime.prune();
        let flow=runtime.flows.get_mut(ticket).ok_or_else(||bad("Connection cancelled or expired"))?;
        if !matches!(flow.stage,Stage::Verifying) {return Err(bad("Connection no longer pending"));}
        flow.stage=Stage::Verified {steam_id:steam_id.clone(),receipt:digest(&receipt)};
    }
    // Receipt is only returned to the authenticated Steam browser, never exposed
    // by a polling endpoint. A forwarded auth URL cannot silently bind an account.
    let _=nonce;
    let mut response=Html(format!("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Complete Steam connection</title><h1>Steam verified</h1><p>Steam account {steam_id}</p><p>Only continue if you started this connection in Wabi. Copy the code below into that Wabi window, then choose Finish connecting. Do not send this code to anyone.</p><p style='overflow-wrap:anywhere'><code>{receipt}</code></p><p>This code expires in ten minutes. No library or activity has been shared.</p>")).into_response();
    response.headers_mut().insert(header::CONTENT_SECURITY_POLICY,HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
    Ok(response)
}
#[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)]
struct Complete { ticket: String, proof: String, receipt: String }
async fn complete(auth: AuthUser, State(state): State<Arc<AppState>>, Json(body): Json<Complete>) -> Result<Json<Value>> {
    require_enabled()?; let uid=account(&state,&auth).await?;
    if !valid_secret(&body.ticket) || !valid_secret(&body.proof) || !valid_secret(&body.receipt) {return Err(bad("Paste the complete connection code"));}
    let mut runtime=state.steam_cache.lock().await; runtime.admit(uid,"complete",8)?;
    let flow=runtime.flows.get(&body.ticket).ok_or_else(||bad("Connection expired; start again"))?;
    if flow.owner!=uid || flow.session!=auth.jti || !same_secret(&flow.proof,&digest(&body.proof)) {return Err(AppError::Forbidden("Use the Wabi session that started this connection".into()));}
    let Stage::Verified {steam_id,receipt}= &flow.stage else {return Err(bad("Complete Steam sign-in first"));};
    if !same_secret(receipt,&digest(&body.receipt)) {return Err(bad("Connection code does not match"));}
    let id=steam_id.clone(); let revision=flow.revision.clone();
    runtime.flows.remove(&body.ticket); // one-shot even when outcome becomes uncertain
    // Serialize unlink against completion: lock order is always runtime -> profile.
    let row=state.wdb.mutate_game_profile(uid,&revision,|r|{
        if r.steam_id.is_some() {return Err(AppError::Conflict("Unlink the old Steam account first".into()));}
        r.steam_id=Some(id);r.show_steam_link=false;Ok(())
    }).await?;
    Ok(Json(json!({"revision":row.revision,"entries":row.entries,"steamId":row.steam_id,"showSteamLink":row.show_steam_link})))
}
async fn unlink(auth: AuthUser, State(state): State<Arc<AppState>>, Json(body): Json<Revision>) -> Result<Json<Value>> {
    // Always permit disconnect/cleanup, even if the operator disabled the addon.
    let uid=account(&state,&auth).await?;
    let mut runtime=state.steam_cache.lock().await;
    runtime.flows.retain(|_,f|f.owner!=uid);
    let row=state.wdb.mutate_game_profile(uid,&body.revision,|r|{r.steam_id=None;r.show_steam_link=false;Ok(())}).await?;
    Ok(Json(json!({"revision":row.revision,"entries":row.entries,"steamId":null,"showSteamLink":false})))
}
fn library_entries(value: &Value) -> Result<Value> {
    let response=value.get("response").and_then(Value::as_object).ok_or_else(||bad("Malformed Steam library response"))?;
    let Some(count)=response.get("game_count").and_then(Value::as_u64) else {
        return Ok(json!({"availability":"unavailable","games":[],"reason":"Steam did not expose game details. Manual entry still works."}));
    };
    if count>20000 {return Err(bad("Steam library exceeds the supported import size"));}
    let mut games=Vec::new();let mut seen=HashSet::new();
    if let Some(items)=response.get("games") {
        let items=items.as_array().ok_or_else(||bad("Malformed Steam games list"))?;
        if items.len()>20000 {return Err(bad("Steam library exceeds the supported import size"));}
        for item in items {
            let id=item.get("appid").and_then(Value::as_u64).filter(|n|*n>0 && *n<=u32::MAX as u64).ok_or_else(||bad("Invalid Steam game ID"))?;
            let title=item.get("name").and_then(Value::as_str).filter(|s|text(s,120,true)).ok_or_else(||bad("Invalid Steam game title"))?;
            if seen.insert(id) {games.push(json!({"key":format!("steam:{id}"),"title":title}));}
        }
    } else if count>0 {return Err(bad("Steam library response is incomplete"));}
    if games.len()!=count as usize {return Err(bad("Steam library response is incomplete"));}
    Ok(json!({"availability":"available","games":games}))
}
async fn library(auth: AuthUser, State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    require_enabled()?;let uid=account(&state,&auth).await?;
    let api_key=key().ok_or_else(||bad("The server has no Steam API key; manual entry and linking still work"))?;
    let row=state.wdb.get_game_profile(uid)?;
    let id=row.steam_id.as_deref().filter(|s|steam_id(s)).ok_or_else(||bad("Connect your Steam account first"))?;
    {
        let mut runtime=state.steam_cache.lock().await;
        runtime.admit(0,"upstream",30)?;runtime.admit(uid,"library",2)?;
    }
    // Fixed HTTPS destination, no redirects; never propagate a reqwest error that
    // could include the key-bearing URL. Library data is not cached or persisted.
    let input=json!({"steamid":id.parse::<u64>().map_err(|_|bad("Invalid Steam ID"))?,"include_appinfo":true,"include_played_free_games":true}).to_string();
    let response=state.steam_http.get(LIBRARY).query(&[("key",api_key.as_str()),("input_json",input.as_str())])
        .send().await.map_err(|_|bad("Steam library is unavailable; try again later"))?;
    let value:Value=serde_json::from_slice(&bounded(response,4*1024*1024).await?).map_err(|_|bad("Malformed Steam library response"))?;
    let library=library_entries(&value)?;
    account(&state,&auth).await?;
    if state.wdb.get_game_profile(uid)?.steam_id!=row.steam_id {return Err(AppError::Conflict("Steam connection changed during import".into()));}
    Ok(Json(library))
}

#[cfg(test)] mod tests {
    use super::*;
    fn fields() -> HashMap<String,String> {
        [("openid.ns",NS),("openid.mode","id_res"),("openid.op_endpoint",OP),
        ("openid.return_to","https://wabi.test/api/steam/link/callback?ticket=test"),
        ("openid.identity","https://steamcommunity.com/openid/id/76561198000000000"),
        ("openid.claimed_id","https://steamcommunity.com/openid/id/76561198000000000"),
        ("openid.signed","op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle"),
        ("openid.sig","signature"),("openid.assoc_handle","handle"),("openid.response_nonce","2026-09-12T00:00:00Zunique")]
            .into_iter().map(|(k,v)|(k.into(),v.into())).collect()
    }
    #[test] fn steam_assertion_checks_every_security_binding() {
        let good=fields();let now=chrono::DateTime::parse_from_rfc3339("2026-09-12T00:00:00Z").unwrap().timestamp();
        let ret=good["openid.return_to"].clone();assert!(assertion(&good,&ret,now).is_ok());
        for key in ["openid.ns","openid.mode","openid.op_endpoint","openid.identity","openid.claimed_id","openid.return_to","openid.signed","openid.sig","openid.assoc_handle","openid.response_nonce"] {
            let mut bad=good.clone();bad.insert(key.into(),"".into());assert!(assertion(&bad,&ret,now).is_err(),"{key}");
        }
        assert!(assertion(&good,&ret,now+601).is_err());assert!(assertion(&good,&ret,now-61).is_err());
        let mut bad=good;bad.insert("openid.response_nonce".into(),"💥".repeat(25));assert!(assertion(&bad,&ret,now).is_err());
    }
    #[test] fn steam_callback_rejects_duplicates_and_untrusted_urls() {
        assert!(callback_fields("ticket=a&ticket=b").is_err());
        assert!(callback_fields("url=https://evil.invalid").is_err());
        for value in ["https://a.test/path","https://u:p@a.test","https://a.test/?x=1","http://a.test","https://a.test/#x"] {assert!(origin(value).is_err());}
        assert_eq!(origin("https://wabi.chat").unwrap(),"https://wabi.chat");
        assert!(origin("http://127.0.0.1:3000").is_ok());
    }
    #[test] fn steam_direct_verification_is_exact() {
        assert!(verified_body(format!("ns:{NS}\nis_valid:true\n").as_bytes()));
        for body in ["is_valid:true", "is_valid:trueevil", "ns:bad\nis_valid:true", "is_valid:false\nis_valid:true"] {assert!(!verified_body(body.as_bytes()));}
    }
    #[test] fn steam_library_is_minimal_and_private_is_not_empty_success() {
        let v=library_entries(&json!({"response":{"game_count":1,"games":[{"appid":570,"name":"Dota 2","playtime_forever":1234,"img_icon_url":"tracking"}]}})).unwrap();
        assert!(!v.to_string().contains("playtime"));assert!(!v.to_string().contains("tracking"));
        assert_eq!(library_entries(&json!({"response":{}})).unwrap()["availability"],"unavailable");
        assert!(library_entries(&json!({"response":{"game_count":1}})).is_err());
        assert_eq!(library_entries(&json!({"response":{"game_count":0}})).unwrap()["games"],json!([]));
    }
    #[test] fn steam_secrets_and_rate_limits_are_bounded() {
        let s=secret();assert!(valid_secret(&s));assert!(same_secret(&digest(&s),&digest(&s)));assert!(!same_secret(&digest(&s),&digest("other")));
        assert!(steam_id("76561198000000000"));assert!(!steam_id("123"));assert!(!steam_id("76561198000000000/"));
        let mut runtime=SteamCache::default();assert!(runtime.admit(1,"test",1).is_ok());assert!(runtime.admit(1,"test",1).is_err());
    }
}
