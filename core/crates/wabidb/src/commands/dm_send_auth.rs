use crate::error::{Result, WabiError};
use std::collections::HashSet;

pub fn check_dm_send_authorized(sender_id: u64, recipients: &[u64]) -> Result<()> {
    if recipients.is_empty() {
        return Err(WabiError::Validation {
            command: "send_dm".into(),
            reason: "recipient list must not be empty".into(),
        });
    }

    let mut seen = HashSet::new();
    for &r in recipients {
        if !seen.insert(r) {
            return Err(WabiError::Validation {
                command: "send_dm".into(),
                reason: format!("duplicate recipient: {r}"),
            });
        }
    }

    if !recipients.contains(&sender_id) {
        return Err(WabiError::Forbidden {
            user_id: sender_id,
            command: "send_dm".into(),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_send_returns_ok() {
        let result = check_dm_send_authorized(1, &[1, 2, 3]);
        assert!(result.is_ok());
    }

    #[test]
    fn sender_not_in_list_rejected() {
        let err = check_dm_send_authorized(5, &[1, 2, 3]).unwrap_err();
        assert!(matches!(err, WabiError::Forbidden { user_id: 5, .. }));
    }

    #[test]
    fn empty_recipient_list_rejected() {
        let err = check_dm_send_authorized(1, &[]).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn duplicate_recipient_rejected() {
        let err = check_dm_send_authorized(1, &[1, 2, 2]).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn single_recipient_self_dm_ok() {
        let result = check_dm_send_authorized(1, &[1]);
        assert!(result.is_ok());
    }

    #[test]
    fn many_recipients_all_valid() {
        let recipients: Vec<u64> = (1..=50).collect();
        let result = check_dm_send_authorized(1, &recipients);
        assert!(result.is_ok());
    }

    #[test]
    fn duplicate_at_start_rejected() {
        let err = check_dm_send_authorized(1, &[1, 1, 2]).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }
}
