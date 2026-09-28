//! Explicit, real-Authority smoke using the production child/profile/snapshot
//! modules. Run with WABI_HOST_TEST_BINARY=/absolute/path/to/wabi-server and
//! `cargo test --manifest-path scripts/host-safety/Cargo.toml -- --ignored`.
use crate::{archive, bounded, process::OwnedServer, profile};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "wabi-real-host-{}",
            profile::bootstrap_token().unwrap()
        ));
        archive::private_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn launch(binary: &Path, root: &Path, port: u16, token: &str) -> OwnedServer {
    let mut command = Command::new(binary);
    command.env_clear();
    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    archive::private_dir(&root.join("logs")).unwrap();
    command
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--data-dir",
        ])
        .arg(root.join("data"))
        .args([
            "--desktop-managed",
            "--print-bound-address",
            "--shutdown-on-stdin-close",
        ])
        .current_dir(root)
        .env("WABI_DESKTOP_BOOTSTRAP_TOKEN", token)
        .env("WABI_SERVER_ROLE", "authority")
        .env("WABI_MESH_ENABLED", "false")
        .env("WABI_LOG_DIR", root.join("logs"))
        .env("WABI_UPLOADS_DIR", root.join("data/uploads"));
    let mut child = OwnedServer::spawn(&mut command).unwrap();
    let errors = child.errors().unwrap();
    std::thread::spawn(move || {
        bounded::for_each_line(std::io::BufReader::new(errors), 8192, |line| {
            eprintln!("Authority: {line}")
        })
    });
    child
}

fn ready(child: &mut OwnedServer) -> SocketAddr {
    let output = child.output().unwrap();
    let pid = child.pid();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = bounded::for_each_line(std::io::BufReader::new(output), 8192, |line| {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                if value["event"] == "wabi-listener-bound"
                    && value["pid"] == pid
                    && value["protocolVersion"] == 1
                {
                    let _ = sender.send(
                        value["address"]
                            .as_str()
                            .unwrap()
                            .parse::<SocketAddr>()
                            .unwrap(),
                    );
                }
            }
        });
    });
    let address = receiver
        .recv_timeout(Duration::from_secs(60))
        .expect("Authority listener record");
    assert!(address.ip().is_loopback());
    assert_ne!(address.port(), 0);
    assert_eq!(request(address, "/readyz", None, None, None).0, 200);
    assert_eq!(
        request(address, "/api/setup/status", None, None, None).0,
        200
    );
    assert!(child.exited().unwrap().is_none());
    address
}

fn request(
    address: SocketAddr,
    path: &str,
    body: Option<Value>,
    bootstrap: Option<&str>,
    bearer: Option<&str>,
) -> (u16, Value) {
    let mut connection = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    connection
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let method = if body.is_some() { "POST" } else { "GET" };
    let bytes = body
        .map(|body| serde_json::to_vec(&body).unwrap())
        .unwrap_or_default();
    write!(connection, "{method} {path} HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", bytes.len()).unwrap();
    if let Some(token) = bootstrap {
        write!(connection, "X-Wabi-Bootstrap-Token: {token}\r\n").unwrap();
    }
    if let Some(token) = bearer {
        write!(connection, "Authorization: Bearer {token}\r\n").unwrap();
    }
    connection.write_all(b"\r\n").unwrap();
    connection.write_all(&bytes).unwrap();
    let mut response = Vec::new();
    connection
        .take(1024 * 1024)
        .read_to_end(&mut response)
        .unwrap();
    let boundary = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    let headers = std::str::from_utf8(&response[..boundary]).unwrap();
    let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = serde_json::from_slice(&response[boundary + 4..]).unwrap_or(Value::Null);
    (status, body)
}

#[test]
#[ignore = "Requires an explicitly supplied real Authority binary"]
fn real_authority_owner_restart_profile_lock_snapshot_and_restore() {
    let binary = fs::canonicalize(
        std::env::var_os("WABI_HOST_TEST_BINARY")
            .expect("Set WABI_HOST_TEST_BINARY to the freshly built Authority"),
    )
    .unwrap();
    let temporary = Temporary::new();
    let root = &temporary.0;
    let lease = profile::ProfileLease::acquire(root).unwrap();
    let token = profile::bootstrap_token().unwrap();
    let mut child = launch(&binary, root, 0, &token);
    let address = ready(&mut child);
    assert!(
        request(address, "/api/setup/status", None, None, None).1["setupRequired"]
            .as_bool()
            .unwrap()
    );
    let credentials = json!({"username":"host-owner", "password":"host-test-password", "communityName":"Native smoke community"});
    assert_eq!(
        request(
            address,
            "/api/auth/register",
            Some(credentials.clone()),
            None,
            None
        )
        .0,
        403
    );
    let owner = request(
        address,
        "/api/auth/register",
        Some(credentials),
        Some(&token),
        None,
    );
    assert_eq!(owner.0, 200, "{}", owner.1);
    assert_eq!(
        request(address, "/api/setup/status", None, None, None).1["setupRequired"],
        false
    );
    profile::save_new(root, address.port()).unwrap();
    let settings = profile::load(root).unwrap().unwrap();
    assert!(profile::ProfileLease::acquire(root).is_err());
    assert_eq!(
        request(
            address,
            "/api/auth/register",
            Some(json!({"username":"uninvited", "password":"host-test-password"})),
            None,
            None
        )
        .0,
        403
    );
    let owner_id = owner.1["user"]["id"].clone();
    assert!(child.stop(Duration::from_secs(10)).unwrap());
    drop(child);
    drop(lease);
    let _reopened_lease = profile::ProfileLease::acquire(root).unwrap();
    profile::validate_identity(root, &settings).unwrap();
    let backup = root.join("backup");
    archive::snapshot(&root.join("data"), &backup).unwrap();
    let jwt = fs::read(root.join("data/jwt_secret")).unwrap();
    let root_key = fs::read(root.join("data/wabidb/root_key")).unwrap();
    let mut child = launch(
        &binary,
        root,
        settings.port,
        &profile::bootstrap_token().unwrap(),
    );
    assert_eq!(ready(&mut child), address);
    let login = request(
        address,
        "/api/auth/login",
        Some(json!({"username":"host-owner", "password":"host-test-password"})),
        None,
        None,
    );
    assert_eq!(login.0, 200, "{}", login.1);
    assert_eq!(login.1["user"]["id"], owner_id);
    assert!(archive::install_restore(
        &backup,
        &root.join("data"),
        &root.join("staging"),
        &root.join("original")
    )
    .is_err());
    assert!(!root.join("original").exists());
    assert!(child.stop(Duration::from_secs(10)).unwrap());
    drop(child);
    archive::install_restore(
        &backup,
        &root.join("data"),
        &root.join("staging"),
        &root.join("original"),
    )
    .unwrap();
    assert!(root.join("original/wabidb/root_key").is_file());
    let mut restored = launch(
        &binary,
        root,
        settings.port,
        &profile::bootstrap_token().unwrap(),
    );
    assert_eq!(ready(&mut restored), address);
    assert_eq!(
        request(
            address,
            "/api/auth/login",
            Some(json!({"username":"host-owner", "password":"host-test-password"})),
            None,
            None
        )
        .0,
        200
    );
    assert!(restored.stop(Duration::from_secs(10)).unwrap());
    assert_eq!(fs::read(root.join("data/jwt_secret")).unwrap(), jwt);
    assert_eq!(
        fs::read(root.join("data/wabidb/root_key")).unwrap(),
        root_key
    );
    profile::validate_identity(root, &settings).unwrap();
}
