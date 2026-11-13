//! Core stands alone: the default build with every runtime switch off.
//!
//! `cargo build -p wabi-server` with no features is what a plain download is
//! (`default = []` in Cargo.toml). This test starts that binary from an empty
//! directory, the way `install_from_nothing_contract.rs` does, and holds it to
//! the add-on rules in AGENTS.md ("core Wabi should remain usable with optional
//! plugins/helpers disabled", "optional integrations must fail clearly when
//! dependencies are absent") and docs/VISION.md ("a tool may never weaken a
//! core guarantee"):
//!
//! 1. `GET /api/addons` tells the truth: it lists only what this binary holds,
//!    reports every add-on as switched off, and never claims a feature-gated
//!    add-on that was not compiled in;
//! 2. no add-on route answers with a 500 or a hang. Each is either absent
//!    (404 from the API fallback) or answers with a sentence that says the
//!    add-on is not enabled on this server;
//! 3. an add-on that is not in this build cannot be switched on, so nothing
//!    persists a switch that the binary cannot honour (a persisted
//!    `{"switches":{"lore":true}}` is read by instance_checkpoint and
//!    instance_archive as "Lore is in use" and blocks checkpoint/restore);
//! 4. a switched-off add-on has no process footprint: Tailcat binds no
//!    forwarder on the pipe port and spawns no `tailcat version` probe.
//!
//! The core journey itself — owner, invite, second account, channel message,
//! DM, stop, back up, restore — is covered on this same default build by
//! `install_from_nothing_contract.rs`; it is not repeated here.
//!
//! Stops the server with SIGINT, as the install contract does.
#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};

const OWNER: (&str, &str) = ("addon_audit_owner", "Owner-Passphrase-2026");

// ---------------------------------------------------------------------------
// The server process (same shape as install_from_nothing_contract.rs)
// ---------------------------------------------------------------------------

