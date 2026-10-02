//! Explicit recovery roster preflight. Helper pairing is not input to this API.
use crate::model::{RecoveryPeer, StoreBinding};
use crate::store::StoreError;
use std::collections::{BTreeMap, BTreeSet};

pub fn validate_three_voter_roster(
    binding: &StoreBinding,
    peers: &BTreeMap<u64, RecoveryPeer>,
) -> Result<(), StoreError> {
    if !binding.valid() || peers.len() != 3 || !peers.contains_key(&binding.node_id) {
        return Err(StoreError::Format);
    }
    let mut sites = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut endpoints = BTreeSet::new();
    for (id, peer) in peers {
        if *id == 0
            || !peer.valid_for(&binding.community_id)
            || !sites.insert(peer.site_id.to_ascii_lowercase())
            || !keys.insert(peer.public_key.to_ascii_lowercase())
            || !endpoints.insert(
                peer.rpc_address
                    .parse::<std::net::SocketAddr>()
                    .map_err(|_| StoreError::Format)?,
            )
        {
            return Err(StoreError::Format);
        }
    }
    Ok(())
}
