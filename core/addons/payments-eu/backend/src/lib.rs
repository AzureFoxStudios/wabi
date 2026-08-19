//! Wabi `payments-eu` addon — SEPA (Instant) via EPC QR code (EPC069-12 v3.1).
//!
//! Roadmap Phase 3 (docs/plans/2026-08-18-payments-p2p-audit-and-roadmap.md):
//! the EPC QR payload is an open multi-line text block any of 500+ EU
//! banking apps can scan — pure string generation, no PSP, no merchant
//! account, no KYC beyond the bank account the seller already has.
//!
//! Layout (EPC069-12 v3.1, "Quick Response Code – Guidelines to Enable the
//! Data Capture for the Initiation of a SEPA Credit Transfer", 19 Mar 2024):
//!   1  Service Tag        BCD
//!   2  Version            002 (EEA only; BIC optional)
//!   3  Character set      1 (UTF-8)
//!   4  Identification     SCT
//!   5  BIC                optional
//!   6  Name               1-70 chars
//!   7  IBAN               15-34 chars
//!   8  Amount             EUR#.## (0.01 .. 999999999.99, trailing zeros cut)
//!   9  Purpose            4 chars, optional
//!   10 Remittance (ref)   ≤35 chars, optional (ISO 11649)
//!   11 Remittance (text)  ≤140 chars, optional — XOR with line 10
//!   12 Information        ≤70 chars, optional (beneficiary→originator)
//!
//! Rules (per §2.2/§2.3 of the guideline): lines are LF-separated; unused
//! optional lines are emitted as empty lines so later fields stay in place;
//! *trailing* empty lines are trimmed; the last populated element is NOT
//! followed by any separator; payload ≤ 331 bytes.
//!
//! Note: EPC069-12 v3.1 defines NO checksum — earlier GiroCode variants
//! appended a CRC-16 line, but the current standard (and its official
//! examples, verified byte-for-byte against the V1/V2 annex vectors and the
//! segno/eupl reference implementations) does not.

use serde_json::{json, Value};

/// Validate an IBAN: 2 letters + digits, 15-34 chars, mod-97 check
/// (letters A=10 … Z=35, number moved to the end must be ≡ 1 mod 97).
pub fn validate_iban(raw: &str) -> Result<(), String> {
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if !(15..=34).contains(&compact.len()) {
        return Err("IBAN must be 15-34 characters".into());
    }
    if !compact.as_bytes()[0..2].iter().all(|b| b.is_ascii_alphabetic()) {
        return Err("IBAN must start with a 2-letter country code".into());
    }
    // BBAN is alphanumeric in many countries (FR, GB, …); the two chars
    // after the country code are always the mod-97 check digits.
    if !compact.as_bytes()[2..4].iter().all(|b| b.is_ascii_digit()) {
        return Err("IBAN check digits must be numeric".into());
    }
    if !compact.as_bytes()[4..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric())
    {
        return Err("IBAN contains invalid characters".into());
    }
    let rotated = format!("{}{}", &compact[4..], &compact[0..4]);
    let mut number = String::with_capacity(rotated.len() * 2);
    for c in rotated.chars() {
        match c {
            '0'..='9' => number.push(c),
            'A'..='Z' => number.push_str(&(c as u8 - b'A' + 10).to_string()),
            _ => unreachable!(),
        }
    }
    let mut remainder = 0u64;
    for chunk in number.as_bytes().chunks(7) {
        let part: String = chunk.iter().map(|b| *b as char).collect();
        remainder = (remainder * 10u64.pow(part.len() as u32)
            + part.parse::<u64>().unwrap_or(0))
            % 97;
    }
    if remainder != 1 {
        return Err("IBAN fails the mod-97 checksum".into());
    }
    Ok(())
}

/// BIC shape check: 8 or 11 alphanumeric (optional in the QR for EEA).
pub fn validate_bic(raw: &str) -> Result<(), String> {
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if (compact.len() == 8 || compact.len() == 11)
        && compact.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        Ok(())
    } else {
        Err("BIC must be 8 or 11 alphanumeric characters".into())
    }
}

