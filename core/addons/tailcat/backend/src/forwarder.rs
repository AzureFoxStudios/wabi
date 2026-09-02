//! Loopback tagging forwarder for Tailcat pipe ingress.
//!
//! `tailcat serve <port>` forwards connections to `localhost:<same port>`, so
//! the pipe cannot be distinguished by port. This forwarder listens on the
//! pipe port and proxies to the real wabi-server port, injecting:
//!   - `x-wabi-pipe-auth: <token>`   — startup-generated random secret; only
//!     in-process holders can mint it, so public clients cannot spoof pipe
//!     identity to dodge per-IP policies.
//!   - `x-wabi-pipe-client: <addr>`  — the pipe client's loopback source
//!     address (per pipe connection ≈ per member client), used as the
//!     rate-limit key so family members don't collapse into one "IP"
//!     (the spike-confirmed 127.0.0.1 collapse problem).
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
        "connection" | "keep-alive" | "proxy-connection" | "te" | "trailer" | "transfer-encoding" | "upgrade"
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
    tracing::info!("[tailcat] tagging forwarder listening on {listen} -> {target}");
    let client: Client<HttpConnector, BoxBody> =
        Client::builder(TokioExecutor::new()).build_http();
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
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let client = client.clone();
                        let token = token.clone();
                        let target_http = target_http.clone();
                        async move {
                            Ok::<_, std::convert::Infallible>(
                                proxy(client, target_http, token, peer, req).await,
                            )
                        }
                    });
                    // with_upgrades() is required for socket.io websockets.
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
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
    match proxy_inner(client, &target, &token, peer, req).await {
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
) -> anyhow::Result<Response<BoxBody>> {
    let (mut parts, body) = req.into_parts();

    // The server side of the upgrade: hyper inserted OnUpgrade into the
    // request extensions; move it to the upstream request so the client
    // performs the same upgrade.
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
        .header(header::HOST, target.trim_start_matches("http://").trim_end_matches('/'));
    for (name, value) in parts.headers.iter() {
        if is_hop_by_hop(name, upgrading) || name == header::HOST {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder
        .header(PIPE_AUTH_HEADER, token)
        .header(PIPE_CLIENT_HEADER, peer.to_string());

    let mut creq = builder.body(body.boxed())?;
    if let Some(ou) = server_upgrade {
        creq.extensions_mut().insert(ou);
    }

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
    let mut res = rb.body(if is_101 { empty() } else { rbody.boxed() })?;

    if is_101 {
        if let Some(cu) = client_upgrade {
            // hyper::upgrade::on() registers interest in OUR 101 being written
            // and yields the upgraded client IO once the handshake completes.
            let su = hyper::upgrade::on(&mut res);
            tokio::spawn(async move {
                match tokio::try_join!(su, cu) {
                    Ok((server_io, client_io)) => {
                        let mut server_io = TokioIo::new(server_io);
                        let mut client_io = TokioIo::new(client_io);
                        if let Err(e) =
                            copy_bidirectional(&mut server_io, &mut client_io).await
                        {
                            tracing::debug!("[tailcat] upgraded tunnel closed: {e}");
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
    use hyper::service::service_fn;
    use hyper::body::Incoming as IncomingBody;
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
                        Ok::<_, std::convert::Infallible>(
                            Response::new(
                                http_body_util::Full::<Bytes>::from(format!("{auth}|{client}|{path}"))
                                    .boxed(),
                            ),
                        )
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
        let fwd = tokio::spawn(run(
            fwd_addr,
            target,
            token.clone(),
            rx,
        ));

        // Give the forwarder a moment to bind.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let client: Client<HttpConnector, BoxBody> =
            Client::builder(TokioExecutor::new()).build_http();
        let res = client
            .request(
                Request::builder()
                    .uri(format!("http://{fwd_addr}/probe"))
                    .body(empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("test-token-123|127.0.0.1:"), "got: {text}");
        assert!(text.ends_with("|/probe"), "path must be preserved, got: {text}");

        tx.send(true).unwrap();
        let _ = fwd.await;
    }
}
