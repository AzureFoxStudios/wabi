//! Genuine main-Wabi Office HTTP seed and read-only inactive history assertions.
//! Stored ACL equality is not restored API authorization. No guards are cleared.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, os::unix::fs::MetadataExt, path::Path, sync::Arc};
use tower::ServiceExt;
use wabi_server::{
    auth_extractor::JwtClaims, instance_archive::LiveArchiveReceipt, state::AppState,
};
use wabidb::{
    engine::{
        offline_inspect::{inspect_frozen, InspectionLimits},
        wabi_store::WabiStore,
    },
    projections::workspace::{self, WorkspaceRecord},
};
use yrs::{
    types::ToJson, updates::decoder::Decode, Any, Doc, GetString, Map, Options, ReadTxn,
    StateVector, Text, Transact, Update,
};

#[derive(Debug, PartialEq)]
struct Content {
    title: String,
    body: String,
    data: Value,
}
pub(super) struct SeededOffice {
    rows: BTreeMap<String, WorkspaceRecord>,
    contents: BTreeMap<String, Content>,
    // Retain the source router until capture; its restarted session is paused.
    _source_router: Router,
}
fn empty() -> Doc {
    let mut options = Options::default();
    options.offset_kind = yrs::OffsetKind::Utf16;
    let doc = Doc::with_options(options);
    doc.get_or_insert_text("title");
    doc.get_or_insert_text("body");
    doc.get_or_insert_map("data");
    doc
}
fn encoded(doc: &Doc) -> String {
    STANDARD.encode(
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default()),
    )
}
fn apply(doc: &Doc, encoded: &str) {
    doc.transact_mut()
        .apply_update(Update::decode_v1(&STANDARD.decode(encoded).unwrap()).unwrap())
        .unwrap();
}
fn structured(doc: &Doc, data: &Value) {
    let map = doc.get_or_insert_map("data");
    let mut tx = doc.transact_mut();
    for (key, value) in data.as_object().unwrap() {
        map.insert(
            &mut tx,
            key.as_str(),
            Any::from_json(&value.to_string()).unwrap(),
        );
    }
}
fn document(title: &str, body: &str, data: Value) -> Doc {
    let doc = empty();
    doc.get_or_insert_text("title")
        .insert(&mut doc.transact_mut(), 0, title);
    doc.get_or_insert_text("body")
        .insert(&mut doc.transact_mut(), 0, body);
    structured(&doc, &data);
    doc
}
fn decoded(row: &WorkspaceRecord) -> Content {
    let doc = empty();
    apply(&doc, row.value["checkpoint"].as_str().unwrap());
    for update in row.value["updates"].as_array().unwrap() {
        apply(&doc, update.as_str().unwrap());
    }
    let title = doc.get_or_insert_text("title");
    let body = doc.get_or_insert_text("body");
    let data = doc.get_or_insert_map("data");
    let tx = doc.transact();
    Content {
        title: title.get_string(&tx),
        body: body.get_string(&tx),
        data: serde_json::to_value(data.to_json(&tx)).unwrap(),
    }
}
fn token(state: &AppState, id: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: id.to_string(),
            username: format!("office-{id}"),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}
async fn request(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}
async fn ok(app: &Router, method: Method, path: &str, token: &str, body: Value) -> Value {
    let (status, value) = request(app, method, path, token, body).await;
    assert_eq!(status, StatusCode::OK, "{path}: {value}");
    value
}
async fn create(app: &Router, token: &str, kind: &str, doc: &Doc) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    ok(app,Method::POST,"/workspace/artifacts",token,json!({"id":id,"kind":kind,"format":if kind=="document"{"markdown"}else{"native"},"mode":"live","update":encoded(doc)})).await;
    id
}
async fn access(app: &Router, owner: &str, id: &str, revision: u64, grants: Value, mode: &str) {
    ok(app,Method::POST,&format!("/workspace/artifacts/{id}/access"),owner,json!({"expectedRevision":revision,"grants":grants,"channelId":null,"channelRole":"viewer","mode":mode})).await;
}

