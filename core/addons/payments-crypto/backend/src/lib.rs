//! Wabi `payments-crypto` addon — non-custodial crypto payment pointers.
//!
//! Roadmap Phase 2 (docs/plans/2026-08-18-payments-p2p-audit-and-roadmap.md):
//! every modern receive standard is a static pointer string that fits
//! `PaymentAccountLink` exactly like a PromptPay ID. Wabi validates the
//! pointer and renders URIs/QRs; it never custodies funds.
//!
//! Chains (method ids):
//! - `usdc_base`   — USDC on Base (EIP-681 `ethereum:0x..@8453`)
//! - `usdc_solana` — USDC on Solana (`solana:..` with SPL mint param)
//! - `usdt_tron`   — USDT on TRON / TRC-20 (`tron:..`)
//! - `btc`         — BTC BIP21 (`bitcoin:addr?amount=..&label=..`)
//! - `lightning`   — LNURL-pay or BOLT 12 static offer (`lightning:..`)
//! - `monero`      — Monero (`monero:addr?tx_amount=..`)

use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Chain metadata
// ---------------------------------------------------------------------------

/// (decimals, public-ledger note, qr-hint)
pub struct ChainInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub decimals: u8,
    pub note: &'static str,
}

pub const CHAINS: &[ChainInfo] = &[
    ChainInfo {
        id: "usdc_base",
        label: "USDC (Base)",
        decimals: 6,
        note: "USDC on Base — pay from any wallet or exchange that supports Base.",
    },
    ChainInfo {
        id: "usdc_solana",
        label: "USDC (Solana)",
        decimals: 6,
        note: "USDC on Solana — Coinbase app onboarding is the easiest path.",
    },
    ChainInfo {
        id: "usdt_tron",
        label: "USDT (TRC-20)",
        decimals: 6,
        note: "USDT on TRON (TRC-20) — dominant among SEA buyers and sellers.",
    },
    ChainInfo {
        id: "btc",
        label: "Bitcoin (BIP21)",
        decimals: 8,
        note: "Bitcoin on-chain BIP21 URI — can be scanned by most Bitcoin wallets.",
    },
    ChainInfo {
        id: "lightning",
        label: "Lightning (LNURL / BOLT 12)",
        decimals: 8,
        note: "Lightning receive offer — BOLT 12 offers are static and reusable.",
    },
    ChainInfo {
        id: "monero",
        label: "Monero (XMR)",
        decimals: 12,
        note: "Monero is the privacy rail — the public ledger never sees amounts.",
    },
];

pub fn chain_info(id: &str) -> Option<&'static ChainInfo> {
    CHAINS.iter().find(|c| c.id == id)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn is_hex(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

const BASE58_ALPHABET: &[u8] =
    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn is_base58(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| BASE58_ALPHABET.contains(&b))
}

/// Validate a payment pointer for the given chain/method id.
pub fn validate_pointer(chain: &str, pointer: &str) -> Result<(), String> {
    let raw = pointer.trim();
    if raw.is_empty() {
        return Err("pointer is empty".into());
    }
    match chain {
        "usdc_base" => {
            let addr = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")).unwrap_or(raw);
            if addr.len() == 40 && is_hex(addr) {
                Ok(())
            } else {
                Err("Base address must be 0x + 40 hex characters".into())
            }
        }
        "usdc_solana" => {
            if (32..=44).contains(&raw.len()) && is_base58(raw) {
                Ok(())
            } else {
                Err("Solana address must be 32-44 base58 characters".into())
            }
        }
        "usdt_tron" => {
            if raw.len() == 34 && raw.starts_with('T') && is_base58(raw) {
                Ok(())
            } else {
                Err("TRON address must be a 34-char base58 address starting with T".into())
            }
        }
        "btc" => {
            let addr = raw.strip_prefix("bitcoin:").unwrap_or(raw);
            if addr.contains('?') {
                let addr = addr.split('?').next().unwrap_or("");
                return if validate_btc_address(addr) {
                    Ok(())
                } else {
                    Err("invalid Bitcoin address in BIP21 URI".into())
                };
            }
            if validate_btc_address(addr) {
                Ok(())
            } else {
                Err("Bitcoin address must be bech32 (bc1..), P2SH (3..) or legacy (1..)".into())
            }
        }
        "lightning" => {
            let payload = raw.strip_prefix("lightning:").unwrap_or(raw);
            if payload.starts_with("lnurl1") && payload.len() >= 20 {
                Ok(())
            } else if payload.starts_with("lno1") || payload.starts_with("lno2") {
                if payload.len() >= 20 {
                    Ok(())
                } else {
                    Err("BOLT 12 offer is too short".into())
                }
            } else if payload.starts_with("lnbc") && payload.len() >= 20 {
                Ok(())
            } else {
                Err("Lightning pointer must be an lnurl, BOLT 12 offer (lno..) or invoice (lnbc..)".into())
            }
        }
        "monero" => {
            let addr = raw.strip_prefix("monero:").unwrap_or(raw);
            let addr = addr.split('?').next().unwrap_or(addr);
            if (addr.len() == 95 || addr.len() == 106) && is_base58(addr) {
                Ok(())
            } else {
                Err("Monero address must be a 95-char (or 106-char integrated) base58 address".into())
            }
        }
        other => Err(format!("unknown chain: {other}")),
    }
}

