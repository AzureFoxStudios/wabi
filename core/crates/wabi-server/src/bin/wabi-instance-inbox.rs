//! Offsite inbox for opaque encrypted instance archives.
//! Stores opaque age ciphertext; it cannot promote or serve a Wabi community.

use anyhow::{bail, Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::{Path as RoutePath, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    routing::{get, put},
    Router,
};
use clap::{Parser, Subcommand};
use futures::{stream, StreamExt};
use sha2::{Digest, Sha256};
use std::{
    io::ErrorKind,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio::{
    fs::{self, File},
    io::{AsyncReadExt, AsyncWriteExt},
};

const AGE_HEADER: &[u8] = b"age-encryption.org/v1";
const HASH_HEADER: &str = "x-wabi-archive-sha256";
const DEFAULT_MAX_BYTES: u64 = 100 * 1024 * 1024 * 1024;

#[derive(Parser)]
#[command(about = "Transfer and store opaque encrypted instance archives; no promotion")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Receive encrypted archives on a protected private listener or behind validated HTTPS.
    Serve {
        #[arg(long, default_value = "127.0.0.1:47073")]
        listen: SocketAddr,
        /// Explicitly bind beyond loopback; use a protected private transport or TLS proxy.
        #[arg(long)]
        allow_remote_listen: bool,
        #[arg(long)]
        storage_dir: PathBuf,
        #[arg(long)]
        token_file: PathBuf,
        #[arg(long, default_value_t = DEFAULT_MAX_BYTES)]
        max_bytes: u64,
    },
    /// Upload an encrypted archive; prints its immutable inbox ID.
    Send {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        endpoint: String,
        #[arg(long)]
        token_file: PathBuf,
        #[arg(long)]
        id: Option<String>,
        /// Send the inbox token over operator-protected private HTTP (for example Tailcat).
        #[arg(long)]
        allow_private_http: bool,
    },
    /// Download an encrypted archive for isolated restore.
    Fetch {
        #[arg(long)]
        id: String,
        #[arg(long)]
        endpoint: String,
        #[arg(long)]
        token_file: PathBuf,
        #[arg(long)]
        output: PathBuf,
        /// Send the inbox token over operator-protected private HTTP (for example Tailcat).
        #[arg(long)]
        allow_private_http: bool,
    },
}

#[derive(Clone)]
struct Inbox {
    root: PathBuf,
    token: Arc<str>,
    max_bytes: u64,
}

type ApiError = (StatusCode, &'static str);

#[tokio::main]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::Serve {
            listen,
            allow_remote_listen,
            storage_dir,
            token_file,
            max_bytes,
        } => {
            if max_bytes == 0 {
                bail!("max-bytes must be positive");
            }
            if !listen.ip().is_loopback() && !allow_remote_listen {
                bail!("non-loopback inbox listening requires --allow-remote-listen and a protected transport");
            }
            let token = read_token(&token_file).await?;
            let root = private_storage_dir(&storage_dir).await?;
            let state = Inbox {
                root,
                token: token.into(),
                max_bytes,
            };
            let listener = tokio::net::TcpListener::bind(listen).await?;
            println!(
                "Encrypted instance inbox listening on {}",
                listener.local_addr()?
            );
            axum::serve(listener, router(state)).await?;
            Ok(())
        }
        Command::Send {
            input,
            endpoint,
            token_file,
            id,
            allow_private_http,
        } => send_archive(&input, &endpoint, &token_file, id, allow_private_http).await,
        Command::Fetch {
            id,
            endpoint,
            token_file,
            output,
            allow_private_http,
        } => fetch_archive(&id, &endpoint, &token_file, &output, allow_private_http).await,
    }
}

fn router(state: Inbox) -> Router {
    Router::new()
        .route("/healthz", get(|| async { StatusCode::OK }))
        .route("/archives/{id}", put(receive_archive).get(download_archive))
        .with_state(state)
}

async fn read_token(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path).await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("token file must be a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!("token file must be private (mode 0600)");
        }
    }
    if metadata.len() > 4096 {
        bail!("token file is too large");
    }
    let token = fs::read_to_string(path).await?.trim().to_string();
    if token.len() < 32 || !token.is_ascii() || token.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        bail!("token must contain at least 32 non-whitespace ASCII characters");
    }
    Ok(token)
}

