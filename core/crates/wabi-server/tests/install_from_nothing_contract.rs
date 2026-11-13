//! Install-from-nothing acceptance (docs/testing/INSTALL_FROM_NOTHING.md).
//!
//! One journey, end to end, against the real `wabi-server` binary and only
//! its public interfaces (command line, HTTP API, Socket.IO), from an empty
//! directory:
//!
//! 1. start the server the way docs/deployment/INSTALL.md says, with the
//!    environment cleared and nothing created beforehand;
//! 2. the first account to register becomes the owner (INSTALL.md pitfall 2);
//! 3. the owner creates an invitation; a second person registers with it;
//! 4. both exchange a message in the starter `general` channel and in a DM;
//! 5. stop the server, copy the data directory (BACKUP_AND_RECOVERY.md,
//!    "stop, copy, start"), copy that backup into a new empty directory
//!    ("Restore onto a clean Authority"), start a server on it and read the
//!    channel message back;
//! 6. the number of environment variables and files the operator has to
//!    provide stays within the budget below.
//!
//! Why a Rust contract test and not the `container-install` job: this runs in
//! the existing `cargo test --workspace` step with no Docker daemon, no
//! network beyond loopback, no browser and no new harness. Cargo hands the
//! test the binary it just built (`CARGO_BIN_EXE_wabi-server`), the same way
//! `first_boot_onboarding.rs` and `recovery_node_contract.rs` already start
//! it. The Compose path stays covered by `scripts/authority-compose-smoke.mjs`.
//!
//! Deliberate differences from a person following the guide, all of them
//! about running safely in CI rather than about configuration:
//! - `--host 127.0.0.1 --port 0 --print-bound-address` instead of
//!   `--host 0.0.0.0 --port 3000`, so parallel tests never fight over a port
//!   and nothing listens beyond loopback;
//! - the server is stopped with SIGINT, which is what Ctrl+C sends;
//! - the frontend is not checked: an empty `frontend/build` is enough to
//!   compile, and the Compose smoke checks the embedded app.

// Stops the server with SIGINT and copies with `cp -a`, as the guide does.
#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// The budget. These lists are what an operator must supply before the first
// start. The server is launched with `env_clear()` plus exactly
// `REQUIRED_ENV`, into a directory holding exactly `REQUIRED_FILES`, so a new
// requirement makes this test fail until it is written down here.
//
// RAISING EITHER BUDGET MUST BE A DELIBERATE EDIT. Add a comment naming the
// variable or file, why it cannot have a safe default, and update the counts
// in docs/testing/INSTALL_FROM_NOTHING.md in the same change. VISION.md
// question 2: "does this add another file an operator has to remember?"
// ---------------------------------------------------------------------------

/// Environment variables the operator must set. Zero today: first boot
/// generates and persists the JWT secret and WabiDB root key.
const REQUIRED_ENV: &[(&str, &str)] = &[];
const ENV_BUDGET: usize = 0;

/// Files the operator must create before the first start (path relative to
/// the install directory, contents). Zero today: the server creates its data
/// directory itself. INSTALL.md's `mkdir -p data/wabi-server uploads plugins`
/// is not needed; this test proves it by not running it.
const REQUIRED_FILES: &[(&str, &str)] = &[];
const FILE_BUDGET: usize = 0;

/// The data directory the guide names (`--data-dir ./data/wabi-server`).
const DATA_DIR: &str = "data/wabi-server";

const OWNER: (&str, &str) = ("first_owner", "Owner-Passphrase-2026");
const FRIEND: (&str, &str) = ("invited_friend", "Friend-Passphrase-2026");

// ---------------------------------------------------------------------------
// The server process
// ---------------------------------------------------------------------------

