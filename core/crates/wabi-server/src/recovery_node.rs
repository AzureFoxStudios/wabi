//! Explicit experimental recovery-node entry point. Operator configuration is
//! private local input; this mode never constructs AppState, JWTs or WabiDB.
//! It owns control/material stores only and grants no Authority/writer role.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    future::Future,
    io::{Read, Write},
    net::SocketAddr,
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::{Component, Path, PathBuf},
    time::Duration,
};
use wabi_consensus::{
    material::MaterialLimits,
    model::{RecoveryPeer, StoreBinding},
    runtime::{RecoveryRuntime, RuntimePolicy},
    store::StoreLimits,
    transport::{Limits, ServerReport},
};

const NOFOLLOW: i32 = 0o400000;
const DIRECTORY: i32 = 0o200000;
const NONBLOCK: i32 = 0o4000;
const MAX_CONFIG_BYTES: u64 = 32 * 1024;
const MINIMUM_FREE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum RecoveryNodeError {
    #[error("recovery node configuration refused")]
    Configuration,
    #[error("recovery node configuration ownership refused")]
    Ownership,
    #[error("recovery node startup refused")]
    Startup,
    #[error("recovery node shutdown failed")]
    Shutdown,
    #[error("recovery node status output failed")]
    Output,
}
type Result<T> = std::result::Result<T, RecoveryNodeError>;

/// Versioned operator file, not an API payload. Limits remain the bounded
/// library defaults; this format does not introduce arbitrary resource knobs.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryNodeConfig {
    pub schema_version: u8,
    pub binding: StoreBinding,
    #[serde(deserialize_with = "unique_roster")]
    pub peers: BTreeMap<u64, RecoveryPeer>,
    pub source_node_id: String,
    pub identity_directory: PathBuf,
    pub control_directory: PathBuf,
    pub material_directory: PathBuf,
    pub bind_address: Option<SocketAddr>,
    pub initialize: bool,
    pub work_timeout_seconds: u64,
    pub rpc_deadline_milliseconds: u64,
    pub minimum_free_bytes: u64,
}

fn unique_roster<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<BTreeMap<u64, RecoveryPeer>, D::Error> {
    struct Roster;
    impl<'de> serde::de::Visitor<'de> for Roster {
        type Value = BTreeMap<u64, RecoveryPeer>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("exactly three distinct canonical recovery peer IDs")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut peers = BTreeMap::new();
            while let Some((key, peer)) = map.next_entry::<String, RecoveryPeer>()? {
                let id = key
                    .parse::<u64>()
                    .map_err(|_| serde::de::Error::custom("invalid peer ID"))?;
                if id == 0
                    || key != id.to_string()
                    || peers.len() >= 3
                    || peers.insert(id, peer).is_some()
                {
                    return Err(serde::de::Error::custom("duplicate/noncanonical peer ID"));
                }
            }
            if peers.len() != 3 {
                return Err(serde::de::Error::custom("three peers required"));
            }
            Ok(peers)
        }
    }
    deserializer.deserialize_map(Roster)
}

fn absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path.as_os_str().len() <= 4096
        && !path
            .as_os_str()
            .as_bytes()
            .split(|b| *b == b'/')
            .any(|part| part == b"." || part == b"..")
        && !path
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
}

impl RecoveryNodeConfig {
    fn policy(self) -> Result<RuntimePolicy> {
        if self.schema_version != 1
            || !wabi_consensus::model::identifier_valid(&self.source_node_id)
            || !(1..=30).contains(&self.work_timeout_seconds)
            || !(50..=5000).contains(&self.rpc_deadline_milliseconds)
            || self.rpc_deadline_milliseconds > self.work_timeout_seconds * 1000
            || !(MINIMUM_FREE_BYTES..=16 * 1024 * 1024 * 1024).contains(&self.minimum_free_bytes)
            || self
                .binding
                .community_id
                .bytes()
                .any(|c| !c.is_ascii_digit() && !(b'a'..=b'f').contains(&c))
            || [
                &self.identity_directory,
                &self.control_directory,
                &self.material_directory,
            ]
            .into_iter()
            .any(|p| !absolute_path(p))
            || (self.initialize && self.peers.keys().next().copied() != Some(self.binding.node_id))
        {
            return Err(RecoveryNodeError::Configuration);
        }
        wabi_consensus::trust::validate_three_voter_roster(&self.binding, &self.peers)
            .map_err(|_| RecoveryNodeError::Configuration)?;
        Ok(RuntimePolicy {
            binding: self.binding,
            peers: self.peers,
            source_node_id: self.source_node_id,
            identity_directory: self.identity_directory,
            control_directory: self.control_directory,
            material_directory: self.material_directory,
            bind_address: self.bind_address,
            initialize: self.initialize,
            control_limits: StoreLimits {
                min_free_bytes: self.minimum_free_bytes,
                ..Default::default()
            },
            material_limits: MaterialLimits {
                min_free_bytes: self.minimum_free_bytes,
                ..Default::default()
            },
            transport_limits: Limits {
                rpc_deadline: Duration::from_millis(self.rpc_deadline_milliseconds),
                ..Default::default()
            },
            work_timeout: Duration::from_secs(self.work_timeout_seconds),
        })
    }
}

