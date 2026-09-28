//! Local HTTP/WebSocket forwarder riding the tailcat SOCKS tunnel.
//!
//! The webview cannot speak SOCKS, so `tailcat_connect` starts two things:
//!   1. `tailcat socks --listen=127.0.0.1:<socks_port> <addr>` — the tunnel
//!   2. this forwarder on `127.0.0.1:<proxy_port>` — the webview's target
//!
//! Requests to the forwarder are re-targeted at `server.tailcat:<pipe_port>`
//! (the magic hostname that resolves inside a bound tailcat SOCKS proxy) and
//! dialed through the tunnel (socks5h = remote DNS). The app then points its
//! server URL at the forwarder via the existing `setConfiguredServerUrl`
//! mechanism — no changes to the app's fetch layer.
//!
//! Websockets (socket.io) bridge via HTTP upgrades; if an upgrade ever fails,
//! socket.io degrades to polling on its own.

use bytes::Bytes;
use futures_util::stream::TryStreamExt;
use http::{header, Request, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::watch;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type PBody = http_body_util::combinators::BoxBody<Bytes, BoxError>;

fn empty() -> PBody {
    http_body_util::Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

fn is_hop_by_hop(name: &http::HeaderName, upgrading: bool) -> bool {
    if upgrading && (name == header::CONNECTION || name == header::UPGRADE) {
        return false;
    }
    matches!(
        name.as_str(),
        "connection" | "keep-alive" | "proxy-connection" | "te" | "trailer" | "transfer-encoding" | "upgrade"
    )
}

/// Run the forwarder on a pre-bound loopback listener until `shutdown` fires.
/// `target_authority` is e.g. `server.tailcat:3102`.
pub async fn run(
    listener: TcpListener,
    target_authority: String,
    socks_port: u16,
    mut shutdown: watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let listen = listener.local_addr()?;
    let proxy = reqwest::Proxy::all(format!("socks5h://127.0.0.1:{socks_port}"))?;
    let client = reqwest::Client::builder().proxy(proxy).build()?;
    log::info!("[tailcat-proxy] forwarder on {listen} -> {target_authority} via socks:{socks_port}");
    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    return Ok(());
                }
            }
            accepted = listener.accept() => {
                let (stream, _peer) = match accepted {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!("[tailcat-proxy] accept error: {e}");
                        continue;
                    }
                };
                let client = client.clone();
                let target = target_authority.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let client = client.clone();
                        let target = target.clone();
                        async move { Ok::<_, std::convert::Infallible>(proxy_one(client, target, req).await) }
                    });
                    // with_upgrades(): socket.io websockets.
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
                });
            }
        }
    }
}

async fn proxy_one(
    client: reqwest::Client,
    target: String,
    req: Request<Incoming>,
) -> Response<PBody> {
    match proxy_inner(client, &target, req).await {
        Ok(res) => res,
        Err(e) => {
            log::warn!("[tailcat-proxy] error: {e}");
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(empty())
                .expect("static response")
        }
    }
}

async fn proxy_inner(
    client: reqwest::Client,
    target: &str,
    req: Request<Incoming>,
) -> anyhow::Result<Response<PBody>> {
    let (mut parts, body) = req.into_parts();
    let server_upgrade = parts.extensions.remove::<OnUpgrade>();
    let upgrading = server_upgrade.is_some();

    let path = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let url: reqwest::Url = format!("http://{target}{path}").parse()?;

    let mut builder = client.request(
        reqwest::Method::from_bytes(parts.method.as_str().as_bytes())?,
        url,
    );
    for (name, value) in parts.headers.iter() {
        if is_hop_by_hop(name, upgrading) || name == header::HOST {
            continue;
        }
        builder = builder.header(name, value);
    }
    builder = builder.header(header::HOST, target);
    // NOTE: no request-side extension plumbing needed — reqwest performs the
    // upgrade from the response side (Response::upgrade), driven by the
    // forwarded Connection/Upgrade headers.
    // Stream the request body straight through (uploads must not buffer).
    let stream = body.into_data_stream();
    let builder = builder.body(reqwest::Body::wrap_stream(stream));

    let cres = builder.send().await?;
    let status = cres.status();
    let is_101 = status == StatusCode::SWITCHING_PROTOCOLS;
    let mut headers: Vec<(http::HeaderName, http::HeaderValue)> = Vec::new();
    for (name, value) in cres.headers().iter() {
        if !is_hop_by_hop(name, is_101) {
            headers.push((name.clone(), value.clone()));
        }
    }
    // upgrade(self) consumes the response — split it last.
    let (client_upgrade, body_stream) = if is_101 {
        (Some(cres.upgrade()), None)
    } else {
        (None, Some(cres.bytes_stream()))
    };

    let mut res = Response::builder().status(status);
    for (name, value) in headers {
        res = res.header(name, value);
    }
    let body: PBody = match body_stream {
        Some(stream) => http_body_util::BodyExt::boxed(http_body_util::StreamBody::new(
            stream
                .map_err(|e| Box::new(e) as BoxError)
                .map_ok(http_body::Frame::data),
        )),
        None => empty(),
    };
    let out = res.body(body)?;

    if is_101 {
        // The downstream handle belongs to the incoming request, not the
        // response we constructed. Keep it paired with reqwest's upstream IO.
        if let (Some(su), Some(cu)) = (server_upgrade, client_upgrade) {
            tokio::spawn(async move {
                let server_io = match su.await {
                    Ok(io) => io,
                    Err(e) => {
                        log::warn!("[tailcat-proxy] server-side upgrade failed: {e}");
                        return;
                    }
                };
                let client_io = match cu.await {
                    Ok(io) => io,
                    Err(e) => {
                        log::warn!("[tailcat-proxy] client-side upgrade failed: {e}");
                        return;
                    }
                };
                // server side: hyper rt traits -> tokio via TokioIo;
                // reqwest::Upgraded already speaks tokio traits.
                let mut server_io = TokioIo::new(server_io);
                let mut client_io = client_io;
                if let Err(e) = copy_bidirectional(&mut server_io, &mut client_io).await {
                    log::debug!("[tailcat-proxy] tunnel closed: {e}");
                }
            });
        }
    }

    Ok(out)
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
            let (stream, _peer) = proxy_listener.accept().await.unwrap();
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let target = target.to_string();
            let service = service_fn(move |req| {
                let client = client.clone();
                let target = target.clone();
                async move { Ok::<_, std::convert::Infallible>(proxy_one(client, target, req).await) }
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
