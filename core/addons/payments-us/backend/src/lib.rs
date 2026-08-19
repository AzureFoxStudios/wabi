//! Wabi `payments-us` addon — manual US payment rails.
//!
//! Roadmap Phase 4 (docs/plans/2026-08-18-payments-p2p-audit-and-roadmap.md):
//! no open bank QR standard exists in the US, so the rail is pointer display
//! + a `WABI-XXXX` reference code the payer includes as the payment memo —
//! "the reconciliation API that doesn't require any API." Confirmation stays
//! manual (admin checks the receiving account).
//!
//! Rail order per §2b (doxx floor, aliased first): Cash App $cashtag / Venmo
//! @handle (counterparty-aliased), Zelle (bank-registered legal name —
//! disclosed), ACH routing+account (last resort with warning).

use serde_json::{json, Value};

/// Rails with their doxx-floor disclosure strings (§2b).
pub struct UsRail {
    pub id: &'static str,
    pub label: &'static str,
    pub disclosure: &'static str,
}

pub const RAILS: &[UsRail] = &[
    UsRail {
        id: "cashapp_pointer",
        label: "Cash App $cashtag",
        disclosure: "Cash App shows your chosen display name and $cashtag to the payer — your legal name stays with Cash App (Block), not with the counterparty.",
    },
    UsRail {
        id: "venmo_handle",
        label: "Venmo @handle",
        disclosure: "Venmo shows your chosen display name and @handle — your legal name stays with Venmo (PayPal), not with the counterparty.",
    },
    UsRail {
        id: "zelle_pointer",
        label: "Zelle",
        disclosure: "Zelle shows your bank-registered legal name and phone/email to the payer. This is the high-doxx rail — only choose it if you accept that exposure.",
    },
    UsRail {
        id: "ach_details",
        label: "ACH (routing + account)",
        disclosure: "ACH details expose your account numbers, which are pull-capable. Last resort only: prefer Cash App, Venmo, or Zelle.",
    },
];

pub fn rail_info(id: &str) -> Option<&'static UsRail> {
    RAILS.iter().find(|r| r.id == id)
}

/// Validate a US payment pointer for the given rail.
pub fn validate_pointer(rail: &str, pointer: &str) -> Result<(), String> {
    let raw = pointer.trim();
    if raw.is_empty() {
        return Err("pointer is empty".into());
    }
    match rail {
        "cashapp_pointer" => {
            let tag = raw.strip_prefix('$').unwrap_or(raw);
            let ok = tag.len() >= 1
                && tag.len() <= 20
                && tag
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
                && tag
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_alphabetic())
                    .unwrap_or(false);
            if ok {
                Ok(())
            } else {
                Err("Cash App cashtag: 1-20 alphanumeric characters, must start with a letter (optionally prefixed with $)".into())
            }
        }
        "venmo_handle" => {
            let handle = raw.strip_prefix('@').unwrap_or(raw);
            let ok = (1..=30).contains(&handle.len())
                && handle
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
            if ok {
                Ok(())
            } else {
                Err("Venmo handle: 1-30 characters (letters, digits, . _ -), optionally prefixed with @".into())
            }
        }
        "zelle_pointer" => {
            let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
            if raw.contains('@') && raw.len() <= 254 && raw.contains('.') {
                return Ok(());
            }
            if digits.len() == 10 || (digits.len() == 11 && digits.starts_with('1')) {
                return Ok(());
            }
            Err("Zelle pointer must be an email address or a US phone number".into())
        }
        "ach_details" => {
            let parts: Vec<&str> = raw.split('/').map(|s| s.trim()).collect();
            if parts.len() != 2 {
                return Err("ACH details must be routing/account (9-digit routing, 4-17 digit account)".into());
            }
            let routing = parts[0];
            let account = parts[1];
            if routing.len() != 9 || !routing.bytes().all(|b| b.is_ascii_digit()) {
                return Err("ACH routing number must be 9 digits".into());
            }
            if !(4..=17).contains(&account.len()) || !account.bytes().all(|b| b.is_ascii_digit()) {
                return Err("ACH account number must be 4-17 digits".into());
            }
            Ok(())
        }
        other => Err(format!("unknown US rail: {other}")),
    }
}

/// Generate a WABI-XXXX reference code from an unambiguous alphabet
/// (no 0/O, 1/I, 8/B confusion).
///
/// Note: wabi-server owns the production generator (api/payments/intents.rs)
/// so all rails share one source; this crate keeps the implementation for
/// callers that want it without the server.
pub fn generate_reference_code() -> String {
    const ALPHABET: &[u8] = b"2345679ACDEFGHJKMNPQRSTUVWXYZ";
    let mut code = String::with_capacity(9);
    code.push_str("WABI-");
    for _ in 0..4 {
        let idx = (rand_byte() as usize) % ALPHABET.len();
        code.push(ALPHABET[idx] as char);
    }
    code
}

