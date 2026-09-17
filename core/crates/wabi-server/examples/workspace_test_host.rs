//! Development-only acceptance host. Never included in the normal server executable.
//! Creates synthetic accounts in an explicit temporary directory and listens only on loopback.
use std::{path::PathBuf,sync::Arc};
use serde_json::json;
use wabi_server::{api::routes::create_api_router,auth_extractor::JwtClaims,config::{LoreAddonConfig,ServerConfig,ServerRole},state::AppState};
use wabidb::engine::wabi_store::WabiStore;

#[tokio::main]
async fn main()->Result<(),Box<dyn std::error::Error>>{
    let root=PathBuf::from(std::env::var("WABI_WORKSPACE_E2E_DIR").map_err(|_|"WABI_WORKSPACE_E2E_DIR must name an isolated temporary test directory")?);
    std::fs::create_dir_all(&root)?;
    if root.join("host.json").exists(){return Err("Refusing to replace an existing acceptance host directory".into());}
    let state=Arc::new(AppState::new(ServerConfig{
        host:"127.0.0.1".into(),port:0,data_dir:root.join("data").to_string_lossy().into_owned(),uploads_dir:root.join("uploads").to_string_lossy().into_owned(),
        jwt_secret:uuid::Uuid::new_v4().to_string(),turn_enabled:false,turn_uri:None,turn_secret:None,node_id:"workspace-acceptance-only".into(),is_primary:true,
        server_role:ServerRole::Authority,authority_url:None,admin_user_ids:vec![],blacklist_file:root.join("blacklist").to_string_lossy().into_owned(),max_body_size:None,mesh_enabled:false,mesh_peers:vec![],lore:LoreAddonConfig::default(),
    }).await?);
    let mut accounts=Vec::new();
    for name in ["Alice","Bob","Carol"]{
        let id=state.wdb.create_user(name,None,"test-fixture-only").await?;
        let now=chrono::Utc::now().timestamp();
        let token=jsonwebtoken::encode(&jsonwebtoken::Header::default(),&JwtClaims{sub:id.to_string(),username:name.into(),is_guest:false,exp:now+7200,iat:now,jti:uuid::Uuid::new_v4().to_string(),stepup:false,token_type:"access".into()},&jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()))?;
        accounts.push(json!({"id":id,"name":name,"token":token}));
    }
    state.wdb.workspace_put(accounts[0]["id"].as_u64().unwrap(),"settings",0,accounts[0]["id"].as_u64().unwrap(),json!({"sheets":true,"present":true})).await?;
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address=listener.local_addr()?;
    let app=axum::Router::new().nest("/api",create_api_router(state.clone())).with_state(state);
    std::fs::write(root.join("host.json"),serde_json::to_vec(&json!({"authorityUrl":format!("http://{address}"),"accounts":accounts}))?)?;
    eprintln!("Workspace acceptance Authority ready on loopback");
    axum::serve(listener,app).with_graceful_shutdown(async{let _=tokio::signal::ctrl_c().await;}).await?;
    Ok(())
}
