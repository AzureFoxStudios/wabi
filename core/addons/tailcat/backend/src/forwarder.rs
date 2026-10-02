//! Loopback tagging forwarder for Tailcat pipe ingress.
//!
//! `tailcat serve <port>` forwards connections to `localhost:<same port>`, so
//! the pipe cannot be distinguished by port. This forwarder listens on the
//! pipe port and proxies to the real wabi-server port, injecting:
//!   - `x-wabi-pipe-auth: <token>`   — startup-generated random secret; only
//!     in-process holders can mint it, so public clients cannot spoof pipe
//!     identity to dodge per-IP policies.
//!   - `x-wabi-pipe-client: <addr>`  — the pipe client's loopback source
//!     socket address for diagnostics. Rate policies use only its IP,
//!     scoped to this authenticated transport; changing connection ports
//!     cannot provide a fresh allowance. The listener exposes no stable
//!     remote member identity, so members share this creation quota.
//!
//! Binds 127.0.0.1 only. Websockets (socket.io) tunnel via hyper upgrades.

use std::net::SocketAddr;

use bytes::Bytes;
use http::{header, Request, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::upgrade::OnUpgrade;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::watch;

pub const PIPE_AUTH_HEADER: &str = "x-wabi-pipe-auth";
pub const PIPE_CLIENT_HEADER: &str = "x-wabi-pipe-client";

type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

fn empty() -> BoxBody {
    http_body_util::Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

/// Headers that must not be forwarded verbatim between the two HTTP hops,
/// EXCEPT `connection`/`upgrade` when an upgrade is in flight (websocket).
fn is_hop_by_hop(name: &http::HeaderName, upgrading: bool) -> bool {
    if upgrading && (name == header::CONNECTION || name == header::UPGRADE) {
        return false;
    }
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

/// Run the forwarder until the shutdown watch fires.
pub async fn run(
    listen: SocketAddr,
    target: SocketAddr,
    pipe_auth_token: String,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let listener = TcpListener::bind(listen).await?;
    run_listener(listener, target, pipe_auth_token, shutdown).await
}

pub async fn run_listener(
    listener: TcpListener,
    target: SocketAddr,
    pipe_auth_token: String,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    tracing::info!(
        "[tailcat] tagging forwarder listening on {} -> {target}",
        listener.local_addr()?
    );
    let client: Client<HttpConnector, BoxBody> = Client::builder(TokioExecutor::new()).build_http();
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return Ok(());
                }
            }
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!("[tailcat] forwarder accept error: {e}");
                        continue;
                    }
                };
                let client = client.clone();
                let token = pipe_auth_token.clone();
                // No trailing slash: request paths arrive absolute ("/api/...")
                // and a "//api/..." double slash 404s in the target router.
                let target_http = format!("http://{target}");
                let mut connection_stop = shutdown.clone();
                let request_stop = shutdown.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let client = client.clone();
                        let token = token.clone();
                        let target_http = target_http.clone();
                        let request_stop = request_stop.clone();
                        async move {
                            Ok::<_, std::convert::Infallible>(
                                proxy_with_shutdown(client, target_http, token, peer, req, request_stop).await,
                            )
                        }
                    });
                    // with_upgrades() is required for socket.io websockets.
                    tokio::select! {
                        _ = connection_stop.changed() => {},
                        _ = async { let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service).with_upgrades().await; } => {}
                    }
                });
            }
        }
    }
}

async fn proxy(
    client: Client<HttpConnector, BoxBody>,
    target: String,
    token: String,
    peer: SocketAddr,
    req: Request<Incoming>,
) -> Response<BoxBody> {
    let (keep, shutdown) = watch::channel(false);
    tokio::spawn(async move {
        keep.closed().await;
    });
    proxy_with_shutdown(client, target, token, peer, req, shutdown).await
}