pub(super) async fn seed(state: Arc<AppState>, owner: u64) -> SeededOffice {
    let editor = state
        .wdb
        .create_user("checkpoint-office-editor", None, "fixture-hash")
        .await
        .unwrap();
    let commenter = state
        .wdb
        .create_user("checkpoint-office-commenter", None, "fixture-hash")
        .await
        .unwrap();
    let outsider = state
        .wdb
        .create_user("checkpoint-office-outsider", None, "fixture-hash")
        .await
        .unwrap();
    let (to, te, tc, tx) = (
        token(&state, owner),
        token(&state, editor),
        token(&state, commenter),
        token(&state, outsider),
    );
    let app = wabi_server::api::routes::create_api_router(state.clone()).with_state(state.clone());
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/workspace/capabilities",
            &tx,
            json!({"sheets":true,"present":true})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    ok(
        &app,
        Method::PUT,
        "/workspace/capabilities",
        &to,
        json!({"sheets":true,"present":true}),
    )
    .await;

    let doc = document("Captured lesson", "Original คน 🙂", json!({}));
    let document_id = create(&app, &to, "document", &doc).await;
    access(
        &app,
        &to,
        &document_id,
        1,
        json!({editor.to_string():"editor",commenter.to_string():"commenter"}),
        "live",
    )
    .await;
    doc.get_or_insert_text("body")
        .insert(&mut doc.transact_mut(), 0, "Durable revision: ");
    let sync_path = format!("/workspace/artifacts/{document_id}/sync");
    ok(
        &app,
        Method::POST,
        &sync_path,
        &te,
        json!({"vector":"","update":encoded(&doc),"generation":1}),
    )
    .await;
    let review = uuid::Uuid::new_v4().to_string();
    let review_path = format!("/workspace/artifacts/{document_id}/reviews");
    ok(&app,Method::POST,&review_path,&tc,json!({"action":"add","id":review,"kind":"comment","body":"Retain this review after capture"})).await;
    ok(
        &app,
        Method::POST,
        &review_path,
        &to,
        json!({"action":"resolve","id":review}),
    )
    .await;
    access(
        &app,
        &to,
        &document_id,
        2,
        json!({editor.to_string():"editor"}),
        "snapshot",
    )
    .await;
    assert_eq!(
        request(&app, Method::POST, &sync_path, &tc, json!({"vector":""}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &sync_path,
            &te,
            json!({"vector":"","update":encoded(&doc),"generation":1})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&app, Method::POST, &sync_path, &tx, json!({"vector":""}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );

    let (sheet, row, column, op) = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let cell = format!("{row}|{column}");
    let mut data = json!({"schema":1,"sheets":{sheet.clone():{"name":"Materials","position":0,"rows":{row.clone():{"id":row,"position":0}},"columns":{column.clone():{"id":column,"position":0}},"ops":{op.clone():{"id":op,"cell":cell,"input":"41","parents":[],"literal":41}},"styles":{},"structureEdits":{}}}});
    let workbook = document("Material stock", "", data.clone());
    let workbook_id = create(&app, &to, "sheets", &workbook).await;
    access(
        &app,
        &to,
        &workbook_id,
        1,
        json!({editor.to_string():"editor"}),
        "live",
    )
    .await;
    let sheet_revision = state
        .wdb
        .workspace_get(&format!("artifact:{workbook_id}"))
        .unwrap()
        .unwrap()
        .revision;
    ok(&app,Method::POST,&format!("/workspace/artifacts/{workbook_id}/protection"),&to,json!({"expectedRevision":sheet_revision,"ranges":[{"id":uuid::Uuid::new_v4().to_string(),"sheetId":sheet,"rows":[row],"columns":[column],"label":"Owner-protected stock"}]})).await;
    let next_op = uuid::Uuid::new_v4().to_string();
    data["sheets"][&sheet]["ops"][&next_op] =
        json!({"id":next_op,"cell":cell,"input":"43","parents":[op],"literal":43});
    structured(&workbook, &data);
    let sheet_sync = format!("/workspace/artifacts/{workbook_id}/sync");
    let before_denial = state
        .wdb
        .workspace_get(&format!("artifact:{workbook_id}"))
        .unwrap()
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            &sheet_sync,
            &te,
            json!({"vector":"","update":encoded(&workbook),"generation":1})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        state
            .wdb
            .workspace_get(&before_denial.key)
            .unwrap()
            .unwrap(),
        before_denial
    );
    ok(
        &app,
        Method::POST,
        &sheet_sync,
        &to,
        json!({"vector":"","update":encoded(&workbook),"generation":1}),
    )
    .await;

    let (visible, hidden) = (
        uuid::Uuid::new_v4().to_string(),
        uuid::Uuid::new_v4().to_string(),
    );
    let mut deck_data = json!({"schema":1,"aspect":1.7777777777777777,"slides":{visible.clone():{"title":"Roof making","body":"Visible audience lesson","position":0},hidden.clone():{"title":"Hidden planning","body":"Hidden draft slide","position":1,"hidden":true}}});
    let deck = document("Site operations", "", deck_data.clone());
    let deck_id = create(&app, &to, "present", &deck).await;
    access(
        &app,
        &to,
        &deck_id,
        1,
        json!({commenter.to_string():"viewer"}),
        "live",
    )
    .await;
    deck_data["slides"][&visible]["body"] = json!("Latest published audience lesson");
    structured(&deck, &deck_data);
    let changed = ok(
        &app,
        Method::POST,
        &format!("/workspace/artifacts/{deck_id}/sync"),
        &to,
        json!({"vector":"","update":encoded(&deck),"generation":1}),
    )
    .await;
    let session = uuid::Uuid::new_v4().to_string();
    let started=ok(&app,Method::POST,"/workspace/presentations",&to,json!({"id":session,"artifactId":deck_id,"channelId":null,"sourceSequence":changed["meta"]["sequence"]})).await;
    assert_eq!(started["slides"].as_array().unwrap().len(), 1);
    assert_eq!(started["slides"][0]["id"], visible);
    assert_eq!(
        started["slides"][0]["body"],
        "Latest published audience lesson"
    );
    let audience = ok(
        &app,
        Method::GET,
        &format!("/workspace/presentations/{session}"),
        &tc,
        Value::Null,
    )
    .await;
    assert!(audience["artifactId"].is_null());
    assert!(!audience.to_string().contains("Hidden draft slide"));
    let question = uuid::Uuid::new_v4().to_string();
    ok(&app,Method::POST,&format!("/workspace/presentations/{session}/questions"),&tc,json!({"action":"add","id":question,"slideId":visible,"body":"Will this survive recovery?"})).await;
    // A new source router models a source runtime restart, never opening the
    // candidate. It must lose the ephemeral controller lease/pointer.
    let restarted =
        wabi_server::api::routes::create_api_router(state.clone()).with_state(state.clone());
    let resumed = ok(
        &restarted,
        Method::GET,
        &format!("/workspace/presentations/{session}"),
        &to,
        Value::Null,
    )
    .await;
    assert_eq!(resumed["paused"], true);
    assert_eq!(resumed["controllerLost"], true);
    assert_eq!(resumed["controllerConnected"], false);
    assert!(resumed["pointer"].is_null());
    assert_eq!(resumed["generation"], 2);
    assert_eq!(resumed["questions"].as_array().unwrap().len(), 1);
    let mut private_deck = deck_data.clone();
    private_deck["slides"][&visible]["notes"] = json!("PRIVATE NOTES MUST STAY LOCAL");
    let refused_deck = document("Private notes refusal", "", private_deck);
    assert_eq!(request(&restarted, Method::POST, "/workspace/artifacts", &to,
        json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"present","format":"native","mode":"live","update":encoded(&refused_deck)})).await.0, StatusCode::BAD_REQUEST);
    drop(app);
    // Exercise disabled capabilities without deleting saved artifacts, then
    // capture a genuinely enabled sheets/presentation instance. The complete
    // history must retain these switch events as well as the final policy.
    ok(
        &restarted,
        Method::PUT,
        "/workspace/capabilities",
        &to,
        json!({"sheets":false,"present":false}),
    )
    .await;
    assert_eq!(
        request(
            &restarted,
            Method::POST,
            &sheet_sync,
            &to,
            json!({"vector":"","update":encoded(&workbook),"generation":1})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(request(&restarted, Method::POST, "/workspace/presentations", &to,
        json!({"id":uuid::Uuid::new_v4().to_string(),"artifactId":deck_id,"channelId":null,"sourceSequence":changed["meta"]["sequence"]})).await.0, StatusCode::FORBIDDEN);
    ok(
        &restarted,
        Method::PUT,
        "/workspace/capabilities",
        &to,
        json!({"sheets":true,"present":true}),
    )
    .await;
    let enabled = ok(
        &restarted,
        Method::GET,
        "/workspace/capabilities",
        &to,
        Value::Null,
    )
    .await;
    assert_eq!(enabled["sheets"], true);
    assert_eq!(enabled["present"], true);

    let rows: BTreeMap<_, _> = state
        .wdb
        .workspace_list("")
        .unwrap()
        .into_iter()
        .map(|row| (row.key.clone(), row))
        .collect();
    assert_eq!(rows.len(), 5, "settings, three artifacts and presentation");
    assert_eq!(
        rows["settings"].value,
        json!({"sheets":true,"present":true})
    );
    let document_row = &rows[&format!("artifact:{document_id}")];
    assert_eq!(document_row.value["generation"], 2);
    assert_eq!(document_row.value["accessRevision"], 3);
    assert!(document_row.value["grants"]
        .get(commenter.to_string())
        .is_none());
    assert_eq!(document_row.value["reviews"][0]["state"], "resolved");
    let workbook_row = &rows[&format!("artifact:{workbook_id}")];
    assert_eq!(
        workbook_row.value["protectedRanges"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    for id in [&document_id, &workbook_id, &deck_id] {
        assert!(
            !rows[&format!("artifact:{id}")].value["updates"]
                .as_array()
                .unwrap()
                .is_empty(),
            "durable appended delta must be exercised"
        );
    }
    let contents: BTreeMap<_, _> = rows
        .iter()
        .filter(|(key, _)| key.starts_with("artifact:"))
        .map(|(key, row)| (key.clone(), decoded(row)))
        .collect();
    assert_eq!(
        contents[&format!("artifact:{document_id}")].body,
        "Durable revision: Original คน 🙂"
    );
    assert_eq!(
        contents[&format!("artifact:{workbook_id}")].data["sheets"][&sheet]["ops"][&next_op]
            ["literal"]
            .as_f64(),
        Some(43.0)
    );
    assert_eq!(
        contents[&format!("artifact:{deck_id}")].data["slides"][&visible]["body"],
        "Latest published audience lesson"
    );
    SeededOffice {
        rows,
        contents,
        _source_router: restarted,
    }
}

pub(super) async fn inspect(seed: &SeededOffice, inactive: &Path, receipt: &LiveArchiveReceipt) {
    let engine = inactive.join("data/wabidb");
    let before = fs::metadata(engine.join(".lock")).unwrap();
    let guards: [Vec<u8>; 2] =
        ["live-checkpoint-v1", "writer-fenced-v1"].map(|name| fs::read(engine.join(name)).unwrap());
    let key: [u8; 32] = hex::decode(fs::read_to_string(engine.join("root_key")).unwrap().trim())
        .unwrap()
        .try_into()
        .unwrap();
    let inspected = inspect_frozen(
        &engine,
        &key,
        receipt.applied_commit_seq,
        &receipt.commit_prefix_fingerprint,
        InspectionLimits::default(),
    )
    .await
    .unwrap();
    assert!(inspected.receipt.full_history_replayed);
    assert!(inspected.receipt.persisted_projection_matches);
    let mut actual = BTreeMap::new();
    inspected
        .projection_state()
        .for_each(workspace::INDEX, |key, bytes| {
            let row = workspace::decode(bytes).unwrap();
            assert_eq!(key, row.key.as_bytes());
            assert!(actual.insert(row.key.clone(), row).is_none());
        });
    assert_eq!(
        actual, seed.rows,
        "every stored record, revision, ACL, review, protection, session and delta must match"
    );
    let contents: BTreeMap<_, _> = actual
        .iter()
        .filter(|(key, _)| key.starts_with("artifact:"))
        .map(|(key, row)| (key.clone(), decoded(row)))
        .collect();
    assert_eq!(
        contents, seed.contents,
        "decoded title/body/native sheet+deck must match all checkpoint+delta bytes"
    );
    assert_eq!(
        actual
            .values()
            .filter(|row| row.key.starts_with("session:"))
            .count(),
        1
    );
    let session = &actual
        .values()
        .find(|row| row.key.starts_with("session:"))
        .unwrap()
        .value;
    assert_eq!(session["paused"], true);
    assert_eq!(session["controllerLost"], true);
    assert_eq!(session["controllerGeneration"], 2);
    assert!(session.get("pointer").is_none());
    assert!(session.get("lease").is_none());
    drop(inspected);
    let after = fs::metadata(engine.join(".lock")).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
    for (name, expected) in ["live-checkpoint-v1", "writer-fenced-v1"]
        .into_iter()
        .zip(guards)
    {
        assert_eq!(fs::read(engine.join(name)).unwrap(), expected);
    }
    assert!(!receipt.full_instance_ready);
}
