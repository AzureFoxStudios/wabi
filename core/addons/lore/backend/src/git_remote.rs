//! Caller-supplied Git sources never inherit host filesystem or network access.
use anyhow::{bail, Context, Result};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use futures_util::StreamExt;
use std::sync::Arc;
use std::{
    net::{IpAddr, SocketAddr},
    path::Path,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use url::{Host, Url};

const CLONE_TIMEOUT: Duration = Duration::from_secs(60);
const STDERR_LIMIT: u64 = 8192;
const STDOUT_LIMIT: u64 = 8192;

#[derive(Clone)]
struct BridgeState {
    upstream: Url,
    nonce: String,
    client: reqwest::Client,
    stop: tokio::sync::watch::Receiver<bool>,
}

/// Git's libcurl may read netrc or use platform SSO even with Git helpers
/// disabled. It therefore talks only to this private local adapter. All
/// credentials terminate here; anonymous reqwest owns the actual HTTPS hop.
struct GitBridge {
    url: String,
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for GitBridge {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        self.task.abort();
    }
}

impl GitBridge {
    async fn start(upstream: Url, address: SocketAddr) -> Result<Self> {
        #[cfg(not(test))]
        {
            validate_url(upstream.as_str())?;
            if !public_ip(address.ip()) {
                bail!("Git source address is not public");
            }
        }
        let client = reqwest::Client::builder()
            .https_only(upstream.scheme() == "https")
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(CLONE_TIMEOUT)
            .resolve(
                upstream.host_str().context("Git source has no host")?,
                address,
            )
            .build()?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let (stop, receiver) = tokio::sync::watch::channel(false);
        let state = Arc::new(BridgeState {
            upstream,
            nonce: nonce.clone(),
            client,
            stop: receiver,
        });
        let app = Router::new().fallback(bridge_request).with_state(state);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            url: format!("http://{address}/{nonce}/"),
            stop,
            task,
        })
    }
}

async fn bridge_request(State(state): State<Arc<BridgeState>>, request: Request) -> Response {
    let mut stop = state.stop.clone();
    if *stop.borrow() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    tokio::select! {
        _ = stop.changed() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        result = bridge_request_inner(&state, request) => match result {
            Ok(response) => response,
            Err(_) => StatusCode::BAD_GATEWAY.into_response(),
        },
    }
}

async fn bridge_request_inner(state: &BridgeState, request: Request) -> Result<Response> {
    let (parts, body) = request.into_parts();
    let prefix = format!("/{}/", state.nonce);
    let endpoint = parts
        .uri
        .path()
        .strip_prefix(&prefix)
        .context("Invalid Git bridge path")?;
    let service = match (&parts.method, endpoint, parts.uri.query()) {
        (&Method::GET, "info/refs", Some("service=git-upload-pack")) => "git-upload-pack",
        (&Method::GET, "info/refs", Some("service=git-receive-pack")) => "git-receive-pack",
        (&Method::POST, "git-upload-pack", None) => "git-upload-pack",
        (&Method::POST, "git-receive-pack", None) => "git-receive-pack",
        _ => bail!("Invalid Git bridge operation"),
    };
    let mut upstream = state.upstream.clone();
    upstream.set_path(&format!(
        "{}/{}",
        state.upstream.path().trim_end_matches('/'),
        endpoint
    ));
    if parts.method == Method::GET {
        upstream.query_pairs_mut().append_pair("service", service);
    }
    let mut operation = state.client.request(parts.method.clone(), upstream);
    // Never copy request headers wholesale: Authorization, cookies, Host,
    // proxy credentials, trace headers and ambient client certificates stay
    // outside the actual remote transfer.
    if let Some(protocol) = parts.headers.get("git-protocol") {
        if matches!(protocol.to_str(), Ok("version=1" | "version=2")) {
            operation = operation.header("git-protocol", protocol);
        }
    }
    let limit = usize::try_from(4u64 * 1024 * 1024 * 1024).unwrap_or(usize::MAX);
    if parts.method == Method::POST {
        let expected = format!("application/x-{service}-request");
        if parts
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            != Some(expected.as_str())
        {
            bail!("Invalid Git pack content type");
        }
        if let Some(encoding) = parts.headers.get("content-encoding") {
            // Git compresses buffered RPCs larger than 1 KiB. The bytes
            // remain compressed, so preserve exactly its recognized marker.
            if encoding != "gzip" || parts.headers.get_all("content-encoding").iter().count() != 1 {
                bail!("Unsupported Git pack content encoding");
            }
            operation = operation.header("content-encoding", "gzip");
        }
        let mut stop = state.stop.clone();
        let limited = Body::new(http_body_util::Limited::new(body, limit))
            .into_data_stream()
            .take_until(async move {
                let _ = stop.changed().await;
            });
        operation = operation
            .header("content-type", expected)
            .body(reqwest::Body::wrap_stream(limited));
    }
    let upstream = operation.send().await?;
    if upstream.status().is_redirection() {
        bail!("Git source redirects are disabled");
    }
    let status = upstream.status();
    let content_type = upstream.headers().get("content-type").cloned();
    let mut stop = state.stop.clone();
    let stream = upstream.bytes_stream().take_until(async move {
        let _ = stop.changed().await;
    });
    let body = Body::new(http_body_util::Limited::new(
        Body::from_stream(stream),
        limit,
    ));
    let mut response = Response::new(body);
    *response.status_mut() = status;
    if let Some(content_type) = content_type {
        response.headers_mut().insert("content-type", content_type);
    }
    // No challenge, cookies or Location is ever replayed into Git's libcurl.
    Ok(response)
}