async fn proxy_with_shutdown(
    client: Client<HttpConnector, BoxBody>,
    target: String,
    token: String,
    peer: SocketAddr,
    req: Request<Incoming>,
    shutdown: watch::Receiver<bool>,
) -> Response<BoxBody> {
    match proxy_inner(client, &target, &token, peer, req, shutdown).await {
        Ok(res) => res,
        Err(e) => {
            tracing::warn!("[tailcat] forwarder proxy error: {e}");
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(empty())
                .expect("static response")
        }
    }
}

async fn proxy_inner(
    client: Client<HttpConnector, BoxBody>,
    target: &str,
    token: &str,
    peer: SocketAddr,
    req: Request<Incoming>,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<Response<BoxBody>> {
    let (mut parts, body) = req.into_parts();

    // Retain the downstream request's upgrade handle. A newly constructed
    // response does not contain it, and the upstream client owns a separate
    // upgrade handle for its connection.
    let server_upgrade = parts.extensions.remove::<OnUpgrade>();
    let upgrading = server_upgrade.is_some();

    let path = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let uri: http::Uri = format!("{target}{path}").parse()?;

    let mut builder = Request::builder()
        .method(parts.method.clone())
        .uri(uri)
        .header(
            header::HOST,
            target.trim_start_matches("http://").trim_end_matches('/'),
        );
    for (name, value) in parts.headers.iter() {
        // These tags belong to this trusted hop. Appending after a caller's
        // values leaves duplicates, and HeaderMap::get reads the first one.
        if is_hop_by_hop(name, upgrading)
            || name == header::HOST
            || name == PIPE_AUTH_HEADER
            || name == PIPE_CLIENT_HEADER
        {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder
        .header(PIPE_AUTH_HEADER, token)
        .header(PIPE_CLIENT_HEADER, peer.to_string());

    let creq = builder.body(body.boxed())?;

    let mut cres = client.request(creq).await?;
    let is_101 = cres.status() == StatusCode::SWITCHING_PROTOCOLS;
    let client_upgrade: Option<OnUpgrade> = if is_101 {
        cres.extensions_mut().remove::<OnUpgrade>()
    } else {
        None
    };

    let (rparts, rbody) = cres.into_parts();
    let mut rb = Response::builder().status(rparts.status);
    for (name, value) in rparts.headers.iter() {
        if is_hop_by_hop(name, is_101) {
            continue;
        }
        rb = rb.header(name, value);
    }
    let res = rb.body(if is_101 { empty() } else { rbody.boxed() })?;

    if is_101 {
        if let (Some(su), Some(cu)) = (server_upgrade, client_upgrade) {
            tokio::spawn(async move {
                match tokio::try_join!(su, cu) {
                    Ok((server_io, client_io)) => {
                        let mut server_io = TokioIo::new(server_io);
                        let mut client_io = TokioIo::new(client_io);
                        tokio::select! {
                            _ = shutdown.changed() => {},
                            result = copy_bidirectional(&mut server_io, &mut client_io) => {
                                if let Err(e) = result { tracing::debug!("[tailcat] upgraded tunnel closed: {e}"); }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[tailcat] upgrade bridging failed: {e}");
                    }
                }
            });
        }
    }

    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use hyper::body::Incoming as IncomingBody;
    use hyper::service::service_fn;
    use std::net::SocketAddr as SA;

    /// Target server that echoes back the pipe headers it received.
    async fn echo_headers_target() -> anyhow::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let handle = tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => return,
                };
                tokio::spawn(async move {
                    let service = service_fn(|req: Request<IncomingBody>| async move {
                        let (parts, body) = req.into_parts();
                        let _bytes = body.collect().await;
                        let auth = parts
                            .headers
                            .get(PIPE_AUTH_HEADER)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("<missing>")
                            .to_string();
                        let client = parts
                            .headers
                            .get(PIPE_CLIENT_HEADER)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("<missing>")
                            .to_string();
                        // Echo the path too: a forwarder that mangles the
                        // path (e.g. double slash) must fail this test.
                        let path = parts.uri.path().to_string();
                        Ok::<_, std::convert::Infallible>(Response::new(
                            http_body_util::Full::<Bytes>::from(format!("{auth}|{client}|{path}"))
                                .boxed(),
                        ))
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Ok((addr, handle))
    }

    #[tokio::test]
    async fn forwarder_injects_pipe_headers() {
        let (target, _target_task) = echo_headers_target().await.unwrap();
        let fwd_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fwd_addr = fwd_listener.local_addr().unwrap();
        drop(fwd_listener); // free the port for the forwarder to bind

        let (tx, rx) = watch::channel(false);
        let token = "test-token-123".to_string();
        let fwd = tokio::spawn(run(fwd_addr, target, token.clone(), rx));

        // Give the forwarder a moment to bind.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let client: Client<HttpConnector, BoxBody> =
            Client::builder(TokioExecutor::new()).build_http();
        let res = client
            .request(
                Request::builder()
                    .uri(format!("http://{fwd_addr}/probe"))
                    .header(PIPE_AUTH_HEADER, "caller-forged-token")
                    .header(PIPE_CLIENT_HEADER, "caller-chosen-identity")
                    .body(empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("test-token-123|127.0.0.1:"), "got: {text}");
        assert!(
            text.ends_with("|/probe"),
            "path must be preserved, got: {text}"
        );

        tx.send(true).unwrap();
        let _ = fwd.await;
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    #[tokio::test]
    async fn upgrade_bridges_bytes_in_both_directions() {
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};
        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = target_listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            let (stream, _) = target_listener.accept().await.unwrap();
            let service = service_fn(|req: Request<Incoming>| async move {
                let upgrade = hyper::upgrade::on(req);
                tokio::spawn(async move {
                    let mut io = TokioIo::new(upgrade.await.unwrap());
                    io.write_all(b"HELLO").await.unwrap();
                    let mut request = [0; 4];
                    io.read_exact(&mut request).await.unwrap();
                    assert_eq!(&request, b"PING");
                    io.write_all(b"PONG").await.unwrap();
                });
                Ok::<_, std::convert::Infallible>(
                    Response::builder()
                        .status(StatusCode::SWITCHING_PROTOCOLS)
                        .header(header::CONNECTION, "upgrade")
                        .header(header::UPGRADE, "wabi-test")
                        .body(empty())
                        .unwrap(),
                )
            });
            hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await
                .unwrap();
        });
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let forwarder = tokio::spawn(async move {
            let (stream, peer) = proxy_listener.accept().await.unwrap();
            let client: Client<HttpConnector, BoxBody> =
                Client::builder(TokioExecutor::new()).build_http();
            let target = format!("http://{target}");
            let service = service_fn(move |req| {
                let client = client.clone();
                let target = target.clone();
                async move {
                    Ok::<_, std::convert::Infallible>(
                        proxy(client, target, "upgrade-test-token".into(), peer, req).await,
                    )
                }
            });
            hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await
                .unwrap();
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut client = TcpStream::connect(proxy_address).await.unwrap();
            client.write_all(b"GET /upgrade HTTP/1.1\r\nHost: localhost\r\nConnection: upgrade\r\nUpgrade: wabi-test\r\n\r\n").await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(client.read_u8().await.unwrap());
                assert!(headers.len() < 8192);
            }
            assert!(headers.starts_with(b"HTTP/1.1 101"));
            let mut greeting = [0; 5];
            client.read_exact(&mut greeting).await.expect("upstream bytes cross the upgraded proxy");
            assert_eq!(&greeting, b"HELLO");
            client.write_all(b"PING").await.unwrap();
            let mut response = [0; 4];
            client.read_exact(&mut response).await.unwrap();
            assert_eq!(&response, b"PONG");
        }).await.expect("upgrade round trip must not hang");
        upstream.await.unwrap();
        forwarder.await.unwrap();
    }
}