fn validate_btc_address(addr: &str) -> bool {
    if addr.starts_with("bc1") {
        (42..=62).contains(&addr.len()) && is_bech32(&addr[3..])
    } else if addr.starts_with('1') {
        addr.len() >= 26 && addr.len() <= 35 && is_base58(addr)
    } else if addr.starts_with('3') {
        addr.len() >= 26 && addr.len() <= 35 && is_base58(addr)
    } else {
        false
    }
}

/// Minimal bech32 charset check (checksum not fully verified — the payer's
/// wallet does the final check; we only need a shape gate).
fn is_bech32(s: &str) -> bool {
    const CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    s.bytes().all(|b| CHARSET.contains(&b))
}

// ---------------------------------------------------------------------------
// URI / QR rendering
// ---------------------------------------------------------------------------

/// Minor units (6/8/12 decimals per chain) → display string without
/// trailing zeros (BIP21/Solana/Monero URI amounts are plain decimals).
fn minor_to_amount(minor: i64, decimals: u8) -> String {
    let divisor = 10u64.pow(decimals as u32);
    let whole = minor / divisor as i64;
    let frac = minor % divisor as i64;
    if frac == 0 {
        return whole.to_string();
    }
    let mut frac_str = format!("{:0width$}", frac, width = decimals as usize);
    while frac_str.ends_with('0') {
        frac_str.pop();
    }
    format!("{whole}.{frac_str}")
}

pub struct RenderParams<'a> {
    pub chain: &'a str,
    pub pointer: &'a str,
    pub amount_minor: i64,
    pub reference_code: &'a str,
    pub merchant_name: &'a str,
}

