//! Real REST handlers, independent authenticated accounts, and durable WabiDB records.
use std::{path::Path,sync::Arc};
use axum::{body::{to_bytes,Body},http::{Method,Request,StatusCode},Router};
use base64::{engine::general_purpose::STANDARD,Engine};
use serde_json::{json,Value};
use tower::ServiceExt;
use yrs::{Doc,GetString,Options,ReadTxn,StateVector,Text,Transact,Update,updates::decoder::Decode};
use wabi_server::{api::routes::create_api_router,auth_extractor::JwtClaims,config::{LoreAddonConfig,ServerConfig,ServerRole},state::AppState};
use wabidb::engine::wabi_store::WabiStore;
async fn server(path:&Path)->Arc<AppState>{Arc::new(AppState::new(ServerConfig{host:"127.0.0.1".into(),port:0,data_dir:path.to_string_lossy().into_owned(),uploads_dir:path.join("uploads").to_string_lossy().into_owned(),jwt_secret:"workspace-contract-test-only".into(),turn_enabled:false,turn_uri:None,turn_secret:None,node_id:"test".into(),is_primary:true,server_role:ServerRole::Authority,authority_url:None,admin_user_ids:vec![],blacklist_file:path.join("blacklist").to_string_lossy().into_owned(),max_body_size:None,mesh_enabled:false,mesh_peers:vec![],lore:LoreAddonConfig::default()}).await.unwrap())}
fn jwt(state:&AppState,uid:u64)->String{let now=chrono::Utc::now().timestamp();jsonwebtoken::encode(&jsonwebtoken::Header::default(),&JwtClaims{sub:uid.to_string(),username:format!("user-{uid}"),is_guest:false,exp:now+3600,iat:now,jti:uuid::Uuid::new_v4().to_string(),stepup:false,token_type:"access".into()},&jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes())).unwrap()}
async fn request(app:&Router,method:Method,path:&str,token:&str,body:Value)->(StatusCode,Value){let mut builder=Request::builder().method(method).uri(path).header("content-type","application/json");if !token.is_empty(){builder=builder.header("authorization",format!("Bearer {token}"));}let response=app.clone().oneshot(builder.body(Body::from(body.to_string())).unwrap()).await.unwrap();let status=response.status();let bytes=to_bytes(response.into_body(),20*1024*1024).await.unwrap();(status,serde_json::from_slice(&bytes).unwrap_or_else(|_|json!(String::from_utf8_lossy(&bytes))))}
fn empty()->Doc{let mut options=Options::default();options.offset_kind=yrs::OffsetKind::Utf16;let doc=Doc::with_options(options);doc.get_or_insert_text("title");doc.get_or_insert_text("body");doc.get_or_insert_map("data");doc}
fn encoded(doc:&Doc)->String{STANDARD.encode(doc.transact().encode_state_as_update_v1(&StateVector::default()))}
fn apply(doc:&Doc,value:&str){let bytes=STANDARD.decode(value).unwrap();let update=Update::decode_v1(&bytes).unwrap();doc.transact_mut().apply_update(update).unwrap();}
fn fork(doc:&Doc)->Doc{let next=empty();apply(&next,&encoded(doc));next}
fn body(doc:&Doc)->String{doc.get_or_insert_text("body").get_string(&doc.transact())}
fn document()->Doc{let doc=empty();{let mut tx=doc.transact_mut();doc.get_or_insert_text("title").insert(&mut tx,0,"Shared lesson");doc.get_or_insert_text("body").insert(&mut tx,0,"Original คน 🙂");}doc}
async fn sync(app:&Router,id:&str,token:&str,doc:&Doc,generation:u64)->(StatusCode,Value){request(app,Method::POST,&format!("/workspace/artifacts/{id}/sync"),token,json!({"vector":"","update":encoded(doc),"generation":generation})).await}

