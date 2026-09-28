use std::{net::SocketAddr, path::Path, sync::Arc};

use wabi_server::{
    anchor::create_anchor_router,
    app_router::build_app_router,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
    upload_registry::UploadKind,
};

fn test_config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "regional-test-jwt".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "regional-test".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: path.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig {
            enabled: false,
            mode: "sidecar".into(),
            server_url: "lore://localhost:10000".into(),
            binary_path: "lore".into(),
            data_dir: "/tmp/wabi-lore-regional-test".into(),
            default_blob_max_size_mb: 1024,
            auto_create_repos: true,
            recordings_channel_name: None,
        },
    }
}

async fn spawn(app: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (format!("http://{address}"), handle)
}

#[tokio::test]
async fn anchor_reuses_real_authority_upload_after_fresh_validation() {
    let temp = tempfile::tempdir().unwrap();
    let config = test_config(temp.path());
    let state = Arc::new(AppState::new(config.clone()).await.unwrap());
    state
        .upload_registry
        .publish_bytes(
            Path::new(&config.uploads_dir),
            state.wdb.engine(),
            "art.bin",
            "art.bin",
            None,
            None,
            Some(1),
            UploadKind::Attachment,
            b"art for three sites",
        )
        .await
        .unwrap();
    let (authority_url, authority) = spawn(build_app_router(state.clone())).await;
    std::env::set_var("WABI_ANCHOR_UPLOAD_CACHE_MB", "1");
    let anchor_router = create_anchor_router(authority_url).unwrap();
    std::env::remove_var("WABI_ANCHOR_UPLOAD_CACHE_MB");
    let (anchor_url, anchor) = spawn(anchor_router).await;
    let client = reqwest::Client::new();
    for (disposition, origin) in [
        ("miss", "http://localhost:5173"),
        ("hit", "http://127.0.0.1:5173"),
    ] {
        let response = client
            .get(format!("{anchor_url}/uploads/art.bin"))
            .header("origin", origin)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            origin
        );
        assert_eq!(
            response.headers().get("x-wabi-anchor-cache").unwrap(),
            disposition
        );
        assert_eq!(
            response.bytes().await.unwrap(),
            b"art for three sites".as_slice()
        );
    }
    state
        .upload_registry
        .revoke_canonical("art.bin", state.wdb.engine(), 1)
        .await
        .unwrap();
    assert_eq!(
        client
            .get(format!("{anchor_url}/uploads/art.bin"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::GONE
    );
    authority.abort();
    anchor.abort();
}
