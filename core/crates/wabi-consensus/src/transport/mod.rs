//! Experimental encrypted recovery RPC for a fixed, explicitly approved
//! three-voter roster. Helpers/account tokens cannot enter this protocol.
mod channel;
mod identity;
#[cfg(target_os = "linux")]
mod material;
mod rpc;
mod server;

use crate::model::{RecoveryPeer, StoreBinding};
pub use identity::Identity;
#[cfg(target_os = "linux")]
pub use material::{
    AuthenticatedCheckpointAck, CheckpointAvailabilityProposal, CheckpointAvailabilityRound,
    CheckpointClient, CommittedCheckpointObservation, MaterialService,
};
pub use rpc::Network;
pub use server::{serve, ServerReport};
#[cfg(target_os = "linux")]
pub use server::{serve_checkpoint, serve_with_material};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

const PATTERN: &str = "Noise_KK_25519_ChaChaPoly_SHA256";

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("recovery RPC authentication refused")]
    Authentication,
    #[error("recovery RPC protocol refused")]
    Protocol,
    #[error("recovery RPC budget exceeded")]
    Budget,
    #[error("recovery RPC deadline exceeded")]
    Deadline,
    #[error("recovery RPC unavailable")]
    Io,
    #[error("recovery RPC refused by peer")]
    Refused,
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub struct Limits {
    pub rpc_deadline: Duration,
    pub max_rpc_bytes: usize,
    pub inbound_connections: usize,
    pub outbound_connections: usize,
    pub max_append_entries: usize,
    pub max_snapshot_chunk: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            rpc_deadline: Duration::from_secs(5),
            max_rpc_bytes: 1024 * 1024,
            inbound_connections: 8,
            outbound_connections: 4,
            max_append_entries: 64,
            max_snapshot_chunk: 64 * 1024,
        }
    }
}
impl Limits {
    fn valid(&self) -> bool {
        !self.rpc_deadline.is_zero()
            && self.rpc_deadline <= Duration::from_secs(30)
            && (1024..=2 * 1024 * 1024).contains(&self.max_rpc_bytes)
            && (1..=32).contains(&self.inbound_connections)
            && (1..=16).contains(&self.outbound_connections)
            && (1..=128).contains(&self.max_append_entries)
            && (1..=64 * 1024).contains(&self.max_snapshot_chunk)
    }
}
#[derive(Clone)]
pub struct Config {
    binding: StoreBinding,
    peers: BTreeMap<u64, RecoveryPeer>,
    keys: BTreeMap<u64, [u8; 32]>,
    identity: Arc<Identity>,
    community: [u8; 32],
    partition: [u8; 32],
    roster_digest: [u8; 32],
    bind_address: std::net::SocketAddr,
    limits: Limits,
    outbound: Arc<tokio::sync::Semaphore>,
}
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryTransportConfig([REDACTED])")
    }
}
impl Config {
    #[cfg(target_os = "linux")]
    pub(crate) fn checkpoint_roster_matches(
        &self,
        community: &str,
        partition: &str,
        peers: &BTreeMap<u64, RecoveryPeer>,
    ) -> bool {
        self.binding.community_id == community
            && self.binding.partition_id == partition
            && &self.peers == peers
    }
    pub fn new(
        binding: StoreBinding,
        peers: BTreeMap<u64, RecoveryPeer>,
        identity: Arc<Identity>,
        limits: Limits,
    ) -> Result<Self> {
        crate::trust::validate_three_voter_roster(&binding, &peers)
            .map_err(|_| Error::Authentication)?;
        if !limits.valid() {
            return Err(Error::Budget);
        }
        let mut keys = BTreeMap::new();
        let local = x25519_dalek::StaticSecret::from(*identity.private_bytes());
        for (id, peer) in &peers {
            let key: [u8; 32] = hex::decode(&peer.public_key)
                .map_err(|_| Error::Authentication)?
                .try_into()
                .map_err(|_| Error::Authentication)?;
            if hex::encode(key) != peer.public_key
                || !local
                    .diffie_hellman(&x25519_dalek::PublicKey::from(key))
                    .was_contributory()
            {
                return Err(Error::Authentication);
            }
            keys.insert(*id, key);
        }
        if keys.get(&binding.node_id) != Some(identity.public_bytes()) {
            return Err(Error::Authentication);
        }
        let community = hex::decode(&binding.community_id)
            .map_err(|_| Error::Authentication)?
            .try_into()
            .map_err(|_| Error::Authentication)?;
        let partition = Sha256::digest(binding.partition_id.as_bytes()).into();
        let roster_bytes = serde_json::to_vec(&peers).map_err(|_| Error::Protocol)?;
        let mut hash = Sha256::new();
        hash.update(b"wabi-recovery-roster/noise-kk-v1\0");
        hash.update(roster_bytes);
        let roster_digest = hash.finalize().into();
        let bind_address = peers[&binding.node_id]
            .rpc_address
            .parse()
            .map_err(|_| Error::Authentication)?;
        let outbound = Arc::new(tokio::sync::Semaphore::new(limits.outbound_connections));
        Ok(Self {
            binding,
            peers,
            keys,
            identity,
            community,
            partition,
            roster_digest,
            bind_address,
            limits,
            outbound,
        })
    }
    pub fn local_address(&self) -> std::net::SocketAddr {
        self.bind_address
    }
    /// Explicit local listener for an approved endpoint behind NAT or an
    /// ingress relay. Advertised peer addresses and handshake identity remain
    /// the original immutable approved roster; no discovered redirect is used.
    pub fn with_bind_address(mut self, address: std::net::SocketAddr) -> Result<Self> {
        if address.port() == 0
            || address.ip().is_multicast()
            || address.ip().is_unspecified()
            || matches!(address.ip(), std::net::IpAddr::V4(ip) if ip.is_broadcast())
        {
            return Err(Error::Protocol);
        }
        self.bind_address = address;
        Ok(self)
    }
    pub fn node_id(&self) -> u64 {
        self.binding.node_id
    }
    pub fn roster_digest(&self) -> String {
        hex::encode(self.roster_digest)
    }
}

#[cfg(test)]
mod tests;