#[tokio::test]
async fn workspace_http_acl_independent_writers_reviews_and_revocation(){
    let dir=tempfile::tempdir().unwrap();let state=server(dir.path()).await;
    let a=state.wdb.create_user("workspace-a",None,"hash").await.unwrap();let b=state.wdb.create_user("workspace-b",None,"hash").await.unwrap();let c=state.wdb.create_user("workspace-commenter",None,"hash").await.unwrap();let outsider=state.wdb.create_user("workspace-outsider",None,"hash").await.unwrap();
    let ta=jwt(&state,a);let tb=jwt(&state,b);let tc=jwt(&state,c);let to=jwt(&state,outsider);let app=create_api_router(state.clone()).with_state(state.clone());
    assert_eq!(request(&app,Method::GET,"/workspace/artifacts","",Value::Null).await.0,StatusCode::UNAUTHORIZED);
    let id=uuid::Uuid::new_v4().to_string();let base=document();let (status,created)=request(&app,Method::POST,"/workspace/artifacts",&ta,json!({"id":id,"kind":"document","format":"markdown","mode":"live","update":encoded(&base)})).await;assert_eq!(status,StatusCode::OK,"{created}");
    assert_eq!(request(&app,Method::POST,&format!("/workspace/artifacts/{id}/sync"),&tb,json!({"vector":""})).await.0,StatusCode::NOT_FOUND);
    let (_,list)=request(&app,Method::GET,"/workspace/artifacts",&to,Value::Null).await;assert_eq!(list["artifacts"],json!([]));
    let mut grants=serde_json::Map::new();grants.insert(b.to_string(),json!("editor"));grants.insert(c.to_string(),json!("commenter"));
    let (status,shared)=request(&app,Method::POST,&format!("/workspace/artifacts/{id}/access"),&ta,json!({"expectedRevision":1,"grants":grants,"channelId":null,"channelRole":"viewer","mode":"live"})).await;assert_eq!(status,StatusCode::OK,"{shared}");
    let aa=fork(&base);let bb=fork(&base);
    {let text=aa.get_or_insert_text("body");text.insert(&mut aa.transact_mut(),0,"A: ");}
    {let text=bb.get_or_insert_text("body");let mut tx=bb.transact_mut();let len=text.len(&tx);text.insert(&mut tx,len," :B");}
    let (status,ar)=sync(&app,&id,&ta,&aa,1).await;assert_eq!(status,StatusCode::OK,"{ar}");let (status,br)=sync(&app,&id,&tb,&bb,1).await;assert_eq!(status,StatusCode::OK,"{br}");apply(&aa,br["delta"].as_str().unwrap());apply(&bb,br["delta"].as_str().unwrap());assert_eq!(body(&aa),body(&bb));assert!(body(&aa).contains("A: "));assert!(body(&aa).contains(" :B"));assert!(body(&aa).contains("คน 🙂"));
    let (_,again)=sync(&app,&id,&ta,&aa,1).await;assert_eq!(again["meta"]["sequence"],br["meta"]["sequence"]);
    assert_eq!(sync(&app,&id,&tc,&aa,1).await.0,StatusCode::FORBIDDEN);
    let review_id=uuid::Uuid::new_v4().to_string();let (status,review)=request(&app,Method::POST,&format!("/workspace/artifacts/{id}/reviews"),&tc,json!({"action":"add","id":review_id,"kind":"suggestion","body":"Try this wording","proposal":"Proposed replacement","baseSequence":again["meta"]["sequence"]})).await;assert_eq!(status,StatusCode::OK,"{review}");assert_eq!(review["reviews"][0]["authorUserId"],c);
    assert_eq!(request(&app,Method::POST,&format!("/workspace/artifacts/{id}/reviews"),&tc,json!({"action":"add","id":uuid::Uuid::new_v4().to_string(),"kind":"comment","body":"Forged","authorUserId":a})).await.0,StatusCode::UNPROCESSABLE_ENTITY);
    {let text=aa.get_or_insert_text("body");text.insert(&mut aa.transact_mut(),0,"Newer work. ");}let (status,latest)=sync(&app,&id,&ta,&aa,1).await;assert_eq!(status,StatusCode::OK,"{latest}");
    let (status,rejected)=request(&app,Method::POST,&format!("/workspace/artifacts/{id}/reviews"),&ta,json!({"action":"accept","id":review_id})).await;assert_eq!(status,StatusCode::CONFLICT,"{rejected}");
    let (status,revoked)=request(&app,Method::POST,&format!("/workspace/artifacts/{id}/access"),&ta,json!({"expectedRevision":2,"grants":{},"channelId":null,"channelRole":"viewer","mode":"live"})).await;assert_eq!(status,StatusCode::OK,"{revoked}");
    assert_eq!(sync(&app,&id,&tb,&bb,1).await.0,StatusCode::NOT_FOUND);
    let (status,owner)=request(&app,Method::POST,&format!("/workspace/artifacts/{id}/sync"),&ta,json!({"vector":""})).await;assert_eq!(status,StatusCode::OK);let verified=empty();apply(&verified,owner["delta"].as_str().unwrap());assert!(body(&verified).starts_with("Newer work. "));assert!(!body(&verified).contains("Proposed replacement"));
}

#[tokio::test]
async fn workspace_crash_writer(){let Ok(path)=std::env::var("WABI_WORKSPACE_REPLAY_TEST")else{return;};let store=wabi_server::adapter::WdbAdapter::open(Path::new(&path)).await.unwrap();let uid=store.create_user("workspace-replay",None,"hash").await.unwrap();store.workspace_put(uid,"artifact:crash-record",0,uid,json!({"title":"Durable private lesson","checkpoint":encoded(&document()),"updates":[],"sequence":1})).await.unwrap();std::process::exit(0);}
#[tokio::test]
async fn workspace_acknowledged_record_survives_process_exit_without_snapshot(){let dir=tempfile::tempdir().unwrap();let result=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","workspace_crash_writer","--nocapture"]).env("WABI_WORKSPACE_REPLAY_TEST",dir.path()).status().unwrap();assert!(result.success());let store=wabi_server::adapter::WdbAdapter::open(dir.path()).await.unwrap();let user=store.get_user_by_username("workspace-replay").await.unwrap().unwrap();let record=store.workspace_get("artifact:crash-record").unwrap().unwrap();assert_eq!(record.owner_user_id,user.user_id);assert_eq!(record.revision,1);let doc=empty();apply(&doc,record.value["checkpoint"].as_str().unwrap());assert_eq!(body(&doc),"Original คน 🙂");}
