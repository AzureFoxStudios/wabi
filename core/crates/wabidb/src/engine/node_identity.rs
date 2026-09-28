//! Operator-selected identity of this engine runtime. This is immutable for
//! its lifetime; it is not a certificate, distributed lease or failover epoch.

use crate::error::{Result, WabiError};

pub const DEFAULT_NODE_ID: &str = "node-1";

pub fn valid_node_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_'))
}

pub(crate) fn validate(value: &str) -> Result<()> {
    if !valid_node_id(value) {
        return Err(WabiError::Validation {
            command: "configure_local_node".into(),
            reason: "invalid engine node ID".into(),
        });
    }
    Ok(())
}
