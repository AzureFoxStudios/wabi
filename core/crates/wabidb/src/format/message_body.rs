use crate::error::{Result, WabiError};

/// Maximum size of a message body plaintext in bytes (64 KiB).
///
/// Per endstate doc §6.3, DM plaintexts are capped at 64 KiB.
/// Channel message bodies have the same cap.
pub const MAX_MESSAGE_BODY_SIZE: usize = 65_536;

/// Verify that a message body plaintext satisfies size constraints.
///
/// # Errors
///
/// Returns `WabiError::Validation` if:
/// - `plaintext` is larger than [`MAX_MESSAGE_BODY_SIZE`] (64 KiB).
pub fn verify_message_body_constraints(plaintext: &[u8]) -> Result<()> {
    if plaintext.len() > MAX_MESSAGE_BODY_SIZE {
        return Err(WabiError::Validation {
            command: "send_message".into(),
            reason: format!(
                "message body too large: {} bytes (max {})",
                plaintext.len(),
                MAX_MESSAGE_BODY_SIZE
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_100_bytes_ok() {
        let body = vec![0u8; 100];
        assert!(verify_message_body_constraints(&body).is_ok());
    }

    #[test]
    fn body_65536_bytes_ok() {
        let body = vec![0u8; 65_536];
        assert!(verify_message_body_constraints(&body).is_ok());
    }

    #[test]
    fn body_65537_bytes_rejected() {
        let body = vec![0u8; 65_537];
        let err = verify_message_body_constraints(&body).unwrap_err();
        assert!(
            matches!(err, WabiError::Validation { .. }),
            "expected Validation, got {err:?}"
        );
    }

    #[test]
    fn empty_body_ok() {
        assert!(verify_message_body_constraints(b"").is_ok());
    }

    #[test]
    fn exactly_at_limit_ok() {
        let body = vec![0xABu8; MAX_MESSAGE_BODY_SIZE];
        assert!(verify_message_body_constraints(&body).is_ok());
    }
}
