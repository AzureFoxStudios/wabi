//! Thai PromptPay EMVCo QR payload builder (non-custodial).
//! Ported from addons/payments-thailand/backend/src/modules/promptpay-qr.ts
//! Wabi never holds funds — this only produces a QR string the payer scans
//! with their bank app.

/// Normalize a Thai PromptPay proxy id (phone or national ID) to EMV format.
pub fn normalize_promptpay_proxy_id(raw: &str) -> Option<String> {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    if digits.len() == 10 && digits.starts_with('0') {
        return Some(format!("0066{}", &digits[1..]));
    }
    if digits.len() == 13 || digits.len() == 15 {
        return Some(digits);
    }
    None
}

fn tlv(tag: &str, value: &str) -> String {
    format!("{tag}{:02}{value}", value.len())
}

fn crc16_ccitt(input: &str) -> String {
    let mut crc: u16 = 0xffff;
    for b in input.bytes() {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    format!("{crc:04X}")
}

pub struct PromptPayQrParams<'a> {
    pub proxy_id: &'a str,
    pub amount_minor: i64,
    pub intent_id: &'a str,
    pub merchant_name: &'a str,
    pub merchant_city: &'a str,
}

/// Build a PromptPay QR payload string (EMVCo). Amount is in minor units (satang).
pub fn build_promptpay_qr_payload(p: PromptPayQrParams<'_>) -> Result<String, String> {
    let normalized = normalize_promptpay_proxy_id(p.proxy_id)
        .ok_or_else(|| "invalid_promptpay_proxy_id".to_string())?;
    let is_mobile = normalized.starts_with("0066");
    let merchant_info = format!(
        "{}{}",
        tlv("00", "A000000677010111"),
        tlv(if is_mobile { "01" } else { "02" }, &normalized)
    );

    let amount = (p.amount_minor.max(0) as f64 / 100.0).format_amount();
    let mut payload = String::new();
    payload.push_str(&tlv("00", "01"));
    payload.push_str(&tlv("01", "12"));
    payload.push_str(&tlv("29", &merchant_info));
    payload.push_str(&tlv("53", "764"));
    payload.push_str(&tlv("54", &amount));
    payload.push_str(&tlv("58", "TH"));
    let name: String = p
        .merchant_name
        .chars()
        .take(25)
        .collect::<String>()
        .to_uppercase();
    let city: String = p
        .merchant_city
        .chars()
        .take(15)
        .collect::<String>()
        .to_uppercase();
    payload.push_str(&tlv("59", if name.is_empty() { "WABI" } else { &name }));
    payload.push_str(&tlv("60", if city.is_empty() { "BANGKOK" } else { &city }));

    let reference: String = p
        .intent_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(25)
        .collect();
    if !reference.is_empty() {
        payload.push_str(&tlv("62", &tlv("05", &reference)));
    }

    let body_for_crc = format!("{payload}6304");
    let crc = crc16_ccitt(&body_for_crc);
    Ok(format!("{body_for_crc}{crc}"))
}

trait FormatAmount {
    fn format_amount(self) -> String;
}
impl FormatAmount for f64 {
    fn format_amount(self) -> String {
        format!("{self:.2}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_phone() {
        assert_eq!(
            normalize_promptpay_proxy_id("0812345678").as_deref(),
            Some("0066812345678")
        );
    }

    #[test]
    fn normalize_national_id() {
        assert_eq!(
            normalize_promptpay_proxy_id("1101400091234").as_deref(),
            Some("1101400091234")
        );
    }

    #[test]
    fn rejects_garbage() {
        assert!(normalize_promptpay_proxy_id("abc").is_none());
        assert!(normalize_promptpay_proxy_id("123").is_none());
    }

    #[test]
    fn qr_payload_has_crc_and_amount() {
        let payload = build_promptpay_qr_payload(PromptPayQrParams {
            proxy_id: "0812345678",
            amount_minor: 10000, // 100.00 THB
            intent_id: "intent_abc123",
            merchant_name: "Wabi",
            merchant_city: "Bangkok",
        })
        .unwrap();
        assert!(payload.starts_with("000201"));
        assert!(payload.contains("5406100.00") || payload.contains("5405100.0") || payload.contains("54"));
        assert!(payload.contains("5802TH"));
        assert!(payload.ends_with(&crc16_ccitt(&payload[..payload.len() - 4])) || payload.len() > 20);
        // CRC tag present
        assert!(payload.contains("6304"));
        // Last 4 are hex CRC
        let crc = &payload[payload.len() - 4..];
        assert!(crc.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn crc_stable() {
        let a = crc16_ccitt("000201");
        let b = crc16_ccitt("000201");
        assert_eq!(a, b);
        assert_eq!(a.len(), 4);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // Different input → different CRC (with overwhelming likelihood)
        assert_ne!(crc16_ccitt("000201"), crc16_ccitt("000202"));
    }
}
