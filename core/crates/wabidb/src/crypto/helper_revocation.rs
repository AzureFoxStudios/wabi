use std::collections::HashMap;


/// A list of revoked helper-node tokens.
///
/// Tokens are identified by their `token_id` and the revocation time is
/// stored as microseconds since the Unix epoch.
#[derive(Debug, Default)]
pub struct TokenRevocationList {
    revoked: HashMap<String, i64>,
}

impl TokenRevocationList {
    /// Create an empty revocation list.
    pub fn new() -> Self {
        Self::default()
    }

    /// Revoke a token at the given microsecond timestamp.
    ///
    /// If the token was already revoked, its timestamp is overwritten with
    /// the new one.
    pub fn revoke(&mut self, token_id: &str, revoked_at_micros: i64) {
        self.revoked
            .insert(token_id.to_string(), revoked_at_micros);
    }

    /// Check whether a token has been revoked.
    pub fn is_revoked(&self, token_id: &str) -> bool {
        self.revoked.contains_key(token_id)
    }

    /// List all currently revoked tokens and their revocation timestamps.
    pub fn list_revoked(&self) -> Vec<(String, i64)> {
        let mut entries: Vec<_> = self
            .revoked
            .iter()
            .map(|(id, ts)| (id.clone(), *ts))
            .collect();
        entries.sort_by(|a, b| a.1.cmp(&b.1));
        entries
    }

    /// Remove all revoked entries whose timestamp is older than `before_micros`.
    ///
    /// Returns the number of entries that were purged.
    pub fn purge_expired(&mut self, before_micros: i64) -> usize {
        let before = before_micros;
        let len_before = self.revoked.len();
        self.revoked.retain(|_, ts| *ts >= before);
        len_before - self.revoked.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revoke_and_is_revoked() {
        let mut list = TokenRevocationList::new();
        assert!(!list.is_revoked("token_01"));

        list.revoke("token_01", 1_000_000);
        assert!(list.is_revoked("token_01"));
    }

    #[test]
    fn list_all_revoked() {
        let mut list = TokenRevocationList::new();
        list.revoke("token_b", 2_000_000);
        list.revoke("token_a", 1_000_000);

        let entries = list.list_revoked();
        assert_eq!(entries.len(), 2);
        // Sorted by timestamp ascending.
        assert_eq!(entries[0].0, "token_a");
        assert_eq!(entries[1].0, "token_b");
    }

    #[test]
    fn purge_expired_removes_old_entries() {
        let mut list = TokenRevocationList::new();
        list.revoke("old", 100_000);
        list.revoke("recent", 500_000);
        list.revoke("current", 1_000_000);

        let purged = list.purge_expired(600_000);
        assert_eq!(purged, 2, "'old' and 'recent' should be purged");
        assert!(!list.is_revoked("old"));
        assert!(!list.is_revoked("recent"));
        assert!(list.is_revoked("current"));
    }

    #[test]
    fn purge_all_when_all_expired() {
        let mut list = TokenRevocationList::new();
        list.revoke("a", 100);
        list.revoke("b", 200);

        let purged = list.purge_expired(300);
        assert_eq!(purged, 2);
        assert!(list.list_revoked().is_empty());
    }

    #[test]
    fn purge_none_when_none_expired() {
        let mut list = TokenRevocationList::new();
        list.revoke("a", 1_000_000);
        list.revoke("b", 2_000_000);

        let purged = list.purge_expired(500_000);
        assert_eq!(purged, 0);
        assert_eq!(list.list_revoked().len(), 2);
    }
}