async fn private_storage_dir(path: &Path) -> Result<PathBuf> {
    if fs::symlink_metadata(path)
        .await
        .is_err_and(|error| error.kind() == ErrorKind::NotFound)
    {
        fs::create_dir_all(path).await?;
    }
    let metadata = fs::symlink_metadata(path).await?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("inbox storage must be a real directory");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(fs::canonicalize(path).await?)
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let Some(provided) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    provided.len() == token.len()
        && provided
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |diff, (left, right)| diff | (left ^ right))
            == 0
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn expected_hash(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(HASH_HEADER)?.to_str().ok()?;
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

async fn receive_archive(
    State(state): State<Inbox>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
    body: Body,
) -> std::result::Result<(StatusCode, HeaderMap), ApiError> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid inbox token"));
    }
    if !valid_id(&id) {
        return Err((StatusCode::BAD_REQUEST, "invalid archive id"));
    }
    let expected = expected_hash(&headers)
        .ok_or((StatusCode::BAD_REQUEST, "x-wabi-archive-sha256 required"))?;
    let final_path = state.root.join(format!("{id}.age"));
    if fs::symlink_metadata(&final_path).await.is_ok() {
        return Err((StatusCode::CONFLICT, "archive id already stored"));
    }
    let temporary = state
        .root
        .join(format!(".{}.{}.tmp", id, uuid::Uuid::new_v4()));
    let result = async {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "inbox write failed"))?;
        let mut stream = body.into_data_stream();
        let mut total = 0u64;
        let mut hash = Sha256::new();
        let mut prefix = Vec::with_capacity(AGE_HEADER.len());
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| (StatusCode::BAD_REQUEST, "upload stream failed"))?;
            total = total
                .checked_add(chunk.len() as u64)
                .ok_or((StatusCode::PAYLOAD_TOO_LARGE, "archive too large"))?;
            if total > state.max_bytes {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "archive too large"));
            }
            if prefix.len() < AGE_HEADER.len() {
                let take = (AGE_HEADER.len() - prefix.len()).min(chunk.len());
                prefix.extend_from_slice(&chunk[..take]);
            }
            hash.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "inbox write failed"))?;
        }
        if prefix != AGE_HEADER {
            return Err((StatusCode::BAD_REQUEST, "payload is not an age archive"));
        }
        if hex::encode(hash.finalize()) != expected {
            return Err((StatusCode::UNPROCESSABLE_ENTITY, "archive hash mismatch"));
        }
        file.sync_all()
            .await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "inbox sync failed"))?;
        fs::hard_link(&temporary, &final_path)
            .await
            .map_err(|error| {
                if error.kind() == ErrorKind::AlreadyExists {
                    (StatusCode::CONFLICT, "archive id already stored")
                } else {
                    (StatusCode::INTERNAL_SERVER_ERROR, "inbox publish failed")
                }
            })?;
        sync_dir(&state.root).await.map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "inbox directory sync failed",
            )
        })?;
        let mut response = HeaderMap::new();
        response.insert(
            HASH_HEADER,
            HeaderValue::from_str(&expected).expect("hex header"),
        );
        response.insert(
            "x-wabi-archive-bytes",
            HeaderValue::from_str(&total.to_string()).expect("integer header"),
        );
        Ok((StatusCode::CREATED, response))
    }
    .await;
    let _ = fs::remove_file(&temporary).await;
    result
}

async fn download_archive(
    State(state): State<Inbox>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
) -> std::result::Result<(HeaderMap, Body), ApiError> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid inbox token"));
    }
    if !valid_id(&id) {
        return Err((StatusCode::BAD_REQUEST, "invalid archive id"));
    }
    let path = state.root.join(format!("{id}.age"));
    let metadata = fs::symlink_metadata(&path).await.map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            (StatusCode::NOT_FOUND, "archive not found")
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, "inbox read failed")
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err((StatusCode::NOT_FOUND, "archive not found"));
    }
    let hash = hash_file(&path)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "inbox hash failed"))?;
    let file = File::open(&path)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "inbox read failed"))?;
    let stream = stream::try_unfold(file, |mut file| async move {
        let mut buffer = vec![0u8; 64 * 1024];
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        buffer.truncate(count);
        Ok(Some((Bytes::from(buffer), file)))
    });
    let mut response = HeaderMap::new();
    response.insert(
        HASH_HEADER,
        HeaderValue::from_str(&hash).expect("hex header"),
    );
    response.insert(
        "content-length",
        HeaderValue::from_str(&metadata.len().to_string()).expect("integer header"),
    );
    response.insert(
        "content-type",
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok((response, Body::from_stream(stream)))
}

async fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).await?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex::encode(hash.finalize()))
}