fn bridge_command(cwd: &Path) -> Command {
    let mut command = isolated_command(cwd);
    command.args([
        "-c",
        "protocol.http.allow=always",
        "-c",
        "http.emptyAuth=false",
    ]);
    command
}

pub(crate) fn validate_url(raw: &str) -> Result<Url> {
    if raw.is_empty() || raw.len() > 2048 || raw.bytes().any(|b| b.is_ascii_control()) {
        bail!("Git source must be a public HTTPS repository URL");
    }
    let url = Url::parse(raw).context("Invalid Git repository URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
        || url.port_or_known_default() == Some(0)
    {
        bail!("Git source must be a public HTTPS repository URL without embedded credentials or query parameters");
    }
    match url.host().context("Git source has no host")? {
        Host::Ipv4(ip) if !public_ip(ip.into()) => bail!("Git source address is not public"),
        Host::Ipv6(ip) if !public_ip(ip.into()) => bail!("Git source address is not public"),
        Host::Domain(host)
            if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") =>
        {
            bail!("Git source address is not public");
        }
        _ => {}
    }
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && o[0] != 0
                && o[0] < 240
                && !(o[0] == 100 && (o[1] & 0xc0) == 64)
                && !(o[0] == 192 && o[1] == 0 && o[2] == 0)
                && !(o[0] == 198 && (o[1] & 0xfe) == 18)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(v4.into());
            }
            let s = ip.segments();
            // Global unicast only; exclude documentation and transition ranges
            // that could translate an approved IPv6 target into a private IPv4.
            (s[0] & 0xe000) == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && s[1] < 0x0200)
                && !(s[0] == 0x2001 && s[1] == 0x0db8)
                && !(s[0] == 0x3fff && (s[1] & 0xf000) == 0)
        }
    }
}

async fn approved_address(url: &Url) -> Result<SocketAddr> {
    let host = url.host_str().context("Git source has no host")?;
    let port = url
        .port_or_known_default()
        .context("Git source has no port")?;
    let addresses: Vec<_> = match url.host().context("Git source has no host")? {
        Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Domain(_) => tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .context("Git source DNS timed out")?
        .context("Git source DNS failed")?
        .collect(),
    };
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        bail!("Git source address is not public");
    }
    Ok(addresses[0])
}

