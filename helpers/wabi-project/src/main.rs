mod connector;
mod gateway;
mod worker;
use connector::*;
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, IsTerminal},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
fn protected(path: &str, limit: u64) -> Result<Value> {
    let m = fs::metadata(path).map_err(|_| "Cannot read protected file.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if m.permissions().mode() & 0o077 != 0 {
            return Err("Connection file must be protected (0600).".into());
        }
    }
    if !m.is_file() || m.len() > limit {
        return Err("Invalid protected file.".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "Cannot read protected file.")?)
        .map_err(|_| "Invalid protected file.".into())
}
fn env_connection() -> Value {
    json!({"version":1,"serverUrl":env::var("WABI_PROJECT_URL").unwrap_or_default(),"channelId":env::var("WABI_PROJECT_CHANNEL_ID").unwrap_or_default(),"botToken":env::var("WABI_BOT_TOKEN").unwrap_or_default()})
}
#[tokio::main]
async fn main() {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    let executable = env::args().next().unwrap_or_default();
    let name = Path::new(&executable)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let name = name.strip_suffix(".mjs").unwrap_or(name);
    let command = match name {
        "wabi-project-mcp" => Some("mcp"),
        "wabi-project-plugin" => Some("gateway"),
        "wabi-project-worker" => Some("worker"),
        "wabi-project-agent" => Some("agent"),
        "package-wabi-project-plugin" => Some("package"),
        _ => None,
    };
    if let Some(command) = command {
        if command == "gateway" && args.first().is_some_and(|s| s == "--control") {
            args[0] = "control".into();
        } else {
            args.insert(0, command.into());
        }
    }
    if let Err(e) = dispatch(&args).await {
        eprintln!("{e}");
        std::process::exit(1)
    }
}
async fn dispatch(args: &[String]) -> Result<()> {
    let Some((cmd, args)) = args.split_first() else {
        return Err("Commands: mcp, gateway, worker, agent, package, health, control".into());
    };
    match cmd.as_str(){
 "mcp"=>{let raw=if args.is_empty(){env_connection()}else if args.len()==2&&args[0]=="--connection"{let b=fs::read(&args[1]).map_err(|_|"Cannot open Wabi Project connection.")?;if b.len()>8192{return Err("Cannot open Wabi Project connection.".into())}serde_json::from_slice(&b).map_err(|_|"Cannot open Wabi Project connection.")?}else{return Err("Use mcp --connection FILE or the three WABI Project environment variables.".into())};stdio(Connector::new(raw)?).await},
 "worker"=>{if args.iter().any(|s|s!="--once"){return Err("Use worker [--once]".into())}let cancel=CancellationToken::new();signals(cancel.clone());worker::Worker::env()?.run(args.iter().any(|s|s=="--once"),&cancel).await.map(|_|()).map_err(|_|"Project worker stopped. Check configuration and the durable run checkpoint.".into())},
 "gateway"=>gateway_main(args).await.map_err(|_|"Cannot start Wabi Project plugin. Use a protected --connection FILE, --public-url ORIGIN, --name LABEL and at least one exact --callback URL.".into()),
 "control"=>control_client(args).await,
 "health"=>health(args).await,
 "package"=>package(args),"agent"=>agent(args).await,_=>Err("Unknown helper command.".into())}
}
fn signals(cancel: CancellationToken) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        cancel.cancel();
    });
}
async fn stdio(c: Connector) -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin());
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let pending = Arc::new(Mutex::new(std::collections::HashMap::<
        String,
        CancellationToken,
    >::new()));
    let mut initialized = false;
    loop {
        let mut bytes = Vec::new();
        let n = read_frame(&mut input, &mut bytes, 128 * 1024)
            .await
            .map_err(|_| "Input failed")?;
        if n == 0 || bytes.len() > 128 * 1024 {
            break;
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let message: Value = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => {
                send(&output,json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON-RPC request"}})).await;
                continue;
            }
        };
        if !message.is_object() || message["jsonrpc"] != "2.0" || !message["method"].is_string() {
            send(&output,json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON-RPC request"}})).await;
            continue;
        }
        let method = message["method"].as_str().unwrap().to_string();
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let Some(id) = message.get("id").cloned() else {
            if method == "notifications/cancelled" {
                if let Some(c) = pending.lock().await.get(&params["requestId"].to_string()) {
                    c.cancel()
                }
            }
            continue;
        };
        if pending.lock().await.len() >= 16 {
            send(&output,json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Too many pending requests"}})).await;
            continue;
        }
        let result = if method == "initialize" {
            if initialized {
                Some(Err("Already initialized."))
            } else {
                initialized = true;
                let supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
                let protocol = params["protocolVersion"]
                    .as_str()
                    .filter(|s| supported.contains(s))
                    .unwrap_or(supported[0]);
                Some(Ok(
                    json!({"protocolVersion":protocol,"capabilities":{"tools":{}},"serverInfo":{"name":"wabi-project","version":"1.0.0"},"instructions":INSTRUCTIONS}),
                ))
            }
        } else if !initialized {
            Some(Err("Initialize the connection first."))
        } else if method == "ping" {
            Some(Ok(json!({})))
        } else if method == "tools/list" {
            Some(Ok(json!({"tools":tools()})))
        } else {
            None
        };
        if let Some(r) = result {
            send(
                &output,
                match r {
                    Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
                    Err(e) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":e}}),
                },
            )
            .await;
            continue;
        }
        if method != "tools/call" {
            send(&output,json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not supported"}})).await;
            continue;
        }
        let cancel = CancellationToken::new();
        pending.lock().await.insert(id.to_string(), cancel.clone());
        let c = c.clone();
        let p = pending.clone();
        let out = output.clone();
        tokio::spawn(async move {
            let result = match c
                .call(
                    params["name"].as_str().unwrap_or(""),
                    params.get("arguments").cloned().unwrap_or(json!({})),
                    &cancel,
                )
                .await
            {
                Ok(v) => json!({"content":[{"type":"text","text":v.to_string()}]}),
                Err(e) => json!({"isError":true,"content":[{"type":"text","text":e}]}),
            };
            send(&out, json!({"jsonrpc":"2.0","id":id,"result":result})).await;
            p.lock().await.remove(&id.to_string());
        });
    }
    for c in pending.lock().await.values() {
        c.cancel()
    }
    Ok(())
}
async fn send(out: &Arc<Mutex<tokio::io::Stdout>>, v: Value) {
    let mut out = out.lock().await;
    let _ = out.write_all(format!("{v}\n").as_bytes()).await;
    let _ = out.flush().await;
}
async fn gateway_main(args: &[String]) -> Result<()> {
    let mut opts = std::collections::HashMap::new();
    let mut callbacks = vec![];
    if args.len() % 2 != 0 {
        return Err("Invalid options".into());
    }
    for pair in args.chunks(2) {
        if pair[0] == "--callback" {
            callbacks.push(pair[1].clone())
        } else if [
            "--connection",
            "--public-url",
            "--name",
            "--port",
            "--auth-path",
            "--control-socket",
            "--listen",
            "--registered-clients",
        ]
        .contains(&pair[0].as_str())
        {
            opts.insert(pair[0].clone(), pair[1].clone());
        } else {
            return Err("Invalid options".into());
        }
    }
    let get = |k: &str| opts.get(k).map(String::as_str).unwrap_or("");
    let port: u16 = if get("--port").is_empty() {
        4319
    } else {
        get("--port").parse().map_err(|_| "Invalid port")?
    };
    if port == 0 {
        return Err("Invalid port".into());
    }
    let listen = if get("--listen").is_empty() {
        "127.0.0.1"
    } else {
        get("--listen")
    };
    if !valid_listen(listen) {
        return Err("Invalid listen address".into());
    }
    let registered = if get("--registered-clients").is_empty() {
        None
    } else {
        if !Path::new(get("--registered-clients")).is_absolute() {
            return Err("Invalid registered client path".into());
        }
        Some(protected(get("--registered-clients"), 65536)?)
    };
    let g = gateway::Gateway::new(
        protected(get("--connection"), 8192)?,
        get("--public-url"),
        get("--name"),
        get("--auth-path"),
        callbacks,
        registered,
        port,
    )?;
    let cancel = CancellationToken::new();
    signals(cancel.clone());
    if !get("--control-socket").is_empty() {
        start_control(g.clone(), get("--control-socket"), cancel.clone()).await?
    }
    if io::stdin().is_terminal() && io::stderr().is_terminal() {
        let g = g.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            loop {
                tokio::select! {_=cancel.cancelled()=>break,r=lines.next_line()=>match r{Ok(Some(s))=>match s.trim(){"link"=>eprintln!("Private connection code: {}",g.control("link")["linkCode"].as_str().unwrap()),"revoke"=>{g.control("revoke");eprintln!("All links revoked.")},_=>{}},_=>break}}
            }
        });
    }
    let listener = tokio::net::TcpListener::bind((listen, port))
        .await
        .map_err(|_| "Cannot bind gateway")?;
    eprintln!(
        "Wabi Project plugin listening on {listen}:{port}. Connect {}",
        g.resource
    );
    let app = axum::Router::new()
        .fallback(gateway::handler)
        .with_state(g.clone());
    let stopping = cancel.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { stopping.cancelled().await })
        .await
        .map_err(|_| "Gateway stopped")?;
    g.control("revoke");
    Ok(())
}
#[cfg(unix)]
async fn start_control(
    g: Arc<gateway::Gateway>,
    path: &str,
    cancel: CancellationToken,
) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Use an absolute Unix control socket path.".into());
    }
    let parent = path.parent().ok_or("Invalid socket path")?;
    let m = fs::metadata(parent).map_err(|_| "Control socket directory must be private (0700).")?;
    if !m.is_dir() || m.permissions().mode() & 0o077 != 0 {
        return Err("Control socket directory must be private (0700).".into());
    }
    let listener = tokio::net::UnixListener::bind(&path)
        .map_err(|_| "Cannot bind control socket; existing owners are never unlinked.")?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "Cannot protect socket")?;
    let inode = fs::metadata(&path)
        .map_err(|_| "Cannot inspect socket")?
        .ino();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
    tokio::spawn(async move {
        loop {
            tokio::select! {_=cancel.cancelled()=>break,r=listener.accept()=>{let Ok((socket,_))=r else{break};let Ok(permit)=semaphore.clone().try_acquire_owned()else{continue};let g=g.clone();tokio::spawn(async move{let _permit=permit;let mut reader=BufReader::new(socket);let mut bytes=vec![];if let Ok(Ok(n))=tokio::time::timeout(std::time::Duration::from_secs(2),read_frame(&mut reader,&mut bytes,64)).await{if n<=64&&bytes.ends_with(b"\n"){let value=g.control(String::from_utf8_lossy(&bytes).trim());let _=reader.get_mut().write_all(format!("{value}\n").as_bytes()).await;}}});}}
        }
        drop(listener);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.ino() == inode) {
            let _ = fs::remove_file(path);
        }
    });
    Ok(())
}
#[cfg(not(unix))]
async fn start_control(_: Arc<gateway::Gateway>, _: &str, _: CancellationToken) -> Result<()> {
    Err("Control sockets require Unix.".into())
}
#[cfg(unix)]
async fn control_client(args: &[String]) -> Result<()> {
    if args.len() != 2 || !["link", "revoke", "status"].contains(&args[1].as_str()) {
        return Err("Use control ABSOLUTE_SOCKET link|revoke|status".into());
    }
    if args[1] == "link" && !io::stdout().is_terminal() {
        return Err("Connection codes require a private terminal.".into());
    }
    let mut socket = tokio::net::UnixStream::connect(&args[0])
        .await
        .map_err(|_| "Control unavailable")?;
    socket
        .write_all(format!("{}\n", args[1]).as_bytes())
        .await
        .map_err(|_| "Control unavailable")?;
    let mut bytes = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        socket.take(8192).read_to_end(&mut bytes),
    )
    .await
    .map_err(|_| "Control timeout")?
    .map_err(|_| "Control unavailable")?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid control response")?;
    if let Some(code) = v["linkCode"].as_str() {
        println!("Private connection code (ten minutes, one use): {code}")
    } else if v["revoked"] == true {
        println!("All gateway links revoked.")
    } else {
        println!("{v}")
    }
    Ok(())
}
#[cfg(not(unix))]
async fn control_client(_: &[String]) -> Result<()> {
    Err("Control sockets require Unix.".into())
}
fn package(args: &[String]) -> Result<()> {
    if args.len() != 2 {
        return Err("Use package HTTPS_MCP_URL NEW_OUTPUT_DIRECTORY".into());
    }
    let u = url::Url::parse(&args[0]).map_err(|_| "Invalid endpoint")?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/mcp"
    {
        return Err("Use the connector’s bare HTTPS /mcp URL.".into());
    }
    let target = Path::new(&args[1]);
    fs::create_dir(target).map_err(|_| "Existing output directories are refused.")?;
    let target = fs::canonicalize(target).map_err(|_| "Cannot resolve package destination.")?;
    let result = (|| {
        fs::create_dir_all(target.join("skills/wabi-project"))
            .map_err(|_| "Cannot package plugin")?;
        fs::write(
            target.join("skills/wabi-project/SKILL.md"),
            include_str!("../assets/plugin-skill.md"),
        )
        .map_err(|_| "Cannot package plugin")?;
        fs::write(
            target.join("plugin.json"),
            include_str!("../assets/plugin.json"),
        )
        .map_err(|_| "Cannot package plugin")?;
        fs::write(target.join("mcp.json"),serde_json::to_vec_pretty(&json!({"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"wabi":{"type":"streamable-http","url":u.as_str()}}})).unwrap()).map_err(|_|"Cannot package plugin")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&target);
    } else {
        println!("{}", target.display())
    }
    result
}
async fn agent(args: &[String]) -> Result<()> {
    let c = Connector::new(env_connection())?;
    let cancel = CancellationToken::new();
    let (cmd, args) = args.split_first().ok_or("Missing agent command")?;
    let task = |args: &[String]| {
        args.first()
            .filter(|s| valid_id(s))
            .cloned()
            .ok_or("Invalid task ID".to_string())
    };
    let cards = format!("/projects/{}/tasks", c.channel);
    let wiki = format!("/wiki/{}/pages", c.channel);
    let result=match cmd.as_str(){
 "list-cards"=>c.request("GET",&cards,None,&cancel).await?,"list-pages"=>c.request("GET",&wiki,None,&cancel).await?,
 "create-card"=>{let title=args.first().ok_or("Usage: create-card TITLE [DESCRIPTION] [OPERATION_UUID]")?;c.call("create_card",json!({"title":title,"description":args.get(1).cloned().unwrap_or_default(),"operationId":args.get(2).cloned().unwrap_or_else(||uuid::Uuid::new_v4().to_string())}),&cancel).await?},
 "claim-card"=>{let id=task(args)?;let r=c.request("GET",&format!("{cards}/{id}"),None,&cancel).await?;c.call("claim_card",json!({"taskId":id,"expectedRevision":r["revision"]}),&cancel).await?},
 "set-card-status"|"assign-card"=>{let id=task(args)?;let value=args.get(1).ok_or("Missing status or assignee")?;let path=format!("{cards}/{id}");let mut current=c.request("GET",&path,None,&cancel).await?;let revision=current["revision"].clone();let object=current.as_object_mut().ok_or("Invalid card response")?;object.retain(|k,_|["title","description","status","priority","dueDateMillis","assigneeUserId","notes","checklist","relatedTaskIds"].contains(&k.as_str()));current["expectedRevision"]=revision;if cmd=="set-card-status"{if !["ideas","todo","in_progress","done","scrapped","archived"].contains(&value.as_str()){return Err("Invalid status".into())}current["status"]=json!(value)}else{current["assigneeUserId"]=if value=="none"{Value::Null}else{let id:i64=value.parse().map_err(|_|"Invalid assignee")?;if id<=0||id>9_007_199_254_740_991{return Err("Invalid assignee".into())}json!(id)}}c.request("PUT",&path,Some(current),&cancel).await?},
 "create-page"=>c.request("POST",&wiki,Some(json!({"title":args.first().ok_or("Missing title")?,"body":args.get(1).cloned().unwrap_or_default()})),&cancel).await?,
 "ping"=>c.request("POST","/bot/send-message",Some(json!({"channel_id":c.channel,"content":args.first().ok_or("Missing message")?})),&cancel).await?,_=>return Err("Unknown agent command".into())};
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    Ok(())
}

async fn read_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    out: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<usize> {
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            return Ok(out.len());
        }
        let size = buf
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(buf.len());
        let take = size.min(limit.saturating_add(1).saturating_sub(out.len()));
        out.extend_from_slice(&buf[..take]);
        reader.consume(take);
        if out.len() > limit || out.ends_with(b"\n") {
            return Ok(out.len());
        }
    }
}

fn valid_listen(address: &str) -> bool {
    address
        .parse::<std::net::Ipv4Addr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified() || ip.is_private())
}
async fn health(args: &[String]) -> Result<()> {
    let url_arg = args
        .first()
        .ok_or("Use health HEALTH_URL [--wait SECONDS] [--host PUBLIC_HOST]")?;
    let mut wait = 0u64;
    let mut host = None;
    if args.len() % 2 != 1 {
        return Err("Invalid health options".into());
    }
    for pair in args[1..].chunks(2) {
        match pair[0].as_str() {
            "--wait" => wait = pair[1].parse().map_err(|_| "Invalid health wait")?,
            "--host" => {
                if pair[1].is_empty()
                    || !pair[1]
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".-:[]".contains(&c))
                {
                    return Err("Invalid health Host".into());
                }
                host = Some(pair[1].clone())
            }
            _ => return Err("Invalid health options".into()),
        }
    }
    if wait > 60 {
        return Err("Invalid health wait".into());
    }
    let url = url::Url::parse(url_arg).map_err(|_| "Invalid health URL")?;
    if url.path() != "/health"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use a bare /health URL".into());
    }
    // Health carries no credentials. A fixed private IPv4 target supports a
    // host-native helper behind an existing container proxy without publishing
    // its listener on every host interface. Connector/worker origins stay strict.
    let private_health = url.scheme() == "http" && url.host_str().is_some_and(valid_listen);
    if !private_health {
        origin(&url.origin().ascii_serialization())?;
    }
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| "Health check failed")?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait);
    loop {
        let mut request = http.get(url.clone());
        if let Some(host) = &host {
            request = request.header("Host", host);
        }
        if request.send().await.is_ok_and(|r| r.status().is_success()) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Health check failed".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
#[cfg(test)]
mod deployment_tests {
    use super::*;
    #[test]
    fn bind_only_explicit_ipv4_scopes() {
        for address in [
            "127.0.0.1",
            "127.0.0.2",
            "0.0.0.0",
            "172.19.0.1",
            "192.168.1.1",
            "10.0.0.1",
        ] {
            assert!(valid_listen(address));
        }
        for address in ["8.8.8.8", "example.org", "172.32.0.1", "0.0.0.0:4320"] {
            assert!(!valid_listen(address));
        }
        assert!(origin("http://172.19.0.1").is_err());
    }
}