/// Sanitize a single EPC field (strip CR/LF, truncate, optional uppercase).
fn clean_field(raw: &str, max: usize, uppercase: bool) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| *c != '\r' && *c != '\n')
        .take(max)
        .collect();
    if uppercase {
        cleaned.to_ascii_uppercase()
    } else {
        cleaned
    }
}

/// Format a minor-unit amount the EPC way: `EUR#.##` with trailing zeros
/// and a trailing dot removed ("EUR27", "EUR12.3", "EUR123.45", "EUR0.2").
fn format_eur_amount(amount_minor: i64) -> String {
    let euros = amount_minor / 100;
    let cents = amount_minor % 100;
    if cents == 0 {
        format!("EUR{euros}")
    } else {
        format!("EUR{euros}.{cents:02}").trim_end_matches('0').to_string()
    }
}

pub struct EpcQrParams<'a> {
    pub payee_name: &'a str,
    pub iban: &'a str,
    /// Optional 8/11-char BIC; banks derive it from the IBAN if absent.
    pub bic: Option<&'a str>,
    /// Amount in minor units (cents), 1 ..= 99_999_999_99.
    pub amount_minor: i64,
    /// SEPA purpose code (exactly 4 chars), optional.
    pub purpose: Option<&'a str>,
    /// Structured remittance (ISO 11649, ≤35 chars) — the WABI-XXXX code.
    pub reference: Option<&'a str>,
    /// Unstructured remittance (≤140 chars) — XOR with `reference`.
    pub text: Option<&'a str>,
    /// Beneficiary-to-originator information (≤70 chars), optional.
    pub info: Option<&'a str>,
}

/// Build the EPC QR payload string (no checksum — see module docs).
pub fn build_epc_qr_payload(p: &EpcQrParams<'_>) -> Result<String, String> {
    let name = p.payee_name.trim();
    if name.is_empty() || name.chars().count() > 70 {
        return Err("payee name is required, max 70 characters".into());
    }
    if p.amount_minor < 1 {
        return Err("amount must be at least EUR 0.01".into());
    }
    if p.amount_minor > 99_999_999_999 {
        return Err("amount exceeds EPC QR limit (EUR 999,999,999.99)".into());
    }
    if p.reference.is_some() && p.text.is_some() {
        return Err("structured reference and free text are mutually exclusive (EPC {Or} rule)".into());
    }
    let iban = validate_iban(p.iban).map(|_| {
        p.iban
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| c.to_ascii_uppercase())
            .collect::<String>()
    })?;
    let bic = match p.bic {
        Some(b) if !b.trim().is_empty() => {
            Some(validate_bic(b).map(|_| {
                b.chars()
                    .filter(|c| !c.is_whitespace())
                    .map(|c| c.to_ascii_uppercase())
                    .collect::<String>()
            })?)
        }
        _ => None,
    };
    if let Some(purpose) = p.purpose {
        let purpose = purpose.trim();
        if !(purpose.len() == 4 && purpose.bytes().all(|b| b.is_ascii_alphanumeric())) {
            return Err("purpose must be a 4-character SEPA code".into());
        }
    }
    if let Some(reference) = p.reference {
        let reference = reference.trim();
        if reference.is_empty() || reference.chars().count() > 35 {
            return Err("structured reference must be 1-35 characters".into());
        }
    }
    if let Some(text) = p.text {
        let text = text.trim();
        if text.is_empty() || text.chars().count() > 140 {
            return Err("remittance text must be 1-140 characters".into());
        }
    }
    if let Some(info) = p.info {
        if info.trim().chars().count() > 70 {
            return Err("information must be max 70 characters".into());
        }
    }

    let mut elements = vec![
        "BCD".to_string(),
        "002".to_string(),
        "1".to_string(), // UTF-8
        "SCT".to_string(),
        bic.unwrap_or_default(),
        clean_field(name, 70, false),
        iban,
        format_eur_amount(p.amount_minor),
        clean_field(p.purpose.map(str::trim).unwrap_or_default(), 4, true),
        clean_field(p.reference.map(str::trim).unwrap_or_default(), 35, false),
        clean_field(p.text.map(str::trim).unwrap_or_default(), 140, false),
    ];
    match p.info {
        Some(info) => {
            let info = info.trim();
            if !info.is_empty() {
                elements.push(clean_field(info, 70, false));
            }
        }
        None => {}
    }
    // Unused trailing lines are dropped (keep at least the 7 mandatory ones,
    // i.e. through the IBAN) — §2.2 "The last populated element is not
    // followed by any character or element separator".
    while elements.len() > 7 && elements.last().map(String::as_str) == Some("") {
        elements.pop();
    }

    let payload = elements.join("\n");
    if payload.len() > 331 {
        return Err("EPC payload exceeds the 331-byte limit".into());
    }
    Ok(payload)
}