pub(crate) fn isolated_command(destination: &Path) -> Command {
    let mut command = Command::new("git");
    // Ignore operator-wide aliases, rewrites, credentials, hooks and proxy
    // configuration. The only allowed transport is the exact pinned HTTPS URL.
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_SSL_NO_VERIFY")
        .env_remove("GIT_SSL_CERT")
        .env_remove("GIT_SSL_KEY")
        .env_remove("GIT_PROXY_COMMAND")
        .env_remove("GIT_TEMPLATE_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_EXEC_PATH")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        .env_remove("GIT_CONFIG")
        .env_remove("GIT_CURL_VERBOSE")
        .env("GIT_TRACE", "0")
        .env("GIT_TRACE_CURL", "0")
        .env("GIT_TRACE_PACKET", "0")
        .env("GIT_TRACE_PACKFILE", "0")
        .env("GIT_TRACE_REDACT", "1")
        .env("HTTPS_PROXY", "")
        .env("https_proxy", "")
        .env("ALL_PROXY", "")
        .env("all_proxy", "")
        .args([
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "http.followRedirects=false",
            "-c",
            "http.proxy=",
            "-c",
            "credential.helper=",
            "-c",
            "http.sslVerify=true",
            "-c",
            "http.curloptResolve=",
            "-c",
            "http.lowSpeedLimit=1024",
            "-c",
            "http.lowSpeedTime=10",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.attributesFile=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "tag.gpgSign=false",
            "-c",
            "init.templateDir=",
        ])
        .current_dir(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

#[cfg(test)]
fn remote_command(url: &Url, address: SocketAddr, destination: &Path) -> Command {
    let host = url.host_str().expect("validated Git host");
    let ip = match address.ip() {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let mut command = isolated_command(destination);
    command.arg("-c").arg(format!(
        "http.curloptResolve={host}:{}:{ip}",
        address.port()
    ));
    command
}

#[cfg(test)]
fn clone_command(url: &Url, address: SocketAddr, destination: &Path) -> Command {
    let mut command = remote_command(url, address, destination);
    command
        .args([
            "clone",
            "--quiet",
            "--depth",
            "1",
            "--no-local",
            "--template=",
            "--",
        ])
        .arg(url.as_str())
        .arg(destination);
    command
}

pub(crate) async fn bounded_output(mut command: Command, deadline: Duration) -> Result<Output> {
    let mut child = command.spawn().context("Start Git operation")?;
    let stderr = child.stderr.take().context("Missing Git stderr")?;
    let stdout = child.stdout.take();
    let capture_stdout = async move {
        let mut bytes = Vec::new();
        if let Some(stdout) = stdout {
            stdout.take(STDOUT_LIMIT).read_to_end(&mut bytes).await?;
        }
        Ok::<_, std::io::Error>(bytes)
    };
    let capture = async move {
        let mut bytes = Vec::new();
        stderr.take(STDERR_LIMIT).read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    };
    let result = tokio::time::timeout(deadline, async {
        let (status, stdout, stderr) = tokio::join!(child.wait(), capture_stdout, capture);
        Ok::<_, std::io::Error>(Output {
            status: status?,
            stdout: stdout?,
            stderr: stderr?,
        })
    })
    .await;
    match result {
        Ok(output) => Ok(output?),
        Err(_) => {
            let _ = child.kill().await;
            bail!("Git operation timed out");
        }
    }
}

pub(crate) async fn clone_into(raw: &str, destination: &Path) -> Result<Output> {
    // Local Git fixtures are available only in this crate's unit-test build.
    #[cfg(test)]
    if Path::new(raw).is_absolute() {
        let mut command = isolated_command(destination);
        command
            .args([
                "-c",
                "protocol.file.allow=always",
                "clone",
                "--quiet",
                "--depth",
                "1",
                "--template=",
                "--",
            ])
            .arg(raw)
            .arg(destination)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        return bounded_output(command, CLONE_TIMEOUT).await;
    }
    let url = validate_url(raw)?;
    let address = approved_address(&url).await?;
    let bridge = GitBridge::start(url.clone(), address).await?;
    let mut command = bridge_command(destination);
    command
        .args([
            "clone",
            "--quiet",
            "--depth",
            "1",
            "--no-local",
            "--template=",
            "--",
        ])
        .arg(&bridge.url)
        .arg(destination);
    let output = bounded_output(command, CLONE_TIMEOUT).await?;
    if output.status.success() {
        checked_local(&["remote", "set-url", "origin", url.as_str()], destination).await?;
    }
    Ok(output)
}

pub(crate) struct PushTarget {
    url: String,
    address: Option<SocketAddr>,
}

pub(crate) fn validate_push_target(raw: &str) -> Result<()> {
    validate_source_target(raw)
}

pub(crate) fn validate_source_target(raw: &str) -> Result<()> {
    #[cfg(test)]
    if Path::new(raw).is_absolute() {
        return Ok(());
    }
    validate_url(raw).map(|_| ())
}

pub(crate) async fn resolve_push_target(raw: &str) -> Result<PushTarget> {
    #[cfg(test)]
    if Path::new(raw).is_absolute() {
        return Ok(PushTarget {
            url: raw.to_owned(),
            address: None,
        });
    }
    let url = validate_url(raw)?;
    let address = approved_address(&url).await?;
    Ok(PushTarget {
        url: url.to_string(),
        address: Some(address),
    })
}

async fn push_target_command(
    target: &PushTarget,
    cwd: &Path,
) -> Result<(Command, Option<GitBridge>, String)> {
    match target.address {
        Some(address) => {
            let bridge = GitBridge::start(validate_url(&target.url)?, address).await?;
            let url = bridge.url.clone();
            Ok((bridge_command(cwd), Some(bridge), url))
        }
        None => {
            #[cfg(test)]
            {
                let mut command = isolated_command(cwd);
                command.args(["-c", "protocol.file.allow=always"]);
                Ok((command, None, target.url.clone()))
            }
            #[cfg(not(test))]
            bail!("Missing approved Git push address")
        }
    }
}

pub(crate) async fn checked_local(args: &[&str], cwd: &Path) -> Result<Output> {
    let mut command = isolated_command(cwd);
    command.args(args);
    let output = bounded_output(command, Duration::from_secs(20)).await?;
    if !output.status.success() {
        bail!("Git snapshot preparation failed");
    }
    Ok(output)
}

/// Replace only the two explicit snapshot refs. Ref leases prevent an
/// intervening remote update from being overwritten after inspection.
pub(crate) async fn push_snapshot(target: &PushTarget, cwd: &Path, tags: bool) -> Result<()> {
    let (mut inspect, bridge, url) = push_target_command(target, cwd).await?;
    inspect
        .args(["ls-remote", "--refs", "--"])
        .arg(url)
        .args(["refs/heads/main", "refs/tags/latest"])
        .stdout(Stdio::piped());
    let output = bounded_output(inspect, CLONE_TIMEOUT).await?;
    drop(bridge);
    if !output.status.success() {
        bail!("Git mirror destination inspection failed");
    }
    let mut refs = std::collections::HashMap::new();
    for line in std::str::from_utf8(&output.stdout)
        .context("Invalid Git refs")?
        .lines()
    {
        let (hash, name) = line.split_once('\t').context("Invalid Git refs")?;
        if !matches!(name, "refs/heads/main" | "refs/tags/latest")
            || !matches!(hash.len(), 40 | 64)
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
            || refs.insert(name.to_owned(), hash.to_owned()).is_some()
        {
            bail!("Invalid Git refs");
        }
    }
    let (mut push, _bridge, url) = push_target_command(target, cwd).await?;
    push.args(["push", "--quiet", "--atomic"]).arg(format!(
        "--force-with-lease=refs/heads/main:{}",
        refs.get("refs/heads/main")
            .map(String::as_str)
            .unwrap_or("")
    ));
    if tags {
        push.arg(format!(
            "--force-with-lease=refs/tags/latest:{}",
            refs.get("refs/tags/latest")
                .map(String::as_str)
                .unwrap_or("")
        ));
    }
    push.arg("--").arg(url).arg("HEAD:refs/heads/main");
    if tags {
        push.arg("HEAD:refs/tags/latest");
    }
    let output = bounded_output(push, CLONE_TIMEOUT).await?;
    if !output.status.success() {
        bail!("Git mirror push failed or destination changed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    type ObservedRequests = Arc<tokio::sync::Mutex<Vec<(Method, String, axum::http::HeaderMap)>>>;

    async fn upstream_fixture(
        status: StatusCode,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>, ObservedRequests) {
        let observed: ObservedRequests = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let capture = observed.clone();
        let app = Router::new().fallback(move |request: Request| {
            let capture = capture.clone();
            async move {
                capture.lock().await.push((
                    request.method().clone(),
                    request.uri().to_string(),
                    request.headers().clone(),
                ));
                let mut response = Response::new(Body::empty());
                *response.status_mut() = status;
                response
                    .headers_mut()
                    .insert("www-authenticate", "Basic realm=fixture".parse().unwrap());
                response
                    .headers_mut()
                    .insert("proxy-authenticate", "Negotiate".parse().unwrap());
                response
                    .headers_mut()
                    .insert("set-cookie", "fixture-private-cookie".parse().unwrap());
                response
                    .headers_mut()
                    .insert("location", "http://127.0.0.1/private".parse().unwrap());
                response
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (address, task, observed)
    }

    #[tokio::test]
    async fn anonymous_bridge_pins_target_strips_credentials_and_auth_challenges_and_closes() {
        let (address, upstream, observed) = upstream_fixture(StatusCode::UNAUTHORIZED).await;
        let source = Url::parse(&format!(
            "http://upstream.invalid:{}/source.git",
            address.port()
        ))
        .unwrap();
        let bridge = GitBridge::start(source, address).await.unwrap();
        let local_port = Url::parse(&bridge.url).unwrap().port().unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(format!("{}info/refs?service=git-upload-pack", bridge.url))
            .header("authorization", "Bearer fixture-private-token")
            .header("proxy-authorization", "fixture-proxy-token")
            .header("cookie", "fixture-private-cookie")
            .header("host", "169.254.169.254")
            .header("x-private-credential", "private-canary")
            .header("git-protocol", "version=2")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        for hidden in [
            "www-authenticate",
            "proxy-authenticate",
            "set-cookie",
            "location",
        ] {
            assert!(!response.headers().contains_key(hidden));
        }
        response.bytes().await.unwrap();
        {
            let requests = observed.lock().await;
            assert_eq!(requests.len(), 1);
            assert_eq!(
                requests[0].1,
                "/source.git/info/refs?service=git-upload-pack"
            );
            assert_eq!(requests[0].2["git-protocol"], "version=2");
            assert!(requests[0].2["host"]
                .to_str()
                .unwrap()
                .starts_with("upstream.invalid:"));
            for hidden in [
                "authorization",
                "proxy-authorization",
                "cookie",
                "x-private-credential",
            ] {
                assert!(!requests[0].2.contains_key(hidden));
            }
        }
        for path in [
            "objects/private",
            "info/refs?service=git-upload-pack&url=http://localhost",
            "../outside",
        ] {
            let response = client
                .get(format!("{}{path}", bridge.url))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        }
        assert_eq!(observed.lock().await.len(), 1);

        // Real Git receives the stripped 401, not a remote auth challenge.
        let scratch = tempfile::tempdir().unwrap();
        let mut git = bridge_command(scratch.path());
        git.args(["ls-remote", "--"])
            .arg(&bridge.url)
            .stdout(Stdio::piped());
        let output = bounded_output(git, Duration::from_secs(5)).await.unwrap();
        assert!(!output.status.success());
        assert!(observed
            .lock()
            .await
            .iter()
            .all(|(_, _, headers)| !headers.contains_key("authorization")
                && !headers.contains_key("cookie")));
        drop(client);
        drop(bridge);
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Ok(listener) =
                    tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, local_port)).await
                {
                    drop(listener);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        upstream.abort();
        let _ = upstream.await;
    }

    #[tokio::test]
    async fn anonymous_bridge_rejects_redirects_without_reaching_private_location() {
        let (address, upstream, observed) = upstream_fixture(StatusCode::TEMPORARY_REDIRECT).await;
        let source =
            Url::parse(&format!("http://upstream.invalid:{}/repo", address.port())).unwrap();
        let bridge = GitBridge::start(source, address).await.unwrap();
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("{}info/refs?service=git-upload-pack", bridge.url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert!(!response.headers().contains_key("location"));
        assert_eq!(observed.lock().await.len(), 1);
        drop(bridge);
        upstream.abort();
        let _ = upstream.await;
    }

    #[tokio::test]
    async fn anonymous_bridge_preserves_only_supported_gzip_rpc_encoding() {
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let capture = captured.clone();
        let app = Router::new().fallback(move |request: Request| {
            let capture = capture.clone();
            async move {
                let (parts, body) = request.into_parts();
                let body = axum::body::to_bytes(body, 1024).await.unwrap();
                capture.lock().await.push((parts.headers, body.to_vec()));
                StatusCode::OK
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = Url::parse(&format!("http://upstream.invalid:{}/repo", address.port())).unwrap();
        let bridge = GitBridge::start(url, address).await.unwrap();
        // A valid gzip member containing Git's flush packet, generated once.
        let compressed = vec![
            31, 139, 8, 0, 0, 0, 0, 0, 2, 3, 51, 48, 48, 48, 0, 0, 114, 196, 155, 12, 4, 0, 0, 0,
        ];
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .post(format!("{}git-upload-pack", bridge.url))
            .header("content-type", "application/x-git-upload-pack-request")
            .header("content-encoding", "gzip")
            .body(compressed.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.bytes().await.unwrap();
        let requests = captured.lock().await;
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0["content-encoding"], "gzip");
        assert_eq!(requests[0].1, compressed);
        drop(requests);
        let response = client
            .post(format!("{}git-upload-pack", bridge.url))
            .header("content-type", "application/x-git-upload-pack-request")
            .header("content-encoding", "br")
            .body("unsupported")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(captured.lock().await.len(), 1);
        drop(bridge);
        upstream.abort();
        let _ = upstream.await;
    }

    #[tokio::test]
    async fn anonymous_bridge_supports_real_smart_http_clone() {
        use std::io::{Seek, Write};
        let source = tempfile::tempdir().unwrap();
        let repository = source.path().join("source.git");
        std::fs::create_dir(&repository).unwrap();
        checked_local(
            &["init", "--quiet", "--template=", "-b", "main"],
            &repository,
        )
        .await
        .unwrap();
        std::fs::write(repository.join("hello.txt"), b"real Git snapshot").unwrap();
        checked_local(&["add", "--", "hello.txt"], &repository)
            .await
            .unwrap();
        checked_local(
            &[
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@localhost",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
            &repository,
        )
        .await
        .unwrap();
        let root = source.path().to_owned();
        let app = Router::new().fallback(move |request: Request| {
            let root = root.clone();
            async move {
                let (parts, body) = request.into_parts();
                let bytes = axum::body::to_bytes(body, 8192).await.unwrap();
                let mut input = tempfile::tempfile().unwrap();
                input.write_all(&bytes).unwrap();
                input.rewind().unwrap();
                let mut command = isolated_command(&root);
                command
                    .arg("http-backend")
                    .env("GIT_PROJECT_ROOT", &root)
                    .env("GIT_HTTP_EXPORT_ALL", "1")
                    .env("REQUEST_METHOD", parts.method.as_str())
                    .env("PATH_INFO", parts.uri.path())
                    .env("QUERY_STRING", parts.uri.query().unwrap_or(""))
                    .env("REMOTE_ADDR", "127.0.0.1")
                    .env("CONTENT_LENGTH", bytes.len().to_string())
                    .env(
                        "CONTENT_TYPE",
                        parts
                            .headers
                            .get("content-type")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or(""),
                    )
                    .env(
                        "HTTP_CONTENT_ENCODING",
                        parts
                            .headers
                            .get("content-encoding")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or(""),
                    )
                    .env(
                        "HTTP_GIT_PROTOCOL",
                        parts
                            .headers
                            .get("git-protocol")
                            .and_then(|h| h.to_str().ok())
                            .unwrap_or(""),
                    )
                    .stdin(Stdio::from(input))
                    .stdout(Stdio::piped());
                let output = bounded_output(command, Duration::from_secs(5))
                    .await
                    .unwrap();
                assert!(output.status.success());
                let split = output
                    .stdout
                    .windows(4)
                    .position(|p| p == b"\r\n\r\n")
                    .unwrap();
                let headers = std::str::from_utf8(&output.stdout[..split]).unwrap();
                let mut response = Response::new(Body::from(output.stdout[split + 4..].to_vec()));
                for line in headers.lines() {
                    let (name, value) = line.split_once(':').unwrap();
                    if name.eq_ignore_ascii_case("content-type") {
                        response
                            .headers_mut()
                            .insert("content-type", value.trim().parse().unwrap());
                    } else if name.eq_ignore_ascii_case("status") {
                        *response.status_mut() = StatusCode::from_u16(
                            value.split_whitespace().next().unwrap().parse().unwrap(),
                        )
                        .unwrap();
                    }
                }
                response
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = Url::parse(&format!(
            "http://upstream.invalid:{}/source.git",
            address.port()
        ))
        .unwrap();
        let bridge = GitBridge::start(url, address).await.unwrap();
        let destination = tempfile::tempdir().unwrap();
        let mut command = bridge_command(destination.path());
        command
            .args(["clone", "--quiet", "--depth", "1", "--template=", "--"])
            .arg(&bridge.url)
            .arg(destination.path());
        let output = bounded_output(command, Duration::from_secs(10))
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read(destination.path().join("hello.txt")).unwrap(),
            b"real Git snapshot"
        );
        drop(bridge);
        server.abort();
        let _ = server.await;
    }
    #[test]
    fn rejects_host_files_protocol_helpers_credentials_and_private_destinations() {
        for raw in [
            "/tmp/repo",
            "file:///tmp/repo",
            "ssh://host/repo",
            "git@host:repo",
            "ext::command",
            "--upload-pack=evil",
            "http://example.com/repo",
            "https://user:secret@example.com/repo",
            "https://example.com/repo?access_token=private",
            "https://example.com/repo?service=git-upload-pack",
            "https://localhost/repo",
            "https://127.0.0.1/repo",
            "https://[::1]/repo",
            "https://[::ffff:10.0.0.1]/repo",
            "https://169.254.169.254/repo",
            "https://100.64.0.1/repo",
        ] {
            assert!(validate_url(raw).is_err(), "{raw}");
        }
        assert!(validate_url("https://github.com/example/repo.git").is_ok());
    }
    #[test]
    fn clone_keeps_hostname_but_pins_address_and_disables_redirects_and_host_credentials() {
        let url = validate_url("https://git.example/repo.git").unwrap();
        let command = clone_command(
            &url,
            "93.184.216.34:443".parse().unwrap(),
            Path::new("/tmp/fixture"),
        );
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy())
            .collect();
        for expected in [
            "http.curloptResolve=git.example:443:93.184.216.34",
            "http.followRedirects=false",
            "protocol.allow=never",
            "protocol.https.allow=always",
            "credential.helper=",
            "--",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "{expected}");
        }
        assert_eq!(args[args.len() - 2], url.as_str());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn subprocess_output_and_duration_are_bounded() {
        let mut noisy = Command::new("sh");
        noisy
            .args(["-c", "head -c 20000 /dev/zero; head -c 20000 /dev/zero >&2"])
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        let output = bounded_output(noisy, Duration::from_secs(2)).await.unwrap();
        assert!(output.stderr.len() <= STDERR_LIMIT as usize);
        assert!(output.stdout.len() <= STDOUT_LIMIT as usize);
        let mut slow = Command::new("sleep");
        slow.arg("10").stderr(Stdio::piped()).kill_on_drop(true);
        assert!(bounded_output(slow, Duration::from_millis(100))
            .await
            .unwrap_err()
            .to_string()
            .contains("timed out"));
    }
}
