//! Desktop-owned Authority: one persistent community, the ordinary server/data
//! format, and a private stdin lifetime lease. No arbitrary executable/URL IPC.
mod archive;
mod bounded;
#[cfg(not(mobile))]
mod lan;
mod process;
mod profile;

use process::OwnedServer;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
pub struct HostState(pub tokio::sync::Mutex<Host>);
#[derive(Default)]
pub struct Host {
    child: Option<OwnedServer>,
    address: Option<SocketAddr>,
    lan: bool,
    error: Option<String>,
    clean: bool,
    lease: Option<profile::ProfileLease>,
    bootstrap_token: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    running: bool,
    ready: bool,
    setup_required: Option<bool>,
    local_url: Option<String>,
    sharing: &'static str,
    error: Option<String>,
    data_directory: String,
    backup_ids: Vec<String>,
    binary_available: bool,
    build_revision: &'static str,
    test_build: bool,
    has_community: bool,
    server_id: Option<String>,
    community_name: Option<String>,
    log_directory: String,
}

pub(crate) fn authorize(window: &tauri::WebviewWindow) -> Result<()> {
    if cfg!(mobile) {
        return Err("Hosting runs on desktop, not this mobile client".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    if !local_main_origin(window.label(), &url, cfg!(debug_assertions)) {
        return Err("Hosting controls are available only in Wabi's local main window".into());
    }
    Ok(())
}

pub(crate) fn local_main_origin(label: &str, url: &url::Url, development: bool) -> bool {
    if label != "main" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let packaged = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    let development = development
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(5173);
    packaged || development
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hosting");
    archive::private_dir(&root)?;
    Ok(root)
}
pub(crate) fn binary(app: &tauri::AppHandle) -> Result<PathBuf> {
    // Tauri externalBin is installed beside the executable, never searched
    // in the working directory or an untrusted PATH supplied by the frontend.
    let filename = if cfg!(windows) {
        "wabi-server.exe"
    } else {
        "wabi-server"
    };
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = executable
        .parent()
        .ok_or("Cannot locate application directory")?;
    let mut candidates = vec![parent.join(filename)];
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(filename));
    }
    candidates.into_iter().find(|p| p.is_file())
        .ok_or_else(|| "This installation does not include the Authority. Install a Wabi hosting package; Docker and Node are not required.".into())
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}
async fn local_request(
    host: &Host,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value> {
    let address = host.address.ok_or("Start the community first")?;
    let url = format!("http://127.0.0.1:{}{path}", address.port());
    let client = client()?;
    let mut request = if let Some(body) = body {
        client.post(url).json(&body)
    } else {
        client.get(url)
    };
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if path == "/api/auth/register" {
        request = request.header(
            "X-Wabi-Bootstrap-Token",
            host.bootstrap_token
                .as_deref()
                .ok_or("Owner setup lease is unavailable; restart the community")?,
        );
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("Local Authority did not respond: {e}"))?;
    let status = response.status();
    if response.content_length().unwrap_or(0) > 1024 * 1024 {
        return Err("Unexpectedly large Authority response".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read Authority response".to_string())?
    {
        bounded::append(&mut bytes, &chunk, 1024 * 1024).map_err(|e| e.to_string())?;
    }
    let body: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Authority response".to_string())?;
    if !status.is_success() {
        // Report server errors, never include request headers/passwords/tokens.
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| body.get("message").and_then(Value::as_str))
            .unwrap_or("Request refused");
        return Err(format!("{message} ({status})"));
    }
    Ok(body)
}
fn check_exit(host: &mut Host) -> Result<()> {
    if let Some(child) = host.child.as_mut() {
        if let Some(status) = child.exited().map_err(|e| e.to_string())? {
            host.clean = status.success();
            host.error = Some(format!("The community stopped unexpectedly ({status}). Data was kept. Restart it or check the logs."));
            host.child = None;
            host.address = None;
            host.bootstrap_token = None;
        }
    }
    Ok(())
}
async fn stop(host: &mut Host) -> Result<bool> {
    host.address = None;
    host.bootstrap_token = None;
    if let Some(mut child) = host.child.take() {
        // Blocking shutdown runs off the async executor and never uses a saved PID.
        host.clean = tokio::task::spawn_blocking(move || child.stop(Duration::from_secs(10)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        if !host.clean {
            host.error = Some("The server needed a forced stop. Restart and check recovery before taking a backup.".into());
        }
    }
    Ok(host.clean)
}
async fn start_inner(app: &tauri::AppHandle, host: &mut Host, lan: bool) -> Result<()> {
    check_exit(host)?;
    if host.child.is_some() {
        return Ok(());
    }
    let root = root(app)?;
    let executable = binary(app)?;
    if host.lease.is_none() {
        host.lease = Some(profile::ProfileLease::acquire(&root)?);
    }
    let settings = profile::load(&root)?;
    if let Some(settings) = &settings {
        profile::validate_identity(&root, settings)?;
    }
    let port = settings.as_ref().map_or(0, |settings| settings.port);
    let bootstrap_token = profile::bootstrap_token()?;
    archive::private_dir(&root.join("data"))?;
    archive::private_dir(&root.join("logs"))?;
    // First desktop communities are invite-only. Never overwrite an operator's
    // existing policy, and never reopen registration because parsing failed.
    let policy = root.join("data/admin_policies.json");
    match fs::read(&policy) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
                "Damaged admission policy; repair or restore it before starting".to_string()
            })?;
            if !value.is_object() {
                return Err("Invalid admission policy".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            archive::write_private(&policy, br#"{"auth_policy":{"mode":"invite","allowRegister":true,"allowGuest":false,"emailVerifyRequired":false}}"#)?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let mut command = Command::new(&executable);
    command.env_clear();
    // OS runtime variables only. Never inherit WABI_ADMIN_USER_IDS, root keys,
    // maintenance modes, helper settings, uploads paths or deployment secrets.
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
    command.args(["--host", if lan { "0.0.0.0" } else { "127.0.0.1" }, "--port", &port.to_string(), "--data-dir"])
        .arg(root.join("data"))
        .args(["--print-bound-address", "--shutdown-on-stdin-close", "--desktop-managed"])
        .current_dir(&root)
        .env("WABI_SERVER_ROLE", "authority").env("WABI_MESH_ENABLED", "false")
        .env("WABI_DESKTOP_BOOTSTRAP_TOKEN", &bootstrap_token)
        .env("WABI_LOG_DIR", root.join("logs"))
        .env("WABI_UPLOADS_DIR", root.join("data/uploads"))
        .env("WABI_CORS_ORIGINS", "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:5173");
    // The field pilot is a deliberate local opt-in. Forward only its exact
    // enabled value; keep the desktop Authority's general env isolation.
    if std::env::var("WABI_FIELD_PILOT").as_deref() == Ok("1") {
        command.env("WABI_FIELD_PILOT", "1");
    }
    // Optional bundled private transport remains a helper, never the Authority.
    let tailcat = executable.with_file_name(if cfg!(windows) {
        "tailcat.exe"
    } else {
        "tailcat"
    });
    if tailcat.is_file() {
        command.env("WABI_TAILCAT_BINARY", tailcat);
    }
    let mut child = OwnedServer::spawn(&mut command)
        .map_err(|e| format!("Cannot launch the bundled Authority: {e}"))?;
    let pid = child.pid();
    if let Some(errors) = child.errors() {
        let log = root.join("logs").join(format!(
            "startup-{pid}-{}.log",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        ));
        archive::write_private(&log, b"")?;
        std::thread::Builder::new()
            .name("wabi-host-errors".into())
            .spawn(move || {
                use std::io::Write;
                if let Ok(mut file) = fs::OpenOptions::new().append(true).open(log) {
                    // Always drain stderr so a full pipe cannot stall the Authority.
                    // Bound retained startup diagnostics to one MiB per launch.
                    let mut remaining = 1024 * 1024;
                    let _ = bounded::for_each_line(std::io::BufReader::new(errors), 8192, |line| {
                        if line.len() + 1 <= remaining {
                            let _ = writeln!(file, "{line}");
                            remaining -= line.len() + 1;
                        }
                    });
                }
            })
            .map_err(|e| e.to_string())?;
    }
    let output = child.output().ok_or("Authority output pipe unavailable")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("wabi-host-address".into())
        .spawn(move || {
            let mut sender = Some(tx);
            let _ = bounded::for_each_line(std::io::BufReader::new(output), 8192, |line| {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    if value["event"] == "wabi-listener-bound"
                        && value["protocolVersion"] == 1
                        && value["pid"] == pid
                    {
                        if let Some(tx) = sender.take() {
                            let _ = tx.send(value["address"].as_str().unwrap_or("").to_string());
                        }
                    }
                }
            });
        })
        .map_err(|e| e.to_string())?;
    host.child = Some(child);
    host.error = None;
    host.clean = false;
    host.lan = lan;
    host.bootstrap_token = Some(bootstrap_token);
    let result: Result<()> = async {
        let value = tokio::time::timeout(Duration::from_secs(60), rx).await
            .map_err(|_| "Authority startup timed out; inspect hosting/logs".to_string())?
            .map_err(|_| "Authority stopped during startup. The port may be occupied, data locked, or recovery may have failed; inspect hosting/logs.".to_string())?;
        let address: SocketAddr = value.parse().map_err(|_| "Invalid Authority listener record".to_string())?;
        let expected = if lan { "0.0.0.0" } else { "127.0.0.1" };
        if address.ip().to_string() != expected || address.port() == 0 || (port != 0 && port != address.port()) { return Err("Authority did not honor its requested listener".into()); }
        host.address = Some(address);
        // A bound socket is not application readiness.
        let mut ready = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while tokio::time::Instant::now() < deadline {
            check_exit(host)?;
            if host.child.is_none() { return Err("Authority exited before becoming ready".into()); }
            if local_request(host, "/readyz", None, None).await.is_ok()
                && local_request(host, "/api/setup/status", None, None).await.is_ok_and(|value| value["setupRequired"].is_boolean())
            { ready = true; break; }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if !ready { return Err("Authority did not become ready".into()); }
        if port == 0 {
            profile::save_new(&root, address.port())?;
        }
        Ok(())
    }.await;
    if let Err(error) = result {
        let _ = stop(host).await;
        host.error = Some(error.clone());
        return Err(error);
    }
    Ok(())
}
async fn start(app: &tauri::AppHandle, host: &mut Host, lan: bool) -> Result<()> {
    let result = start_inner(app, host, lan).await;
    if let Err(error) = &result {
        host.error = Some(error.clone());
    }
    result
}
async fn status(app: &tauri::AppHandle, host: &mut Host) -> Result<HostStatus> {
    check_exit(host)?;
    let root = root(app)?;
    let settings = match profile::load(&root) {
        Ok(settings) => settings,
        Err(error) => {
            host.error = Some(error);
            None
        }
    };
    let healthy = host.child.is_some() && local_request(host, "/readyz", None, None).await.is_ok();
    let setup = if healthy {
        local_request(host, "/api/setup/status", None, None)
            .await
            .ok()
            .and_then(|v| v["setupRequired"].as_bool())
    } else {
        None
    };
    let error = if host.child.is_some() && setup.is_none() {
        Some("The server process is running but is not ready. Restart it, or open the hosting folder to inspect logs; data is kept.".to_string())
    } else {
        host.error.clone()
    };
    let community_name = fs::read(root.join("data/admin_policies.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value["frontend_app_metadata"]["displayName"]
                .as_str()
                .map(str::to_string)
        });
    let mut ids = Vec::new();
    if let Ok(entries) = fs::read_dir(root.join("backups")) {
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if archive::checked_snapshot(&root.join("backups"), &id).is_ok()
                && entry.path().join("manifest.json").is_file()
            {
                ids.push(id);
            }
        }
    }
    ids.sort();
    ids.reverse();
    Ok(HostStatus {
        running: host.child.is_some(),
        ready: setup.is_some(),
        setup_required: setup,
        local_url: host
            .address
            .map(|a| a.port())
            .or_else(|| settings.as_ref().map(|s| s.port))
            .map(|port| format!("http://127.0.0.1:{port}")),
        sharing: if host.lan { "lan" } else { "local" },
        error,
        data_directory: root.join("data").display().to_string(),
        backup_ids: ids,
        binary_available: binary(app).is_ok(),
        build_revision: option_env!("WABI_SOURCE_REVISION").unwrap_or("unrecorded-local-build"),
        test_build: app.config().identifier == "chat.wabi.hosttest",
        has_community: root.join("host.json").exists() || root.join("data/wabidb").exists(),
        server_id: settings.map(|s| s.server_id),
        community_name,
        log_directory: root.join("logs").display().to_string(),
    })
}

#[tauri::command]
pub async fn host_status(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
) -> Result<HostStatus> {
    authorize(&window)?;
    status(&app, &mut *state.0.lock().await).await
}
#[tauri::command]
pub async fn host_start(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
) -> Result<HostStatus> {
    authorize(&window)?;
    let mut host = state.0.lock().await;
    start(&app, &mut host, false).await?;
    status(&app, &mut host).await
}
#[tauri::command]
pub async fn host_stop(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
) -> Result<HostStatus> {
    authorize(&window)?;
    let mut host = state.0.lock().await;
    stop(&mut host).await?;
    status(&app, &mut host).await
}
#[tauri::command]
pub async fn host_restart(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
) -> Result<HostStatus> {
    authorize(&window)?;
    let mut host = state.0.lock().await;
    let lan = host.lan;
    stop(&mut host).await?;
    start(&app, &mut host, lan).await?;
    status(&app, &mut host).await
}
#[tauri::command]
pub async fn host_sharing(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    lan: bool,
    confirm: bool,
) -> Result<HostStatus> {
    authorize(&window)?;
    if !confirm {
        return Err(
            "Confirm the connection interruption and network exposure before changing sharing"
                .into(),
        );
    }
    let mut host = state.0.lock().await;
    if lan && local_request(&host, "/api/setup/status", None, None).await?["setupRequired"] != false
    {
        return Err("Create the owner account locally before enabling network access".into());
    }
    if !stop(&mut host).await? {
        return Err("Server did not stop cleanly; restart locally before changing sharing".into());
    }
    start(&app, &mut host, lan).await?;
    status(&app, &mut host).await
}
/// Read local interface metadata on demand; this never changes the listener or
/// treats an address as proof of reachability from another device.
#[tauri::command]
pub async fn host_lan_addresses(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HostState>,
) -> Result<Vec<String>> {
    authorize(&window)?;
    #[cfg(mobile)]
    {
        let _ = state;
        Err("Hosting runs on desktop, not this mobile client".into())
    }
    #[cfg(not(mobile))]
    {
        let mut host = state.0.lock().await;
        check_exit(&mut host)?;
        let port = host
            .address
            .filter(|_| host.child.is_some())
            .ok_or("Start the community before finding its network address")?
            .port();
        let addresses = tokio::task::spawn_blocking(move || lan::addresses(port))
            .await
            .map_err(|_| "Network address discovery was interrupted. Try again.".to_string())??;
        check_exit(&mut host)?;
        if host.child.is_none() {
            return Err("The community stopped while checking its network addresses. Restart it and try again.".into());
        }
        Ok(addresses)
    }
}
#[tauri::command]
pub async fn host_account(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HostState>,
    username: String,
    password: String,
    register: bool,
    community_name: Option<String>,
    starter_channels: Option<Vec<Value>>,
) -> Result<Value> {
    authorize(&window)?;
    let host = state.0.lock().await;
    if register
        && (host.lan
            || local_request(&host, "/api/setup/status", None, None).await?["setupRequired"]
                != true)
    {
        return Err("Owner setup is allowed only for an unclaimed local community".into());
    }
    local_request(
        &host,
        if register {
            "/api/auth/register"
        } else {
            "/api/auth/login"
        },
        Some(json!({"username":username,"password":password,"communityName":community_name,"starterChannels":starter_channels})),
        None,
    )
    .await
}
#[tauri::command]
pub async fn host_invite(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HostState>,
    token: String,
    expires_in_hours: u32,
) -> Result<Value> {
    authorize(&window)?;
    let host = state.0.lock().await;
    if local_request(&host, "/api/setup/status", None, None).await?["setupRequired"] != false {
        return Err("Finish creating the owner before inviting anyone".into());
    }
    local_request(
        &host,
        "/api/invites",
        Some(json!({"expiresInHours": expires_in_hours})),
        Some(&token),
    )
    .await
}
#[tauri::command]
pub async fn host_backup(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    confirm: bool,
) -> Result<HostStatus> {
    authorize(&window)?;
    if !confirm {
        return Err("A backup pauses this community; confirmation required".into());
    }
    let mut host = state.0.lock().await;
    let resume = host.child.is_some();
    let lan = host.lan;
    let root = root(&app)?;
    if host.lease.is_none() {
        host.lease = Some(profile::ProfileLease::acquire(&root)?);
    }
    if !stop(&mut host).await? {
        return Err(
            "No snapshot taken: a clean stop is required. Start the server and retry.".into(),
        );
    }
    archive::private_dir(&root.join("backups"))?;
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos()
        .to_string();
    let data = root.join("data");
    let dest = root.join("backups").join(id);
    let result = tokio::task::spawn_blocking(move || archive::snapshot(&data, &dest))
        .await
        .map_err(|e| e.to_string())?;
    let restart = if resume {
        start(&app, &mut host, lan).await
    } else {
        Ok(())
    };
    result?;
    restart?;
    status(&app, &mut host).await
}
#[tauri::command]
pub async fn host_restore(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, HostState>,
    id: String,
    confirm: bool,
) -> Result<HostStatus> {
    authorize(&window)?;
    if !confirm {
        return Err("Restore replaces current content; explicit confirmation required".into());
    }
    let mut host = state.0.lock().await;
    let root = root(&app)?;
    if host.lease.is_none() {
        host.lease = Some(profile::ProfileLease::acquire(&root)?);
    }
    let backup = archive::checked_snapshot(&root.join("backups"), &id)?;
    if let Some(settings) = profile::load(&root)? {
        if profile::identity(&backup.join("data"))? != settings.server_id {
            return Err("This backup belongs to a different community; the current community was not changed".into());
        }
    }
    archive::validate(&backup)?; // Validate before stopping anything.
    if host.child.is_some() && !stop(&mut host).await? {
        return Err("Restore cancelled because the server did not stop cleanly".into());
    }
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let staging = root.join(format!("restore-{suffix}"));
    let original = root.join(format!("before-restore-{suffix}"));
    let data = root.join("data");
    let (copy_backup, copy_data, copy_staging, copy_original) = (
        backup.clone(),
        data.clone(),
        staging.clone(),
        original.clone(),
    );
    let had_data = tokio::task::spawn_blocking(move || {
        archive::install_restore(&copy_backup, &copy_data, &copy_staging, &copy_original)
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Err(error) = start(&app, &mut host, false).await {
        let failed = root.join(format!("failed-restore-{suffix}"));
        if let Err(rollback) = archive::rollback_restore(&data, &original, &failed, had_data) {
            return Err(format!("Restore could not start ({error}). The original is preserved at {}. Recovery stopped without deleting any data: {rollback}", original.display()));
        }
        return Err(format!(
            "Restored data did not start; the original data was put back. {error}"
        ));
    }
    // Keep the pre-restore tree for manual recovery; do not delete user data.
    status(&app, &mut host).await
}
#[tauri::command]
pub fn host_open_folder(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    authorize(&window)?;
    open::that(root(&app)?).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn host_quit(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<()> {
    authorize(&window)?;
    // The shared ExitRequested handler drains the owned Authority first.
    app.exit(0);
    Ok(())
}
pub async fn shutdown(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<HostState>() {
        let _ = stop(&mut *state.0.lock().await).await;
    }
}

#[cfg(test)]
mod tests {
    use super::local_main_origin;

    #[test]
    fn native_controls_require_the_local_main_origin() {
        for origin in [
            "tauri://localhost/host",
            "http://tauri.localhost/host",
            "https://tauri.localhost/host",
        ] {
            let url = url::Url::parse(origin).unwrap();
            assert!(local_main_origin("main", &url, false));
            assert!(!local_main_origin("model-viewer", &url, true));
        }
        for origin in [
            "https://example.com/host",
            "http://127.0.0.1:5173/host",
            "http://tauri.localhost:9999/host",
            "tauri://localhost:9999/host",
            "http://user@tauri.localhost/host",
            "https://tauri.localhost.evil.invalid/host",
        ] {
            assert!(!local_main_origin(
                "main",
                &url::Url::parse(origin).unwrap(),
                true
            ));
        }
        let dev = url::Url::parse("http://localhost:5173/host").unwrap();
        assert!(local_main_origin("main", &dev, true));
        assert!(!local_main_origin("main", &dev, false));
    }
}