struct Server {
    child: Child,
    origin: String,
    install: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

impl Server {
    /// Start the binary in `install` the way INSTALL.md's cargo path does,
    /// with a cleared environment.
    async fn start(install: &Path) -> Server {
        let stderr = std::fs::File::create(install.with_extension("stderr.log")).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_wabi-server"));
        command
            .env_clear()
            .envs(REQUIRED_ENV.iter().copied())
            .current_dir(install)
            .args(["--data-dir", &format!("./{DATA_DIR}")])
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--print-bound-address",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr));
        let mut child = command.spawn().expect("start wabi-server");
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        // Keep draining stdout for the life of the process so it never blocks.
        std::thread::spawn(move || {
            let mut sender = Some(sender);
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(record) = serde_json::from_str::<Value>(&line) {
                    if record["event"] == "wabi-listener-bound" {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(record["address"].as_str().unwrap().to_string());
                        }
                    }
                }
            }
        });
        let address = receiver
            .recv_timeout(Duration::from_secs(60))
            .unwrap_or_else(|_| {
                panic!(
                    "no listener address; see {}",
                    install.with_extension("stderr.log").display()
                )
            });
        let mut server = Server {
            child,
            origin: format!("http://{address}"),
            install: install.to_path_buf(),
        };
        server.wait_ready().await;
        server
    }

    async fn wait_ready(&mut self) {
        let client = Client::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!(
                    "wabi-server exited before readiness ({status}): {}",
                    std::fs::read_to_string(self.install.with_extension("stderr.log"))
                        .unwrap_or_default()
                );
            }
            if let Ok(response) = client.get(format!("{}/readyz", self.origin)).send().await {
                if response.status().is_success() {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("wabi-server did not become ready");
    }

    /// Ctrl+C, then wait for a clean exit. Backups are only taken of a
    /// stopped server (BACKUP_AND_RECOVERY.md).
    fn stop(mut self) {
        unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGINT) };
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "wabi-server did not stop cleanly: {status}"
                );
                return;
            }
            assert!(
                Instant::now() < deadline,
                "wabi-server did not stop after Ctrl+C"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP and Socket.IO, the way a client uses them
// ---------------------------------------------------------------------------

async fn call(
    server: &Server,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Client::new().request(method.clone(), format!("{}/api{path}", server.origin));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .unwrap_or_else(|e| panic!("{method} {path}: {e}"));
    let status = response.status();
    let text = response.text().await.unwrap();
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
}

async fn ok(
    server: &Server,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Value {
    let (status, value) = call(server, method.clone(), path, token, body).await;
    assert!(status.is_success(), "{method} {path}: {status} {value}");
    value
}

fn token(auth: &Value) -> String {
    auth["accessToken"]
        .as_str()
        .expect("access token")
        .to_string()
}

async fn messages(server: &Server, token: &str, channel: &str) -> Vec<String> {
    let value = ok(
        server,
        Method::GET,
        &format!("/messages/{channel}"),
        Some(token),
        None,
    )
    .await;
    value["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("message list: {value}"))
        .iter()
        .map(|message| message["content"].as_str().unwrap_or_default().to_string())
        .collect()
}

/// Engine.IO v4 long-polling: the transport the browser falls back to and the
/// one `dm_encryption_contract.rs` drives in-process. Needed because DMs are
/// opened over Socket.IO (`create-dm`), not REST.
struct Socket {
    url: String,
    http: Client,
    events: Vec<Value>,
}

impl Socket {
    async fn connect(server: &Server, token: &str, username: &str) -> Socket {
        let http = Client::new();
        let base = format!("{}/socket.io/?EIO=4&transport=polling", server.origin);
        let open = http.get(&base).send().await.unwrap().text().await.unwrap();
        let handshake: Value =
            serde_json::from_str(open.strip_prefix('0').expect("engine.io open")).unwrap();
        let mut socket = Socket {
            url: format!("{base}&sid={}", handshake["sid"].as_str().unwrap()),
            http,
            events: vec![],
        };
        socket
            .post(format!("40{}", json!({ "token": token })))
            .await;
        socket
            .event("init-or-connect", |packet| packet.starts_with("40"))
            .await;
        socket.emit("join", json!(username)).await;
        socket.wait("init").await;
        socket
    }

    async fn post(&self, body: String) {
        let response = self
            .http
            .post(&self.url)
            .header("content-type", "text/plain;charset=UTF-8")
            .body(body)
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "socket post: {}",
            response.status()
        );
    }

    async fn emit(&self, event: &str, payload: Value) {
        self.post(format!("42{}", json!([event, payload]))).await;
    }

    /// Poll until a raw packet matches; record every event seen on the way.
    async fn event(&mut self, what: &str, matches: impl Fn(&str) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let batch = self
                .http
                .get(&self.url)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            let mut found = false;
            for packet in batch.split('\u{1e}') {
                if packet == "2" {
                    self.post("3".into()).await; // answer the server's ping
                }
                if let Some(event) = packet.strip_prefix("42") {
                    self.events.push(serde_json::from_str(event).unwrap());
                }
                found |= matches(packet);
            }
            if found {
                return;
            }
        }
        panic!("socket: no {what}");
    }

    async fn wait(&mut self, name: &str) -> Value {
        loop {
            if let Some(index) = self.events.iter().position(|event| event[0] == name) {
                return self.events.remove(index)[1].clone();
            }
            self.event(name, |packet| packet.starts_with("42")).await;
        }
    }
}

/// `cp -a SOURCE DEST`, the command BACKUP_AND_RECOVERY.md uses.
fn cp_a(source: &Path, destination: &Path) {
    let status = Command::new("cp")
        .arg("-a")
        .arg(source)
        .arg(destination)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "cp -a {} {}",
        source.display(),
        destination.display()
    );
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_blank_machine_reaches_two_people_talking_and_a_restored_backup() {
    // 6. The budget, checked first so a raise is visible before anything runs.
    assert!(
        REQUIRED_ENV.len() <= ENV_BUDGET,
        "required environment variables ({:?}) exceed the install budget of {ENV_BUDGET}",
        REQUIRED_ENV
            .iter()
            .map(|(name, _)| name)
            .collect::<Vec<_>>()
    );
    assert!(
        REQUIRED_FILES.len() <= FILE_BUDGET,
        "required operator files ({:?}) exceed the install budget of {FILE_BUDGET}",
        REQUIRED_FILES
            .iter()
            .map(|(path, _)| path)
            .collect::<Vec<_>>()
    );

    let root = tempfile::tempdir().unwrap();
    let install = root.path().join("install");
    std::fs::create_dir(&install).unwrap();
    for (path, contents) in REQUIRED_FILES {
        let path = install.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    assert_eq!(
        std::fs::read_dir(&install).unwrap().count(),
        REQUIRED_FILES.len(),
        "the install directory holds only the budgeted files before first start"
    );

    // 1. Server running.
    let server = Server::start(&install).await;
    assert!(
        install.join(DATA_DIR).join("wabidb/root_key").exists(),
        "first boot persisted the root key"
    );
    assert!(
        install.join(DATA_DIR).join("jwt_secret").exists(),
        "first boot persisted the JWT secret"
    );
    let setup = ok(&server, Method::GET, "/setup/status", None, None).await;
    assert_eq!(setup["setupRequired"], true, "{setup}");

    // 2. Owner account: the first registration claims the server.
    let owner = ok(
        &server,
        Method::POST,
        "/auth/register",
        None,
        Some(json!({ "username": OWNER.0, "password": OWNER.1 })),
    )
    .await;
    let owner_token = token(&owner);
    let me = ok(&server, Method::GET, "/user/me", Some(&owner_token), None).await;
    assert_eq!(me["isOwner"], true, "{me}");
    let setup = ok(&server, Method::GET, "/setup/status", None, None).await;
    assert_eq!(setup["setupRequired"], false, "{setup}");

    // 3. Invitation, and a second person registering with it.
    let invite = ok(
        &server,
        Method::POST,
        "/invites",
        Some(&owner_token),
        Some(json!({ "expiresInHours": 24 })),
    )
    .await;
    let invite_token = invite["token"]
        .as_str()
        .expect("invitation token")
        .to_string();
    let friend = ok(
        &server,
        Method::POST,
        "/auth/register",
        None,
        Some(json!({ "username": FRIEND.0, "password": FRIEND.1, "inviteToken": invite_token })),
    )
    .await;
    let friend_token = token(&friend);
    let friend_id = friend["user"]["id"].as_i64().expect("friend id");
    let friend_me = ok(&server, Method::GET, "/user/me", Some(&friend_token), None).await;
    assert_ne!(
        friend_me["isOwner"], true,
        "the invited person is not an owner: {friend_me}"
    );
    // The invitation is one use.
    let (status, _) = call(
        &server,
        Method::POST,
        "/auth/register",
        None,
        Some(json!({ "username": "second_use", "password": "Second-Use-2026", "inviteToken": invite_token })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a used invitation is refused"
    );

    // 4a. Channel: the starter `general` text channel the owner's first run made.
    let listed = ok(&server, Method::GET, "/channels", Some(&friend_token), None).await;
    let general = listed["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|channel| channel["name"] == "general" && channel["channel_type"] == "text")
        .unwrap_or_else(|| panic!("starter text channel visible to the invited person: {listed}"))
        ["id"]
        .as_str()
        .unwrap()
        .to_string();
    ok(
        &server,
        Method::POST,
        &format!("/channels/{general}/join"),
        Some(&friend_token),
        None,
    )
    .await;
    const OWNER_SAYS: &str = "Welcome! This message has to survive a backup and restore.";
    const FRIEND_SAYS: &str = "Thanks for the invite.";
    ok(
        &server,
        Method::POST,
        "/messages",
        Some(&owner_token),
        Some(json!({ "channel_id": general, "content": OWNER_SAYS })),
    )
    .await;
    ok(
        &server,
        Method::POST,
        "/messages",
        Some(&friend_token),
        Some(json!({ "channel_id": general, "content": FRIEND_SAYS })),
    )
    .await;
    for reader in [&owner_token, &friend_token] {
        let seen = messages(&server, reader, &general).await;
        assert!(
            seen.iter().any(|m| m == OWNER_SAYS) && seen.iter().any(|m| m == FRIEND_SAYS),
            "{seen:?}"
        );
    }

    // 4b. DM. New DMs start "encryption pending" (AGENTS.md). Without device
    // keys, plain text needs each sender's explicit server-readable choice;
    // this asserts only what the server itself reports and enforces.
    let mut owner_socket = Socket::connect(&server, &owner_token, OWNER.0).await;
    owner_socket
        .emit(
            "create-dm",
            json!({ "targetUserId": format!("user-{friend_id}") }),
        )
        .await;
    let dm = owner_socket.wait("dm-created").await["channelId"]
        .as_str()
        .expect("DM channel id")
        .to_string();
    let status = ok(
        &server,
        Method::GET,
        &format!("/e2ee/channels/{dm}"),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(
        status["pendingDefault"], true,
        "server reports the new DM as encryption pending: {status}"
    );
    let (refused, _) = call(
        &server,
        Method::POST,
        "/messages",
        Some(&owner_token),
        Some(json!({ "channel_id": dm, "content": "before choosing" })),
    )
    .await;
    assert!(
        !refused.is_success(),
        "plain text before an explicit choice is refused, got {refused}"
    );
    const OWNER_DM: &str = "DM from the owner";
    const FRIEND_DM: &str = "DM back from the friend";
    for (sender, text) in [(&owner_token, OWNER_DM), (&friend_token, FRIEND_DM)] {
        ok(
            &server,
            Method::POST,
            &format!("/e2ee/channels/{dm}/allow-server-readable"),
            Some(sender),
            None,
        )
        .await;
        ok(
            &server,
            Method::POST,
            "/messages",
            Some(sender),
            Some(json!({ "channel_id": dm, "content": text })),
        )
        .await;
    }
    for reader in [&owner_token, &friend_token] {
        let seen = messages(&server, reader, &dm).await;
        assert!(
            seen.iter().any(|m| m == OWNER_DM) && seen.iter().any(|m| m == FRIEND_DM),
            "{seen:?}"
        );
    }

    // 5. Backup: stop, copy the data directory, (start again).
    server.stop();
    let backup = root.path().join("wabi-backups/2026-11-13");
    std::fs::create_dir_all(&backup).unwrap();
    cp_a(&install.join(DATA_DIR), &backup);
    assert!(
        backup.join("wabi-server/wabidb/root_key").exists(),
        "the backup carries the root key"
    );
    let original = Server::start(&install).await;
    original.stop();

    // Restore into a new empty directory: copy the backed-up data directory
    // as one unit to where the guide's command expects it, leaving the copied
    // `wabidb/.lock` in place, and start only the Authority.
    let restored_install = root.path().join("restored");
    std::fs::create_dir_all(restored_install.join("data")).unwrap();
    cp_a(&backup.join("wabi-server"), &restored_install.join("data"));
    let restored = Server::start(&restored_install).await;
    let livez = Client::new()
        .get(format!("{}/livez", restored.origin))
        .send()
        .await
        .unwrap();
    assert!(livez.status().is_success());

    // The owner signs in with a password (no token carried over) and reads
    // the channel message; the invited person can still sign in too.
    let owner_again = ok(
        &restored,
        Method::POST,
        "/auth/login",
        None,
        Some(json!({ "username": OWNER.0, "password": OWNER.1 })),
    )
    .await;
    let owner_again = token(&owner_again);
    let me = ok(&restored, Method::GET, "/user/me", Some(&owner_again), None).await;
    assert_eq!(me["isOwner"], true, "ownership survives restore: {me}");
    let seen = messages(&restored, &owner_again, &general).await;
    assert!(
        seen.iter().any(|m| m == OWNER_SAYS) && seen.iter().any(|m| m == FRIEND_SAYS),
        "restored channel: {seen:?}"
    );
    let friend_again = ok(
        &restored,
        Method::POST,
        "/auth/login",
        None,
        Some(json!({ "username": FRIEND.0, "password": FRIEND.1 })),
    )
    .await;
    let seen = messages(&restored, &token(&friend_again), &dm).await;
    assert!(
        seen.iter().any(|m| m == OWNER_DM) && seen.iter().any(|m| m == FRIEND_DM),
        "restored DM: {seen:?}"
    );
    restored.stop();
}
