use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct RouteToken {
    pub token_id: String,
    pub user_id: u64,
    pub device_id: String,
    pub token_hash: [u8; 32],
    pub issued_at_micros: i64,
    pub expires_at_micros: i64,
    pub revoked: bool,
}

#[derive(Debug, Default)]
pub struct RouteTokensTable {
    tokens: Mutex<HashMap<String, RouteToken>>,
}

impl RouteTokensTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issue(
        &self,
        token_id: String,
        user_id: u64,
        device_id: String,
        token_str: &str,
        ttl_micros: i64,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        let token_hash = blake3::hash(token_str.as_bytes());
        let token = RouteToken {
            token_id,
            user_id,
            device_id,
            token_hash: *token_hash.as_bytes(),
            issued_at_micros: now,
            expires_at_micros: now + ttl_micros,
            revoked: false,
        };
        let mut tokens = self.tokens.lock().unwrap();
        tokens.insert(token.token_id.clone(), token);
        Ok(())
    }

    pub fn lookup_by_hash(&self, token_str: &str) -> Option<RouteToken> {
        let hash = blake3::hash(token_str.as_bytes());
        let tokens = self.tokens.lock().unwrap();
        tokens
            .values()
            .find(|t| t.token_hash == *hash.as_bytes() && !t.revoked)
            .cloned()
    }

    pub fn revoke(&self, token_id: &str) -> Result<()> {
        let mut tokens = self.tokens.lock().unwrap();
        let token = tokens.get_mut(token_id).ok_or_else(|| {
            WabiError::NotFound { what: format!("route token {token_id}") }
        })?;
        token.revoked = true;
        Ok(())
    }

    pub fn purge_expired(&self) -> usize {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        let mut tokens = self.tokens.lock().unwrap();
        let before = tokens.len();
        tokens.retain(|_, t| t.expires_at_micros > now && !t.revoked);
        before - tokens.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_table() -> RouteTokensTable {
        RouteTokensTable::new()
    }

    #[test]
    fn issue_and_lookup() {
        let table = make_table();
        table.issue("rt_1".into(), 42, "dev_1".into(), "route-secret", 60_000_000).unwrap();
        let found = table.lookup_by_hash("route-secret").unwrap();
        assert_eq!(found.user_id, 42);
    }

    #[test]
    fn lookup_unknown_returns_none() {
        let table = make_table();
        assert!(table.lookup_by_hash("no-such").is_none());
    }

    #[test]
    fn revoke_marks_token() {
        let table = make_table();
        table.issue("rt_2".into(), 1, "dev_2".into(), "revocable", 60_000_000).unwrap();
        table.revoke("rt_2").unwrap();
        assert!(table.lookup_by_hash("revocable").is_none());
    }

    #[test]
    fn hash_mismatch_returns_none() {
        let table = make_table();
        table.issue("rt_3".into(), 1, "dev_3".into(), "real", 60_000_000).unwrap();
        assert!(table.lookup_by_hash("fake").is_none());
    }

    #[test]
    fn purge_expired() {
        let table = make_table();
        table.issue("rt_keep".into(), 1, "d1".into(), "keep", 60_000_000).unwrap();
        table.issue("rt_gone".into(), 2, "d2".into(), "gone", 1).unwrap();
        std::thread::sleep(std::time::Duration::from_micros(2));
        let purged = table.purge_expired();
        assert!(purged >= 1);
        assert!(table.lookup_by_hash("keep").is_some());
        assert!(table.lookup_by_hash("gone").is_none());
    }
}
