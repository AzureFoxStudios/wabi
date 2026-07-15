use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct PairToken {
    pub token_id: String,
    pub user_id: u64,
    pub device_id: String,
    pub token_hash: [u8; 32],
    pub issued_at_micros: i64,
    pub expires_at_micros: i64,
    pub revoked: bool,
}

#[derive(Debug, Default)]
pub struct PairTokensTable {
    tokens: Mutex<HashMap<String, PairToken>>,
}

impl PairTokensTable {
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
        let token = PairToken {
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

    pub fn lookup_by_hash(&self, token_str: &str) -> Option<PairToken> {
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
            WabiError::NotFound { what: format!("pair token {token_id}") }
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

    fn make_table() -> PairTokensTable {
        PairTokensTable::new()
    }

    #[test]
    fn issue_and_lookup() {
        let table = make_table();
        table.issue("tok_1".into(), 42, "dev_1".into(), "secret-token-abc", 60_000_000).unwrap();
        let found = table.lookup_by_hash("secret-token-abc").unwrap();
        assert_eq!(found.user_id, 42);
        assert_eq!(found.device_id, "dev_1");
    }

    #[test]
    fn lookup_unknown_returns_none() {
        let table = make_table();
        assert!(table.lookup_by_hash("nonexistent").is_none());
    }

    #[test]
    fn revoke_marks_token() {
        let table = make_table();
        table.issue("tok_2".into(), 1, "dev_2".into(), "token-to-revoke", 60_000_000).unwrap();
        table.revoke("tok_2").unwrap();
        assert!(table.lookup_by_hash("token-to-revoke").is_none());
    }

    #[test]
    fn hash_mismatch_returns_none() {
        let table = make_table();
        table.issue("tok_3".into(), 1, "dev_3".into(), "original-token", 60_000_000).unwrap();
        assert!(table.lookup_by_hash("wrong-token").is_none());
    }

    #[test]
    fn purge_expired_removes_stale() {
        let table = make_table();
        table.issue("tok_keep".into(), 1, "dev_1".into(), "keep", 60_000_000).unwrap();
        table.issue("tok_gone".into(), 2, "dev_2".into(), "gone", 1).unwrap();
        std::thread::sleep(std::time::Duration::from_micros(2));
        let purged = table.purge_expired();
        assert!(purged >= 1);
        assert!(table.lookup_by_hash("keep").is_some());
        assert!(table.lookup_by_hash("gone").is_none());
    }
}
