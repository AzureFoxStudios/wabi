//! Thai PromptPay EMVCo QR payload builder (non-custodial).
//! Ported from addons/payments-thailand/backend/src/modules/promptpay-qr.ts
//! Wabi never holds funds — this only produces a QR string the payer scans
//! with their bank app.

/// Normalize a Thai PromptPay mobile, national/tax or e-wallet ID to EMV format.
pub fn normalize_promptpay_proxy_id(raw: &str) -> Option<String> {
    if !raw
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, ' ' | '-' | '(' | ')' | '+'))
    {
        return None;
    }
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

fn bounded_merchant_field(value: &str, max_bytes: usize) -> String {
    let mut result = value.to_uppercase();
    let mut end = max_bytes.min(result.len());
    while !result.is_char_boundary(end) {
        end -= 1;
    }
    result.truncate(end);
    result
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
    if p.amount_minor <= 0 || p.amount_minor > 99_999_999_999 {
        return Err("PromptPay amount must be between THB 0.01 and 999,999,999.99".into());
    }
    let normalized = normalize_promptpay_proxy_id(p.proxy_id)
        .ok_or_else(|| "invalid_promptpay_proxy_id".to_string())?;
    // BOT Thai QR Payment Standard section 2.3 assigns separate receiving
    // proxy namespaces: 01 mobile (13 normalized digits), 02 national/tax
    // (13 digits), and 03 e-wallet (15 digits). A wallet prefix resembling
    // a normalized mobile number must not change its receiving namespace.
    let proxy_tag = if normalized.len() == 15 {
        "03"
    } else if normalized.starts_with("0066") {
        "01"
    } else {
        "02"
    };
    let merchant_info = format!(
        "{}{}",
        tlv("00", "A000000677010111"),
        tlv(proxy_tag, &normalized)
    );

    let amount = format!("{}.{:02}", p.amount_minor / 100, p.amount_minor % 100);
    let mut payload = String::new();
    payload.push_str(&tlv("00", "01"));
    payload.push_str(&tlv("01", "12"));
    payload.push_str(&tlv("29", &merchant_info));
    payload.push_str(&tlv("53", "764"));
    payload.push_str(&tlv("54", &amount));
    payload.push_str(&tlv("58", "TH"));
    // Lengths are encoded as UTF-8 bytes. Bound the uppercase result at a
    // character boundary so multilingual names cannot overflow their field
    // or emit a three-digit TLV length. Actual bank charset acceptance remains
    // a separate interoperability check.
    let name = bounded_merchant_field(p.merchant_name, 25);
    let city = bounded_merchant_field(p.merchant_city, 15);
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
    fn qr_uses_the_standard_receiving_namespace_for_each_proxy() {
        for (proxy, expected) in [
            ("0812345678", "29370016A00000067701011101130066812345678"),
            ("0066812345678", "29370016A00000067701011101130066812345678"),
            ("1101400091234", "29370016A00000067701011102131101400091234"),
            (
                "123456789012345",
                "29390016A0000006770101110315123456789012345",
            ),
            (
                "006681234567890",
                "29390016A0000006770101110315006681234567890",
            ),
        ] {
            let payload = build_promptpay_qr_payload(PromptPayQrParams {
                proxy_id: proxy,
                amount_minor: 100,
                intent_id: "pi_proxy_contract",
                merchant_name: "Wabi",
                merchant_city: "Bangkok",
            })
            .unwrap();
            // Golden merchant-account blocks check the standard namespace,
            // the nested length, and the receiving identifier together.
            assert!(payload.contains(expected), "{proxy}: {payload}");
            let body = &payload[..payload.len() - 4];
            assert_eq!(&payload[payload.len() - 4..], crc16_ccitt(body));
        }
    }

    #[test]
    fn rejects_garbage() {
        assert!(normalize_promptpay_proxy_id("abc").is_none());
        assert!(normalize_promptpay_proxy_id("123").is_none());
        assert!(normalize_promptpay_proxy_id("pay0812345678").is_none());
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
        // The CRC tag 6304 + 2-byte CRC sit at the very end. Validate the
        // round-trip: the payload up to the last 4 chars must end in "6304"
        // and the trailing 4 chars must equal CRC16-CCITT of that body.
        let body = &payload[..payload.len() - 4];
        assert!(
            body.ends_with("6304"),
            "CRC tag 6304 must precede the checksum"
        );
        let expected_crc = crc16_ccitt(body);
        assert_eq!(&payload[payload.len() - 4..], expected_crc.as_str());
        // Amount block present and decodes to 100.00
        assert!(payload.contains("5406100.00"));
        assert!(payload.contains("5802TH"));
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

    #[test]
    fn qr_amount_is_exact_and_bounded() {
        let params = |amount_minor| PromptPayQrParams {
            proxy_id: "0812345678",
            amount_minor,
            intent_id: "pi_test",
            merchant_name: "Wabi",
            merchant_city: "Bangkok",
        };
        assert!(build_promptpay_qr_payload(params(1))
            .unwrap()
            .contains("54040.01"));
        assert!(build_promptpay_qr_payload(params(99_999_999_999))
            .unwrap()
            .contains("5412999999999.99"));
        for amount in [0, -1, 100_000_000_000, i64::MAX] {
            assert!(build_promptpay_qr_payload(params(amount)).is_err());
        }
    }

    #[test]
    fn multilingual_merchant_fields_remain_byte_bounded_and_valid_tlv() {
        fn field<'a>(payload: &'a str, expected_tag: &str) -> &'a str {
            let mut offset = 0;
            while offset < payload.len() {
                let tag = &payload[offset..offset + 2];
                let length: usize = payload[offset + 2..offset + 4].parse().unwrap();
                let value_start = offset + 4;
                let value_end = value_start + length;
                let value = &payload[value_start..value_end];
                if tag == expected_tag {
                    return value;
                }
                offset = value_end;
            }
            panic!("missing field {expected_tag}");
        }
        let cases: [(String, String, String, String); 4] = [
            (
                "😀".repeat(25),
                "กรุงเทพ".into(),
                "😀".repeat(6),
                "กรุงเ".into(),
            ),
            (
                "ร้านวาบิ".into(),
                "กรุงเทพ".into(),
                "ร้านวาบิ".into(),
                "กรุงเ".into(),
            ),
            (
                "ß".repeat(25),
                "straße".into(),
                "S".repeat(25),
                "STRASSE".into(),
            ),
            ("".into(), "".into(), "WABI".into(), "BANGKOK".into()),
        ];
        for (name, city, expected_name, expected_city) in cases {
            let payload = build_promptpay_qr_payload(PromptPayQrParams {
                proxy_id: "0812345678",
                amount_minor: 50000,
                intent_id: "piabc",
                merchant_name: &name,
                merchant_city: &city,
            })
            .unwrap();
            let name = field(&payload, "59");
            let city = field(&payload, "60");
            assert_eq!(name, expected_name);
            assert_eq!(city, expected_city);
            assert!(name.len() <= 25 && city.len() <= 15);
            assert_eq!(
                field(&payload, "63"),
                crc16_ccitt(&payload[..payload.len() - 4])
            );
        }
    }
}
