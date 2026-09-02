//! Dev smoke test for the private-access client path — exercises the exact
//! production chain: reqwest (socks5h) -> tailcat socks tunnel -> magic
//! `server.tailcat` host -> wabi-server. Run against a live enabled server:
//!
//!   WABI_TAILCAT_BINARY=/path/tailcat cargo run --example proxy_smoke -- <tc-addr> <pipePort>
//!
//! Exit 0 = HTTP 200 through the tunnel; non-zero = failure.

use std::process::{Command, Stdio};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: proxy_smoke <tc-address> <pipePort>");
        std::process::exit(2);
    }
    let addr = args[1].clone();
    let pipe_port: u16 = args[2].parse().expect("pipePort must be a u16");

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async move { run(addr, pipe_port).await });
}

async fn run(addr: String, pipe_port: u16) {
    let bin = std::env::var("WABI_TAILCAT_BINARY").unwrap_or_else(|_| "tailcat".into());

    // 1. SOCKS tunnel (same spawn as tailcat.rs).
    let socks_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let socks_port = socks_listener.local_addr().unwrap().port();
    drop(socks_listener);
    let mut child = Command::new(&bin)
        .args([
            "socks",
            format!("--listen=127.0.0.1:{socks_port}").as_str(),
            addr.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn tailcat socks");
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;

    // 1b. Direct-through-SOCKS probe (isolates forwarder vs tunnel issues).
    let direct = reqwest::Client::builder()
        .proxy(
            reqwest::Proxy::all(format!("socks5h://127.0.0.1:{socks_port}"))
                .unwrap(),
        )
        .build()
        .unwrap();
    match direct
        .get("http://server.tailcat:3102/api/public/auth-policy")
        .send()
        .await
    {
        Ok(r) => println!("direct-via-socks: {} (len {})", r.status(), r.text().await.unwrap_or_default().len()),
        Err(e) => println!("direct-via-socks FAILED: {e:?}"),
    }

    // 2. Local forwarder (production module).
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy_port = l.local_addr().unwrap().port();
    drop(l);
    let (tx, rx) = tokio::sync::watch::channel(false);
    let target = format!("server.tailcat:{pipe_port}");
    tokio::spawn(app_lib::tailcat_proxy::run(
        std::net::SocketAddr::from(([127, 0, 0, 1], proxy_port)),
        target,
        socks_port,
        rx,
    ));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // 3. Plain HTTP through the whole chain.
    let client = reqwest::Client::builder().build().unwrap();
    let res = client
        .get(format!("http://127.0.0.1:{proxy_port}/api/public/auth-policy"))
        .send()
        .await
        .expect("request through proxy");
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    println!("auth-policy: {status} {body}");
    if !status.is_success() {
        let _ = child.kill();
        std::process::exit(1);
    }

    // 4. engine.io polling handshake (socket.io transport viability).
    let res = client
        .get(format!(
            "http://127.0.0.1:{proxy_port}/socket.io/?EIO=4&transport=polling"
        ))
        .send()
        .await
        .expect("engine.io request");
    let status2 = res.status();
    let body2 = res.text().await.unwrap_or_default();
    println!("engine.io: {status2} {}", &body2[..body2.len().min(80)]);
    let ok2 = status2.is_success() && body2.contains("sid");

    let _ = child.kill();
    if ok2 {
        println!("SMOKE OK");
    } else {
        std::process::exit(1);
    }
}