/// Frontend presentation blob for the intent card.
pub fn presentation(p: &EpcQrParams<'_>, reference_code: &str) -> Result<Value, String> {
    let qr_data = build_epc_qr_payload(p)?;
    Ok(json!({
        "mode": "qr",
        "qrData": qr_data,
        "copyText": p.iban.trim(),
        "rail": "sepa-instant",
        "referenceCode": reference_code,
        "note": "SEPA (EPC QR-067 v3.1): any EU banking app scans this QR and the money lands in seconds. The payer's banking app shows your account name — this is a legal-name rail.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EPC069-12 v3.1 annex V2 example (version 002 — our EEA layout) with
    /// character set 1 (UTF-8) instead of the annex's minimal 2. BIC blank,
    /// purpose/reference blank, remittance text set, information blank.
    #[test]
    fn official_v2_example() {
        let qr = build_epc_qr_payload(&EpcQrParams {
            payee_name: "François D'Alsace S.A.",
            iban: "FR1420041010050500013M02606",
            bic: None,
            amount_minor: 1230,
            purpose: None,
            reference: None,
            text: Some("Client:Marie Louise La Lune"),
            info: None,
        })
        .unwrap();
        assert_eq!(
            qr,
            "BCD\n002\n1\nSCT\n\nFrançois D'Alsace S.A.\n\
             FR1420041010050500013M02606\nEUR12.3\n\n\nClient:Marie Louise La Lune"
        );
        assert_eq!(qr.split('\n').count(), 11);
    }

    /// EPC069-12 v3.1 annex V1 example (BIC mandatory, purpose GDDS,
    /// structured reference, name with umlaut) — identical to the official
    /// payload except the version line (001 → 002).
    #[test]
    fn official_v1_example_fields() {
        let qr = build_epc_qr_payload(&EpcQrParams {
            payee_name: "Franz Mustermänn",
            iban: "DE71110220330123456789",
            bic: Some("BHBLDEHHXXX"),
            amount_minor: 1230,
            purpose: Some("GDDS"),
            reference: Some("RF18539007547034"),
            text: None,
            info: None,
        })
        .unwrap();
        assert_eq!(
            qr,
            "BCD\n002\n1\nSCT\nBHBLDEHHXXX\nFranz Mustermänn\n\
             DE71110220330123456789\nEUR12.3\nGDDS\nRF18539007547034"
        );
        assert_eq!(qr.split('\n').count(), 10);
    }

    /// The German Wikipedia worked example (BIC present, remittance text).
    #[test]
    fn wikipedia_example() {
        let qr = build_epc_qr_payload(&EpcQrParams {
            payee_name: "Wikimedia Foerdergesellschaft",
            iban: "DE33100205000001194700",
            bic: Some("BFSWDE33BER"),
            amount_minor: 12345,
            purpose: None,
            reference: None,
            text: Some("Spende fuer Wikipedia"),
            info: None,
        })
        .unwrap();
        assert_eq!(
            qr,
            "BCD\n002\n1\nSCT\nBFSWDE33BER\nWikimedia Foerdergesellschaft\n\
             DE33100205000001194700\nEUR123.45\n\n\nSpende fuer Wikipedia"
        );
        assert_eq!(qr.split('\n').count(), 11);
    }

    #[test]
    fn amount_minimal_formatting() {
        assert_eq!(format_eur_amount(2700), "EUR27");
        assert_eq!(format_eur_amount(12345), "EUR123.45");
        assert_eq!(format_eur_amount(1230), "EUR12.3");
        assert_eq!(format_eur_amount(20), "EUR0.2");
        assert_eq!(format_eur_amount(99_999_999_999), "EUR999999999.99");
    }

    #[test]
    fn trailing_empty_lines_are_trimmed() {
        // Nothing optional set → the payload ends after the IBAN (7 lines).
        let qr = build_epc_qr_payload(&EpcQrParams {
            payee_name: "Mika's Print Studio",
            iban: "DE33100205000001194700",
            bic: None,
            amount_minor: 100,
            purpose: None,
            reference: None,
            text: None,
            info: None,
        })
        .unwrap();
        assert_eq!(
            qr,
            "BCD\n002\n1\nSCT\n\nMika's Print Studio\nDE33100205000001194700\nEUR1"
        );
        // Purpose set → ends at the purpose line, blanks stay in place.
        let qr = build_epc_qr_payload(&EpcQrParams {
            payee_name: "Mika's Print Studio",
            iban: "DE33100205000001194700",
            bic: None,
            amount_minor: 100,
            purpose: Some("GDDS"),
            reference: None,
            text: None,
            info: None,
        })
        .unwrap();
        assert_eq!(
            qr,
            "BCD\n002\n1\nSCT\n\nMika's Print Studio\nDE33100205000001194700\nEUR1\nGDDS"
        );
        // Reference set → info line stays trimmed off.
        let qr = build_epc_qr_payload(&EpcQrParams {
            payee_name: "Mika's Print Studio",
            iban: "DE33100205000001194700",
            bic: None,
            amount_minor: 100,
            purpose: None,
            reference: Some("WABI-7F3K"),
            text: None,
            info: None,
        })
        .unwrap();
        assert_eq!(
            qr,
            "BCD\n002\n1\nSCT\n\nMika's Print Studio\nDE33100205000001194700\nEUR1\n\nWABI-7F3K"
        );
    }

    #[test]
    fn valid_and_invalid_ibans() {
        assert!(validate_iban("DE33100205000001194700").is_ok());
        assert!(validate_iban("FR1420041010050500013M02606").is_ok());
        assert!(validate_iban("GB29NWBK60161331926819").is_ok());
        assert!(validate_iban("DE33100205000001194701").is_err()); // checksum off
        assert!(validate_iban("1234567890").is_err());
        assert!(validate_iban("").is_err());
    }

    #[test]
    fn bic_shape() {
        assert!(validate_bic("BFSLDEMMXXX").is_ok());
        assert!(validate_bic("bfsldemm").is_ok());
        assert!(validate_bic("BFSL").is_err());
        assert!(validate_bic("BFSLDEMMXX1!").is_err());
    }

    #[test]
    fn rejects_bad_input() {
        let base = EpcQrParams {
            payee_name: "X",
            iban: "DE33100205000001194700",
            bic: None,
            amount_minor: 100,
            purpose: None,
            reference: None,
            text: None,
            info: None,
        };
        assert!(build_epc_qr_payload(&base).is_ok());
        assert!(build_epc_qr_payload(&EpcQrParams { payee_name: "", ..base }).is_err());
        assert!(build_epc_qr_payload(&EpcQrParams { amount_minor: 0, ..base }).is_err());
        assert!(build_epc_qr_payload(&EpcQrParams { amount_minor: 100_000_000_000, ..base }).is_err());
        assert!(build_epc_qr_payload(&EpcQrParams {
            iban: "DE33100205000001194701",
            ..base
        })
        .is_err());
        assert!(build_epc_qr_payload(&EpcQrParams {
            bic: Some("BFSL"),
            ..base
        })
        .is_err());
        // EPC {Or}: structured reference and free text are mutually exclusive.
        assert!(build_epc_qr_payload(&EpcQrParams {
            reference: Some("WABI-7F3K"),
            text: Some("nope"),
            ..base
        })
        .is_err());
        assert!(build_epc_qr_payload(&EpcQrParams {
            purpose: Some("TOOLONG"),
            ..base
        })
        .is_err());
        // 331-byte payload limit.
        let long_name = "x".repeat(70);
        let long_text = "y".repeat(140);
        let long_info = "z".repeat(70);
        assert!(build_epc_qr_payload(&EpcQrParams {
            payee_name: &long_name,
            amount_minor: 999_999_999_99,
            text: Some(&long_text),
            info: Some(&long_info),
            ..base
        })
        .is_err());
    }
}