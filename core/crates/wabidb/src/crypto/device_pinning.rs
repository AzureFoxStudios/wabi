use std::collections::HashMap;

use crate::error::{Result, WabiError};

/// Trust-on-first-use (TOFU) device key pinning.
///
/// On first encounter, a device's key is pinned. On subsequent encounters,
/// the presented key is verified against the pinned key. If they don't
/// match, the operation fails — the caller can choose to alert the user
/// of a potential MITM attack.
#[derive(Debug, Default)]
pub struct DevicePinning {
    /// Map from `device_id` to the pinned key identifier.
    pinned: HashMap<String, String>,
}

impl DevicePinning {
    /// Create an empty pinning store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Pin a key for a device (TOFU).
    ///
    /// If the device already has a pinned key and it matches `key_id`,
    /// this is a no-op. If the device is new, the key is pinned.
    /// If the device has a different pinned key, returns `Err`.
    pub fn pin_key(&mut self, device_id: &str, key_id: &str) -> Result<()> {
        match self.pinned.get(device_id) {
            Some(_) if self.pinned.get(device_id) == Some(&key_id.to_string()) => {
                // Same key — already pinned. No-op.
                Ok(())
            }
            Some(_) => {
                // Different key — TOFU violation.
                Err(WabiError::SignatureVerificationFailed)
            }
            None => {
                // First encounter — pin the key.
                self.pinned
                    .insert(device_id.to_string(), key_id.to_string());
                Ok(())
            }
        }
    }

    /// Get the pinned key ID for a device, if any.
    pub fn get_pinned(&self, device_id: &str) -> Option<&str> {
        self.pinned.get(device_id).map(|s| s.as_str())
    }

    /// Rotate the pinned key for a device.
    ///
    /// This replaces the existing pinned key with `new_key_id`.
    /// Returns an error if no key was previously pinned (use
    /// [`pin_key`](Self::pin_key) for first-time pinning).
    pub fn rotate_pinned(&mut self, device_id: &str, new_key_id: &str) -> Result<()> {
        if self.pinned.contains_key(device_id) {
            self.pinned
                .insert(device_id.to_string(), new_key_id.to_string());
            Ok(())
        } else {
            Err(WabiError::NotFound {
                what: format!("no pinned key for device {device_id}"),
            })
        }
    }

    /// Verify that `key_id` matches the pinned key for `device_id`.
    ///
    /// Returns `Ok(true)` if the key matches, `Ok(false)` if no key is
    /// pinned, or `Err` if the key doesn't match (TOFU violation).
    pub fn verify_pinned(&self, device_id: &str, key_id: &str) -> Result<bool> {
        match self.pinned.get(device_id) {
            Some(pinned) if pinned == key_id => Ok(true),
            Some(_) => Err(WabiError::SignatureVerificationFailed),
            None => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_first_encounter_succeeds() {
        let mut pinning = DevicePinning::new();
        pinning.pin_key("dev_01", "key_abc").unwrap();
        assert_eq!(pinning.get_pinned("dev_01"), Some("key_abc"));
    }

    #[test]
    fn same_key_twice_is_noop() {
        let mut pinning = DevicePinning::new();
        pinning.pin_key("dev_01", "key_abc").unwrap();
        pinning.pin_key("dev_01", "key_abc").unwrap(); // second time — no error
        assert_eq!(pinning.get_pinned("dev_01"), Some("key_abc"));
    }

    #[test]
    fn different_key_rejected() {
        let mut pinning = DevicePinning::new();
        pinning.pin_key("dev_01", "key_abc").unwrap();
        let err = pinning.pin_key("dev_01", "key_xyz");
        assert!(
            matches!(err, Err(WabiError::SignatureVerificationFailed)),
            "expected SignatureVerificationFailed, got {err:?}"
        );
    }

    #[test]
    fn get_pinned_returns_none_for_unknown() {
        let pinning = DevicePinning::new();
        assert!(pinning.get_pinned("dev_unknown").is_none());
    }

    #[test]
    fn rotate_pinned_replaces_key() {
        let mut pinning = DevicePinning::new();
        pinning.pin_key("dev_01", "key_abc").unwrap();
        pinning.rotate_pinned("dev_01", "key_def").unwrap();
        assert_eq!(pinning.get_pinned("dev_01"), Some("key_def"));
    }

    #[test]
    fn rotate_pinned_fails_if_not_pinned() {
        let mut pinning = DevicePinning::new();
        let err = pinning.rotate_pinned("dev_01", "key_abc");
        assert!(matches!(err, Err(WabiError::NotFound { .. })));
    }

    #[test]
    fn verify_pinned_matches() {
        let mut pinning = DevicePinning::new();
        pinning.pin_key("dev_01", "key_abc").unwrap();
        assert!(pinning.verify_pinned("dev_01", "key_abc").unwrap());
    }

    #[test]
    fn verify_pinned_mismatch_rejected() {
        let mut pinning = DevicePinning::new();
        pinning.pin_key("dev_01", "key_abc").unwrap();
        let err = pinning.verify_pinned("dev_01", "key_xyz");
        assert!(
            matches!(err, Err(WabiError::SignatureVerificationFailed)),
            "expected SignatureVerificationFailed, got {err:?}"
        );
    }

    #[test]
    fn verify_pinned_unknown_returns_false() {
        let pinning = DevicePinning::new();
        assert!(!pinning.verify_pinned("dev_01", "key_abc").unwrap());
    }
}