struct Server {
    child: Child,
    origin: String,
    port: u16,
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
    /// Start the default binary with a cleared environment: no add-on env var
    /// can leak in from whatever runs the test suite.
    async fn start(install: &Path) -> Server {
        let stderr = std::fs::File::create(install.with_extension("stderr.log")).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_wabi-server"));
        command
            .env_clear()
            .current_dir(install)
            .args(["--data-dir", "./data/wabi-server"])
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
        let port = address.rsplit(':').next().unwrap().parse().unwrap();
        let mut server = Server {
            child,
            origin: format!("http://{address}"),
            port,
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

    fn stop(mut self) {
        unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGINT) };
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "wabi-server did not stop cleanly: {status}");
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

/// One request, with a deadline: an add-on route that hangs fails the test
/// rather than stalling the suite.
async fn call(
    server: &Server,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Client::new()
        .request(method.clone(), format!("{}{path}", server.origin))
        .timeout(Duration::from_secs(20));
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

async fn ok(server: &Server, method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Value {
    let (status, value) = call(server, method.clone(), path, token, body).await;
    assert!(status.is_success(), "{method} {path}: {status} {value}");
    value
}

/// Every message a disabled add-on sends back has to read as "this server does
/// not run that", not as a server fault.
fn says_not_enabled(value: &Value) -> bool {
    let text = value["error"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
        .to_lowercase();
    text.contains("not enabled")
        || text.contains("is disabled")
        || text.contains("not available")
        || text.contains("not_found")
        || text.contains("not found")
        // The payment rails name the missing cargo feature instead.
        || text.contains("not enabled in this build")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_default_build_runs_with_every_addon_off() {
    let root = tempfile::tempdir().unwrap();
    let install = root.path().join("install");
    std::fs::create_dir(&install).unwrap();
    let server = Server::start(&install).await;

    // -----------------------------------------------------------------------
    // 1. The inventory is the single source of truth, and it tells the truth.
    // -----------------------------------------------------------------------
    let inventory = ok(&server, Method::GET, "/api/addons", None, None).await;
    let addons = inventory["addons"].as_array().expect("addons array").clone();
    assert!(
        !addons.is_empty(),
        "the inventory lists the always-compiled add-ons even when they are off"
    );

    for addon in &addons {
        let id = addon["id"].as_str().unwrap_or_default();
        assert!(
            addon["enabled"] == json!(false),
            "{id} reports itself enabled on a default build with nothing switched on: {addon}"
        );
        // The shape Settings → Add-ons needs to say how a row is attached.
        assert!(addon["compiled"].is_boolean(), "{id} has no `compiled`: {addon}");
        assert!(
            addon["runtimeSwitch"].is_boolean(),
            "{id} has no `runtimeSwitch`: {addon}"
        );
    }

    let ids: Vec<&str> = addons
        .iter()
        .filter_map(|addon| addon["id"].as_str())
        .collect();
    // Feature-gated add-ons are absent from a build that did not compile them.
    for absent in ["lore", "webhooks", "payments-crypto", "payments-eu", "payments-us"] {
        assert!(
            !ids.contains(&absent),
            "{absent} is not compiled into the default build but the inventory lists it: {ids:?}"
        );
    }
    // The retired mesh coordinator is not an add-on anyone can turn on.
    assert!(!ids.contains(&"mesh"), "the retired mesh addon is advertised: {ids:?}");
    // Always-compiled, runtime-gated add-ons are listed, switched off.
    for present in ["steam", "tailcat", "game-sync", "project-workers"] {
        assert!(
            ids.contains(&present),
            "{present} is compiled into every build and must be listed: {ids:?}"
        );
    }

    // A single add-on that is not in this build is not found, rather than
    // reported as something the server could serve.
    let (status, body) = call(&server, Method::GET, "/api/addons/lore", None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(says_not_enabled(&body), "{body}");

    // -----------------------------------------------------------------------
    // 2. Add-on routes: absent, or a clear answer. Never a 500, never a hang.
    // -----------------------------------------------------------------------
    let owner = ok(
        &server,
        Method::POST,
        "/api/auth/register",
        None,
        Some(json!({ "username": OWNER.0, "password": OWNER.1 })),
    )
    .await;
    let token = owner["accessToken"].as_str().expect("access token").to_string();

    let probes: &[(Method, &str, Option<Value>)] = &[
        // Lore: compiled out entirely on this build.
        (Method::GET, "/api/addons/lore/repos/1", None),
        (Method::GET, "/api/addons/lore/health", None),
        // Steam: compiled in, switched off.
        (Method::POST, "/api/steam/library", Some(json!({}))),
        // A well-formed body: axum deserializes before the handler's switch
        // check runs, so an empty object would be answered by the extractor.
        (
            Method::POST,
            "/api/steam/link/start",
            Some(json!({ "revision": "0" })),
        ),
        // Project workers: compiled in, switched off.
        (
            Method::POST,
            "/api/projects/ch_0000000000000001/workers",
            Some(json!({ "name": "probe" })),
        ),
        // Payment rails: compiled out on this build; the core payments route
        // stays, so the rail itself must say it is not in this build.
        (
            Method::POST,
            "/api/payments/intents",
            Some(json!({
                "provider": "payments-eu",
                "amountMinor": 100,
                "currency": "EUR",
                "methodId": "epc_qr",
                "providerRef": "DE02120300000000202051",
                "payeeName": "Example"
            })),
        ),
        // Runtime plugins: documented, but this binary serves no plugin API.
        (Method::GET, "/api/plugins", None),
    ];

    for (method, path, body) in probes {
        let (status, value) = call(&server, method.clone(), path, Some(&token), body.clone()).await;
        assert!(
            status != StatusCode::INTERNAL_SERVER_ERROR,
            "{method} {path} answered 500 on a server that simply does not run that add-on: {value}"
        );
        assert!(
            status.is_client_error(),
            "{method} {path} answered {status} with every add-on off: {value}"
        );
        assert!(
            says_not_enabled(&value),
            "{method} {path} answered {status} without saying the add-on is not enabled: {value}"
        );
    }

    // Two add-on routes answer 200 while off, on purpose: they are how the UI
    // learns to say "not enabled on this server" instead of guessing. Both
    // must report the switch rather than optimism.
    let capabilities = ok(&server, Method::GET, "/api/steam/capabilities", Some(&token), None).await;
    assert_eq!(
        capabilities["enabled"],
        json!(false),
        "Steam capabilities must report the switch: {capabilities}"
    );
    let connect = ok(
        &server,
        Method::GET,
        "/api/addons/tailcat/connect",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(
        connect["enabled"],
        json!(false),
        "Tailcat connect must report the switch: {connect}"
    );

    // -----------------------------------------------------------------------
    // 3. An add-on this binary does not hold cannot be switched on.
    // -----------------------------------------------------------------------
    let (status, body) = call(
        &server,
        Method::POST,
        "/api/addons/lore/switch",
        Some(&token),
        Some(json!({ "enabled": true })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a build without Lore accepted a switch for it: {body}"
    );
    assert!(says_not_enabled(&body), "{body}");

    // Nothing was persisted: a stored `lore: true` would make
    // instance_checkpoint and instance_archive refuse to checkpoint or restore.
    let switches = install.join("data/wabi-server/addons.json");
    if switches.exists() {
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&switches).unwrap()).unwrap();
        assert_ne!(
            stored["switches"]["lore"],
            json!(true),
            "a switch was persisted for an add-on this binary cannot serve: {stored}"
        );
    }

    // An add-on that IS in this build can still be switched, which is the
    // in-app detach path documented in docs/addons/ATTACH_DETACH.md.
    let flipped = ok(
        &server,
        Method::POST,
        "/api/addons/steam/switch",
        Some(&token),
        Some(json!({ "enabled": true })),
    )
    .await;
    assert_eq!(flipped["enabled"], json!(true), "{flipped}");
    let after = ok(&server, Method::GET, "/api/addons/steam", None, None).await;
    assert_eq!(
        after["enabled"],
        json!(true),
        "the inventory did not follow the switch: {after}"
    );
    // Put it back, so the rest of the test runs on a server with nothing on.
    ok(
        &server,
        Method::POST,
        "/api/addons/steam/switch",
        Some(&token),
        Some(json!({ "enabled": false })),
    )
    .await;

    // -----------------------------------------------------------------------
    // 4. A switched-off add-on has no footprint.
    // -----------------------------------------------------------------------
    // Tailcat used to bind 127.0.0.1:<server port + 1> on every boot, enabled
    // or not. Disabled means nothing is listening there.
    let pipe_port = server.port.saturating_add(1);
    let bound = std::net::TcpListener::bind(("127.0.0.1", pipe_port));
    assert!(
        bound.is_ok(),
        "Tailcat is switched off but something holds its pipe port {pipe_port}: {:?}",
        bound.err()
    );
    drop(bound);

    // The core app is unaffected by all of the above: the owner still reads
    // their own account over the normal API.
    let me = ok(&server, Method::GET, "/api/user/me", Some(&token), None).await;
    assert_eq!(me["username"], json!(OWNER.0), "{me}");

    server.stop();
}

/// The other half of the same rule, on a build that DOES contain Lore.
///
/// Lore's routes are mounted whenever the feature is compiled in, whether or
/// not the runtime switch is on and whether or not the external Lore service
/// answered its startup health check. Calling one with Lore off used to give
/// `500 Internal server error` — "this server is broken" rather than "this
/// server does not run that add-on".
///
/// Only compiled with `--features wabi-lore`; CI's `features-full` job runs it.
#[cfg(feature = "wabi-lore")]
#[tokio::test(flavor = "multi_thread")]
async fn a_lore_build_with_the_switch_off_says_so_instead_of_failing() {
    let root = tempfile::tempdir().unwrap();
    let install = root.path().join("install");
    std::fs::create_dir(&install).unwrap();
    // `Server::start` clears the environment, so WABI_LORE_ENABLED is unset:
    // Lore is compiled in and switched off, which is the default.
    let server = Server::start(&install).await;

    let inventory = ok(&server, Method::GET, "/api/addons", None, None).await;
    let lore = inventory["addons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|addon| addon["id"] == json!("lore"))
        .unwrap_or_else(|| panic!("a wabi-lore build must list lore: {inventory}"))
        .clone();
    assert_eq!(lore["enabled"], json!(false), "{lore}");
    assert_eq!(lore["cargoFeature"], json!("wabi-lore"), "{lore}");

    let owner = ok(
        &server,
        Method::POST,
        "/api/auth/register",
        None,
        Some(json!({ "username": OWNER.0, "password": OWNER.1 })),
    )
    .await;
    let token = owner["accessToken"].as_str().unwrap().to_string();

    let (status, body) = call(
        &server,
        Method::GET,
        "/api/addons/lore/repos/1",
        Some(&token),
        None,
    )
    .await;
    assert!(
        status != StatusCode::INTERNAL_SERVER_ERROR,
        "a Lore route answered 500 on a server that simply has Lore switched off: {body}"
    );
    assert!(
        status.is_client_error() && says_not_enabled(&body),
        "a Lore route answered {status} without saying the add-on is off: {body}"
    );

    // Lore IS in this build, so its switch is a real one.
    let flipped = ok(
        &server,
        Method::POST,
        "/api/addons/lore/switch",
        Some(&token),
        Some(json!({ "enabled": false })),
    )
    .await;
    assert_eq!(flipped["appliesOnRestart"], json!(true), "{flipped}");

    server.stop();
}