async fn sync_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path).await?.sync_all().await?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn endpoint_url(endpoint: &str, id: &str, allow_private_http: bool) -> Result<String> {
    if !valid_id(id) {
        bail!("invalid archive id");
    }
    let url = reqwest::Url::parse(endpoint).context("invalid inbox endpoint")?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        bail!("inbox endpoint must be an origin");
    }
    if url.scheme() != "https"
        && !(url.scheme() == "http"
            && (loopback_host(&url) || allow_private_http && private_host(&url)))
    {
        bail!("inbox token requires HTTPS; private HTTP needs --allow-private-http and a protected transport");
    }
    Ok(format!(
        "{}/archives/{id}",
        url.origin().ascii_serialization()
    ))
}

fn loopback_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(&['[', ']'][..])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn private_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let Ok(ip) = host.trim_matches(&['[', ']'][..]).parse::<IpAddr>() else {
        return false;
    };
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    }
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

async fn send_archive(
    input: &Path,
    endpoint: &str,
    token_file: &Path,
    id: Option<String>,
    allow_private_http: bool,
) -> Result<()> {
    let metadata = fs::symlink_metadata(input).await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("archive input must be a regular file");
    }
    let started = Instant::now();
    let id = id.unwrap_or_else(|| format!("snap-{}", uuid::Uuid::new_v4()));
    let url = endpoint_url(endpoint, &id, allow_private_http)?;
    let token = read_token(token_file).await?;
    let hash = hash_file(input).await?;
    let file = File::open(input).await?;
    let stream = stream::try_unfold(file, |mut file| async move {
        let mut buffer = vec![0u8; 64 * 1024];
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        buffer.truncate(count);
        Ok(Some((Bytes::from(buffer), file)))
    });
    let response = client()?
        .put(url)
        .bearer_auth(token)
        .header(HASH_HEADER, &hash)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await?;
    if response.status() != StatusCode::CREATED {
        bail!("inbox upload failed with HTTP {}", response.status());
    }
    if response
        .headers()
        .get(HASH_HEADER)
        .and_then(|value| value.to_str().ok())
        != Some(hash.as_str())
    {
        bail!("inbox returned a different archive hash");
    }
    let stored_bytes = response
        .headers()
        .get("x-wabi-archive-bytes")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .context("inbox response omitted stored byte count")?;
    if stored_bytes != metadata.len() {
        bail!("inbox stored byte count differs from archive input");
    }
    println!(
        "Stored encrypted archive: {id} ({hash}, {stored_bytes} bytes, {:.2}s)",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

async fn fetch_archive(
    id: &str,
    endpoint: &str,
    token_file: &Path,
    output: &Path,
    allow_private_http: bool,
) -> Result<()> {
    let started = Instant::now();
    let url = endpoint_url(endpoint, id, allow_private_http)?;
    let token = read_token(token_file).await?;
    if fs::symlink_metadata(output).await.is_ok() {
        bail!("output already exists: {}", output.display());
    }
    let response = client()?.get(url).bearer_auth(token).send().await?;
    if response.status() != StatusCode::OK {
        bail!("inbox download failed with HTTP {}", response.status());
    }
    let expected =
        expected_hash(response.headers()).context("inbox response omitted archive hash")?;
    let parent = output
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temporary = parent.join(format!(".wabi-inbox-fetch-{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).await?;
        let mut stream = response.bytes_stream();
        let mut hash = Sha256::new();
        let mut prefix = Vec::with_capacity(AGE_HEADER.len());
        let mut total = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            total = total
                .checked_add(chunk.len() as u64)
                .context("downloaded archive byte count overflow")?;
            if prefix.len() < AGE_HEADER.len() {
                let take = (AGE_HEADER.len() - prefix.len()).min(chunk.len());
                prefix.extend_from_slice(&chunk[..take]);
            }
            hash.update(&chunk);
            file.write_all(&chunk).await?;
        }
        if prefix != AGE_HEADER || hex::encode(hash.finalize()) != expected {
            bail!("downloaded archive failed age header or SHA-256 verification");
        }
        file.sync_all().await?;
        fs::hard_link(&temporary, output)
            .await
            .context("publish downloaded archive")?;
        sync_dir(parent).await?;
        Ok::<u64, anyhow::Error>(total)
    }
    .await;
    let _ = fs::remove_file(&temporary).await;
    let total = result?;
    println!(
        "Downloaded encrypted archive: {} ({total} bytes, {:.2}s)",
        output.display(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use age::Encryptor;
    use std::io::Write;
    use tower::ServiceExt;

    fn age_fixture() -> Vec<u8> {
        let identity = age::x25519::Identity::generate();
        let recipient = identity.to_public();
        let mut bytes = Vec::new();
        let encryptor =
            Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient)).unwrap();
        let mut writer = encryptor.wrap_output(&mut bytes).unwrap();
        writer
            .write_all(b"WABI-INSTANCE-SNAPSHOT-V1\nfixture")
            .unwrap();
        writer.finish().unwrap();
        bytes
    }

    fn state(root: &Path, max_bytes: u64) -> Inbox {
        Inbox {
            root: root.to_path_buf(),
            token: "1234567890abcdef1234567890abcdef".into(),
            max_bytes,
        }
    }

    fn put_request(
        id: &str,
        token: &str,
        bytes: Vec<u8>,
        hash: String,
    ) -> axum::http::Request<Body> {
        axum::http::Request::builder()
            .method("PUT")
            .uri(format!("/archives/{id}"))
            .header("authorization", format!("Bearer {token}"))
            .header(HASH_HEADER, hash)
            .body(Body::from(bytes))
            .unwrap()
    }

    #[tokio::test]
    async fn send_and_fetch_stream_over_a_real_loopback_listener() {
        let dir = tempfile::tempdir().unwrap();
        let storage = dir.path().join("inbox");
        fs::create_dir(&storage).await.unwrap();
        let token_file = dir.path().join("token");
        fs::write(&token_file, b"1234567890abcdef1234567890abcdef\n")
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600))
                .await
                .unwrap();
        }
        let original = dir.path().join("original.age");
        let recovered = dir.path().join("recovered.age");
        let bytes = age_fixture();
        fs::write(&original, &bytes).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = router(state(&storage, 1024 * 1024));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        send_archive(
            &original,
            &endpoint,
            &token_file,
            Some("site-b-archive".into()),
            false,
        )
        .await
        .unwrap();
        assert!(send_archive(
            &original,
            &endpoint,
            &token_file,
            Some("site-b-archive".into()),
            false
        )
        .await
        .is_err());
        fetch_archive("site-b-archive", &endpoint, &token_file, &recovered, false)
            .await
            .unwrap();
        assert_eq!(fs::read(&recovered).await.unwrap(), bytes);
        server.abort();
    }

    #[tokio::test]
    async fn receives_immutable_encrypted_archive_and_streams_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = age_fixture();
        let hash = hex::encode(Sha256::digest(&bytes));
        let app = router(state(dir.path(), 1024 * 1024));
        let unauthorized = app
            .clone()
            .oneshot(put_request("fixture", "wrong", bytes.clone(), hash.clone()))
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let accepted = app
            .clone()
            .oneshot(put_request(
                "fixture",
                "1234567890abcdef1234567890abcdef",
                bytes.clone(),
                hash.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::CREATED);
        assert_eq!(
            fs::read(dir.path().join("fixture.age")).await.unwrap(),
            bytes
        );
        let duplicate = app
            .clone()
            .oneshot(put_request(
                "fixture",
                "1234567890abcdef1234567890abcdef",
                age_fixture(),
                hash.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::CONFLICT);
        let request = axum::http::Request::builder()
            .uri("/archives/fixture")
            .header("authorization", "Bearer 1234567890abcdef1234567890abcdef")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(HASH_HEADER).unwrap(), hash.as_str());
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
            bytes
        );
    }

    #[tokio::test]
    async fn rejects_corrupt_or_oversized_archive_without_publication() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = age_fixture();
        let hash = hex::encode(Sha256::digest(b"wrong"));
        let app = router(state(dir.path(), 1024 * 1024));
        let mismatch = app
            .clone()
            .oneshot(put_request(
                "bad",
                "1234567890abcdef1234567890abcdef",
                bytes.clone(),
                hash,
            ))
            .await
            .unwrap();
        assert_eq!(mismatch.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!dir.path().join("bad.age").exists());
        let oversized = router(state(dir.path(), 5))
            .oneshot(put_request(
                "huge",
                "1234567890abcdef1234567890abcdef",
                bytes.clone(),
                hex::encode(Sha256::digest(&bytes)),
            ))
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!dir.path().join("huge.age").exists());
    }

    #[test]
    fn refuses_public_http_for_inbox_credentials() {
        assert!(endpoint_url("http://example.org", "a", true).is_err());
        assert!(endpoint_url("https://example.org", "a", false).is_ok());
        assert!(endpoint_url("http://100.64.1.2:47073", "a", false).is_err());
        assert!(endpoint_url("http://100.64.1.2:47073", "a", true).is_ok());
        assert!(endpoint_url("http://127.0.0.1:47073", "a", false).is_ok());
        assert!(endpoint_url("https://example.org/other", "a", false).is_err());
    }
}