/// Build the QR payload (a wallet URI) for a chain + pointer + amount.
pub fn build_qr_payload(p: &RenderParams<'_>) -> Result<String, String> {
    validate_pointer(p.chain, p.pointer)?;
    let chain = chain_info(p.chain).ok_or_else(|| format!("unknown chain: {}", p.chain))?;
    let raw = p.pointer.trim();
    let amount = minor_to_amount(p.amount_minor.max(0), chain.decimals);
    let label = urlencode(p.merchant_name);
    match p.chain {
        "usdc_base" => {
            let addr = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")).unwrap_or(raw);
            Ok(format!("ethereum:0x{}@8453", addr.to_ascii_lowercase()))
        }
        "usdc_solana" => Ok(format!(
            "solana:{raw}?amount={amount}&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        )),
        "usdt_tron" => Ok(format!("tron:{raw}")),
        "btc" => Ok(format!("bitcoin:{raw}?amount={amount}&label={label}")),
        "lightning" => {
            let payload = raw.strip_prefix("lightning:").unwrap_or(raw);
            Ok(format!("lightning:{payload}"))
        }
        "monero" => {
            let addr = raw.strip_prefix("monero:").unwrap_or(raw);
            Ok(format!("monero:{addr}?tx_amount={amount}&recipient_name={label}"))
        }
        other => Err(format!("unknown chain: {other}")),
    }
}

/// Frontend presentation blob for the intent card: QR payload + copy block.
pub fn presentation(p: &RenderParams<'_>) -> Result<Value, String> {
    let qr_data = build_qr_payload(p)?;
    Ok(json!({
        "mode": "qr",
        "qrData": qr_data,
        "copyText": p.pointer.trim(),
        "chain": p.chain,
        "referenceCode": p.reference_code,
        "note": format!(
            "{} Public chains are transparent — this rail is for pointers and QR only, never custody. Include the reference code in the transfer memo where supported.",
            chain_info(p.chain).map(|c| c.note).unwrap_or("")
        ),
    }))
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_base_address() {
        let good = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
        assert!(validate_pointer("usdc_base", good).is_ok());
        assert!(validate_pointer("usdc_base", "0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
        assert!(validate_pointer("usdc_base", "0x1234").is_err());
    }

    #[test]
    fn validates_solana_and_tron() {
        assert!(validate_pointer(
            "usdc_solana",
            "So11111111111111111111111111111111111111112"
        )
        .is_ok());
        assert!(validate_pointer(
            "usdc_solana",
            "So1111111111111111111111111111111111111111!"
        )
        .is_err());
        assert!(validate_pointer(
            "usdt_tron",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
        )
        .is_ok());
        assert!(validate_pointer(
            "usdt_tron",
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6"
        )
        .is_err());
    }

    #[test]
    fn validates_btc_bip21() {
        assert!(validate_pointer(
            "btc",
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        )
        .is_ok());
        assert!(validate_pointer(
            "btc",
            "bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.01&label=Wabi"
        )
        .is_ok());
        assert!(validate_pointer("btc", "not-a-btc-address").is_err());
    }

    #[test]
    fn validates_lightning_and_monero() {
        assert!(validate_pointer(
            "lightning",
            "lnurl1dp68gurn8ghj7ampd3kx2ar0veekgerjqmkx7unv4hx7un9w3hxycn5v9n8x23k"
        )
        .is_ok());
        assert!(validate_pointer("lightning", "lno1pgq8ysxpar9q7hgz8dd0dq0rr3eqm4x3v").is_ok());
        assert!(validate_pointer("lightning", "bc1qgarbage").is_err());
        let xmr = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
        assert_eq!(xmr.len(), 95);
        assert!(validate_pointer("monero", xmr).is_ok());
        assert!(validate_pointer("monero", "short").is_err());
    }

    #[test]
    fn uri_building_is_chain_specific() {
        let p = RenderParams {
            chain: "usdc_base",
            pointer: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount_minor: 1_250_000, // 1.25 USDC
            reference_code: "WABI-7F3K",
            merchant_name: "Wabi",
        };
        assert_eq!(
            build_qr_payload(&p).unwrap(),
            "ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453"
        );

        let p = RenderParams {
            chain: "btc",
            pointer: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            amount_minor: 100_000, // 0.001 BTC
            reference_code: "WABI-7F3K",
            merchant_name: "Wabi",
        };
        let uri = build_qr_payload(&p).unwrap();
        assert!(uri.starts_with("bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.001&label="), "{uri}");

        let p = RenderParams {
            chain: "monero",
            pointer: "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A",
            amount_minor: 100_000_000_000, // 0.1 XMR
            reference_code: "WABI-7F3K",
            merchant_name: "Wabi",
        };
        assert!(build_qr_payload(&p).unwrap().starts_with("monero:44AFF"));
    }

    #[test]
    fn presentation_has_copy_block_and_note() {
        let p = RenderParams {
            chain: "usdc_solana",
            pointer: "So11111111111111111111111111111111111111112",
            amount_minor: 5_000_000,
            reference_code: "WABI-7F3K",
            merchant_name: "Wabi",
        };
        let v = presentation(&p).unwrap();
        assert_eq!(v["mode"], "qr");
        assert!(v["qrData"].as_str().unwrap().starts_with("solana:"));
        assert_eq!(v["copyText"], "So11111111111111111111111111111111111111112");
        assert!(v["note"].as_str().unwrap().contains("never custody"));
    }
}