/// Read through a pinned private parent directory and verify both original
/// inodes afterward. No chmod, identity generation or data creation occurs.
pub fn load(path: &Path) -> Result<RuntimePolicy> {
    let ownership = |_| RecoveryNodeError::Ownership;
    if !absolute_path(path) {
        return Err(RecoveryNodeError::Ownership);
    }
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor)
            .map_err(ownership)?
            .file_type()
            .is_symlink()
        {
            return Err(RecoveryNodeError::Ownership);
        }
    }
    let parent = path.parent().ok_or(RecoveryNodeError::Ownership)?;
    let name = path.file_name().ok_or(RecoveryNodeError::Ownership)?;
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(NOFOLLOW | DIRECTORY)
        .open(parent)
        .map_err(ownership)?;
    let root_meta = root.metadata().map_err(ownership)?;
    let uid = fs::metadata("/proc/self").map_err(ownership)?.uid();
    if root_meta.uid() != uid || root_meta.mode() & 0o077 != 0 {
        return Err(RecoveryNodeError::Ownership);
    }
    let pinned = PathBuf::from(format!("/proc/self/fd/{}", root.as_raw_fd())).join(name);
    let private =
        |m: &fs::Metadata| m.is_file() && m.nlink() == 1 && m.uid() == uid && m.mode() & 0o077 == 0;
    let expected = fs::symlink_metadata(&pinned).map_err(ownership)?;
    if !private(&expected) || expected.file_type().is_symlink() || expected.len() > MAX_CONFIG_BYTES
    {
        return Err(RecoveryNodeError::Ownership);
    }
    // Nonblocking open also refuses a FIFO replacement without stranding an
    // owned startup read; regular files retain their ordinary read semantics.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(NOFOLLOW | NONBLOCK)
        .open(&pinned)
        .map_err(ownership)?;
    let before = file.metadata().map_err(ownership)?;
    if !private(&before)
        || before.len() > MAX_CONFIG_BYTES
        || (expected.dev(), expected.ino(), expected.len())
            != (before.dev(), before.ino(), before.len())
    {
        return Err(RecoveryNodeError::Ownership);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(ownership)?;
    let named = fs::symlink_metadata(&pinned).map_err(ownership)?;
    let held = file.metadata().map_err(ownership)?;
    let current_parent = fs::symlink_metadata(parent).map_err(ownership)?;
    if bytes.len() as u64 != before.len()
        || !private(&named)
        || !private(&held)
        || named.file_type().is_symlink()
        || named.len() != before.len()
        || (before.dev(), before.ino()) != (named.dev(), named.ino())
        || (before.dev(), before.ino(), before.len()) != (held.dev(), held.ino(), held.len())
        || !current_parent.is_dir()
        || current_parent.file_type().is_symlink()
        || current_parent.uid() != uid
        || current_parent.mode() & 0o077 != 0
        || (root_meta.dev(), root_meta.ino()) != (current_parent.dev(), current_parent.ino())
    {
        return Err(RecoveryNodeError::Ownership);
    }
    let config: RecoveryNodeConfig =
        serde_json::from_slice(&bytes).map_err(|_| RecoveryNodeError::Configuration)?;
    config.policy()
}

/// Start and drain the actual managed node. Even a shutdown received during
/// startup waits for the owned startup result and then drains its stores.
/// Abandoning this future drops the runtime owner and requests its drain.
pub async fn run(path: PathBuf, shutdown: impl Future<Output = ()>) -> Result<ServerReport> {
    tokio::pin!(shutdown);
    let mut loading = tokio::task::spawn_blocking(move || load(&path));
    let policy = tokio::select! {
        biased;
        _ = &mut shutdown => {
            // File reads are owned, not forcibly interruptible. They open no stores.
            let _ = loading.await.map_err(|_| RecoveryNodeError::Configuration)?;
            return Ok(ServerReport::default());
        },
        result = &mut loading => result.map_err(|_| RecoveryNodeError::Configuration)??,
    };
    let starting = RecoveryRuntime::start(policy);
    tokio::pin!(starting);
    let runtime = tokio::select! {
        biased;
        _ = &mut shutdown => {
            let runtime = starting.await.map_err(|_| RecoveryNodeError::Startup)?;
            return runtime.shutdown().await.map_err(|_| RecoveryNodeError::Shutdown);
        },
        result = &mut starting => result.map_err(|_| RecoveryNodeError::Startup)?,
    };
    // This is lifecycle status only: accepting does not imply membership,
    // byte availability, Authority readiness or writer permission.
    let announced = (|| {
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(
            &mut output,
            &serde_json::json!({
                "role": "experimental_recovery_node", "status": runtime.status(),
            }),
        )
        .map_err(|_| RecoveryNodeError::Output)?;
        output
            .write_all(b"\n")
            .map_err(|_| RecoveryNodeError::Output)?;
        output.flush().map_err(|_| RecoveryNodeError::Output)?;
        Ok::<_, RecoveryNodeError>(())
    })();
    if announced.is_err() {
        runtime
            .shutdown()
            .await
            .map_err(|_| RecoveryNodeError::Shutdown)?;
        return Err(RecoveryNodeError::Output);
    }
    let mut health = tokio::time::interval(Duration::from_millis(250));
    health.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break,
            _ = health.tick() => if !runtime.status().accepting { break; },
        }
    }
    runtime
        .shutdown()
        .await
        .map_err(|_| RecoveryNodeError::Shutdown)
}

#[cfg(test)]
mod tests;
