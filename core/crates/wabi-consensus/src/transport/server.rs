use super::{
    rpc::{Request, Response},
    Config, Error, Result,
};
use crate::ConsensusTypes;
use std::{sync::Arc, time::Instant};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Semaphore},
    task::JoinSet,
};

#[derive(Clone)]
enum MaterialHandler {
    Disabled,
    #[cfg(target_os = "linux")]
    Enabled(super::material::MaterialIo),
}

#[derive(Clone, Copy, Default, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerReport {
    pub authenticated_rpcs: u64,
    pub refused_connections: u64,
    pub budget_drops: u64,
    pub aborted_connections: u64,
}

/// Serve only the exact explicitly approved local IP endpoint. No plaintext
/// health/admin or proposal API is exposed on the network listener.
pub async fn serve(
    listener: TcpListener,
    raft: openraft::Raft<ConsensusTypes>,
    config: Arc<Config>,
    stop: oneshot::Receiver<()>,
) -> Result<ServerReport> {
    serve_inner(
        listener,
        Some(raft),
        config,
        stop,
        MaterialHandler::Disabled,
    )
    .await
}

/// Explicitly opt in to recovery ciphertext service. An ordinary Raft listener
/// refuses material requests. Shutdown drains admitted blocking work after its
/// connection tasks end; a stuck filesystem syscall can delay completion.
#[cfg(target_os = "linux")]
pub async fn serve_with_material(
    listener: TcpListener,
    raft: openraft::Raft<ConsensusTypes>,
    config: Arc<Config>,
    stop: oneshot::Receiver<()>,
    material: super::material::MaterialService,
) -> Result<ServerReport> {
    if !material.matches(&config) {
        return Err(Error::Authentication);
    }
    serve_inner(
        listener,
        Some(raft),
        config,
        stop,
        MaterialHandler::Enabled(material.io),
    )
    .await
}

/// Ciphertext-only recovery endpoint for the same fixed voter roster. This
/// grants no Authority role and refuses all Raft operations on this listener.
#[cfg(target_os = "linux")]
pub async fn serve_checkpoint(
    listener: TcpListener,
    config: Arc<Config>,
    stop: oneshot::Receiver<()>,
    material: super::material::MaterialService,
) -> Result<ServerReport> {
    if !material.matches(&config) {
        return Err(Error::Authentication);
    }
    serve_inner(
        listener,
        None,
        config,
        stop,
        MaterialHandler::Enabled(material.io),
    )
    .await
}

async fn serve_inner(
    listener: TcpListener,
    raft: Option<openraft::Raft<ConsensusTypes>>,
    config: Arc<Config>,
    mut stop: oneshot::Receiver<()>,
    material: MaterialHandler,
) -> Result<ServerReport> {
    if listener.local_addr().map_err(|_| Error::Io)? != config.local_address() {
        return Err(Error::Authentication);
    }
    let permits = Arc::new(Semaphore::new(config.limits.inbound_connections));
    let mut tasks: JoinSet<Result<()>> = JoinSet::new();
    let mut report = ServerReport::default();
    let mut failure = None;
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => break,
            completed = tasks.join_next(), if !tasks.is_empty() => {
                match completed {
                    Some(Ok(Ok(()))) => report.authenticated_rpcs += 1,
                    Some(Ok(Err(_))) => report.refused_connections += 1,
                    Some(Err(_)) => report.aborted_connections += 1,
                    None => (),
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = match accepted {
                    Ok(value) => value,
                    Err(_) => { failure = Some(Error::Io); break; }
                };
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    report.budget_drops += 1;
                    drop(stream);
                    continue;
                };
                let config = config.clone();
                let raft = raft.clone();
                let material = material.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let started = Instant::now();
                    tokio::time::timeout(config.limits.rpc_deadline, async {
                        stream.set_nodelay(true).map_err(|_| Error::Io)?;
                        let (source, mut channel) = config.accept(stream).await?;
                        let bytes = channel.receive().await?;
                        let request: Request = serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)?;
                        config.request_valid(source, config.node_id(), &request)?;
                        let response = match request {
                            Request::Append(rpc) => match raft { Some(raft) => raft.append_entries(rpc).await.map(Response::Append).unwrap_or(Response::Refused), None => Response::Refused },
                            Request::Vote(rpc) => match raft { Some(raft) => raft.vote(rpc).await.map(Response::Vote).unwrap_or(Response::Refused), None => Response::Refused },
                            Request::Snapshot(rpc) => match raft { Some(raft) => raft.install_snapshot(rpc).await.map(Response::Snapshot).unwrap_or(Response::Refused), None => Response::Refused },
                            #[cfg(target_os = "linux")]
                            Request::Material(request) => {
                                match material {
                                    MaterialHandler::Enabled(io) => io.execute(request).await.map(Response::Material).unwrap_or(Response::Refused),
                                    MaterialHandler::Disabled => Response::Refused,
                                }
                            }
                        };
                        let response = serde_json::to_vec(&response).map_err(|_| Error::Protocol)?;
                        if response.len() > config.limits.max_rpc_bytes { return Err(Error::Budget); }
                        if started.elapsed() >= config.limits.rpc_deadline { return Err(Error::Deadline); }
                        channel.send(&response).await?;
                        Ok(())
                    }).await.map_err(|_| Error::Deadline)?
                });
            }
        }
    }
    // Server shutdown owns its connection tasks. It cannot detach an RPC or
    // retain a listener after returning. Store IO remains independently owned
    // after cancellation, and callers separately shut down their Raft node.
    drop(listener);
    tasks.abort_all();
    while let Some(completed) = tasks.join_next().await {
        match completed {
            Ok(Ok(())) => report.authenticated_rpcs += 1,
            Ok(Err(_)) => report.refused_connections += 1,
            Err(_) => report.aborted_connections += 1,
        }
    }
    #[cfg(target_os = "linux")]
    if let MaterialHandler::Enabled(material) = material {
        material.close().await;
    }
    if let Some(error) = failure {
        Err(error)
    } else {
        Ok(report)
    }
}