fn rand_byte() -> u8 {
    // Not a secret — the code is a reconciliation hint, so a time+pid mix
    // is plenty. Avoids pulling in a full RNG dependency for one int.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    ((nanos ^ std::process::id()) >> 3) as u8
}

/// Frontend presentation blob: pointer + reference code + disclosure.
pub fn presentation(
    rail: &str,
    pointer: &str,
    reference_code: &str,
    amount_minor: i64,
    currency: &str,
) -> Result<Value, String> {
    validate_pointer(rail, pointer)?;
    let info = rail_info(rail).ok_or_else(|| format!("unknown US rail: {rail}"))?;
    let amount = format!("{:.2}", amount_minor.max(0) as f64 / 100.0);
    Ok(json!({
        "mode": "app_switch",
        "pointer": pointer.trim(),
        "pointerLabel": info.label,
        "referenceCode": reference_code,
        "disclosure": info.disclosure,
        "amountMinor": amount_minor,
        "currency": currency.to_ascii_uppercase(),
        "note": format!(
            "Pay {} {} to the pointer above and include the reference code {} as the memo. The seller confirms manually.",
            amount,
            currency.to_ascii_uppercase(),
            reference_code
        ),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cashtag_shapes() {
        assert!(validate_pointer("cashapp_pointer", "$Sakimichan").is_ok());
        assert!(validate_pointer("cashapp_pointer", "Sakimichan").is_ok());
        assert!(validate_pointer("cashapp_pointer", "$1Sakimichan").is_err()); // must start with letter
        assert!(validate_pointer("cashapp_pointer", "$sa ki").is_err());
        assert!(validate_pointer("cashapp_pointer", "").is_err());
    }

    #[test]
    fn venmo_handle_shapes() {
        assert!(validate_pointer("venmo_handle", "@mika.prints").is_ok());
        assert!(validate_pointer("venmo_handle", "mika-prints").is_ok());
        assert!(validate_pointer("venmo_handle", "@a very long handle over thirty characters 123456789012345678901234567890").is_err());
        assert!(validate_pointer("venmo_handle", "@").is_err());
    }

    #[test]
    fn zelle_shapes() {
        assert!(validate_pointer("zelle_pointer", "mika@example.com").is_ok());
        assert!(validate_pointer("zelle_pointer", "4155552671").is_ok());
        assert!(validate_pointer("zelle_pointer", "14155552671").is_ok());
        assert!(validate_pointer("zelle_pointer", "mika_at_example_dot_com").is_err());
        assert!(validate_pointer("zelle_pointer", "123").is_err());
    }

    #[test]
    fn ach_shapes() {
        assert!(validate_pointer("ach_details", "021000021/123456789").is_ok());
        assert!(validate_pointer("ach_details", "02100002/123456789").is_err()); // 8-digit routing
        assert!(validate_pointer("ach_details", "021000021/1234").is_ok());
        assert!(validate_pointer("ach_details", "021000021/123").is_err()); // 3-digit account
        assert!(validate_pointer("ach_details", "021000021").is_err()); // missing account
    }

    #[test]
    fn reference_code_format() {
        let code = generate_reference_code();
        assert_eq!(code.len(), 9);
        assert!(code.starts_with("WABI-"));
        for c in code[5..].chars() {
            assert!(!matches!(c, '0' | 'O' | '1' | 'I'), "ambiguous char {c} in {code}");
        }
        // Two draws differ with overwhelming likelihood.
        let other = generate_reference_code();
        let mut codes = std::collections::HashSet::new();
        for _ in 0..100 {
            codes.insert(generate_reference_code());
        }
        assert!(codes.len() > 90, "reference codes should be varied");
        assert_eq!(other.len(), 9);
    }

    #[test]
    fn presentation_has_disclosure_and_code() {
        let v = presentation(
            "zelle_pointer",
            "mika@example.com",
            "WABI-7F3K",
            2500,
            "USD",
        )
        .unwrap();
        assert_eq!(v["mode"], "app_switch");
        assert_eq!(v["pointer"], "mika@example.com");
        assert_eq!(v["referenceCode"], "WABI-7F3K");
        assert!(v["disclosure"].as_str().unwrap().contains("legal name"));
        assert_eq!(v["currency"], "USD");
    }

    #[test]
    fn unknown_rail_rejected() {
        assert!(validate_pointer("wero", "whatever").is_err());
        assert!(presentation("wero", "x", "WABI-AAAA", 1, "USD").is_err());
    }
}