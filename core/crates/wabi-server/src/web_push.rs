//! Web Push delivery without a dedicated crate.
//!
//! Implements message encryption (RFC 8291 / RFC 8188 `aes128gcm`), VAPID
//! application-server identification (RFC 8292) and the RFC 8030 HTTP request.
//! It uses only primitives that are already part of this build (p256, hmac,
//! sha2, aes-gcm), so there is no extra HTTP/TLS stack to ship or audit.
//!
//! The same wire format is what UnifiedPush distributors accept, so one sender
//! serves both browser/PWA subscriptions and a future Android UnifiedPush client.
//!
//! Endpoints are user-supplied URLs, so every send goes through the shared
//! outbound-URL guard (`api::preview`): https only, public addresses only, and
//! the connection is pinned to the address that was validated.

use aes_gcm::{
    aead::{Aead, KeyInit as AeadKeyInit},
    Aes128Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, KeyInit, Mac};
use p256::{
    ecdh::diffie_hellman,
    ecdsa::{signature::Signer, Signature, SigningKey},
    PublicKey, SecretKey,
};
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// RFC 8291 section 4: a push service need not accept more than 4096 octets.
/// 86-octet header + 1 delimiter + 16-octet tag leaves 3993 plaintext octets.
pub const MAX_PLAINTEXT_BYTES: usize = 3993;
const RECORD_SIZE: u32 = 4096;
/// Voluntary-application-server-identification claims may not outlive 24h.
const VAPID_LIFETIME_SECS: u64 = 12 * 60 * 60;

#[derive(Debug, thiserror::Error)]
pub enum PushError {
    #[error("invalid subscription key: {0}")]
    BadKey(&'static str),
    #[error("payload too large ({0} bytes, max {MAX_PLAINTEXT_BYTES})")]
    PayloadTooLarge(usize),
    #[error("encryption failed")]
    Crypto,
}

fn decode_b64(value: &str) -> Option<Vec<u8>> {
    let normalized: String = value
        .trim()
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    URL_SAFE_NO_PAD.decode(normalized).ok()
}

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <HmacSha256 as KeyInit>::new_from_slice(key).expect("HMAC accepts any key length");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

/// Encrypt `payload` for one subscription with a random salt and a fresh
/// ephemeral key. Returns the complete `aes128gcm` request body.
pub fn encrypt(payload: &[u8], p256dh_b64: &str, auth_b64: &str) -> Result<Vec<u8>, PushError> {
    let ua_public = decode_b64(p256dh_b64)
        .and_then(|bytes| PublicKey::from_sec1_bytes(&bytes).ok())
        .ok_or(PushError::BadKey("p256dh is not a valid P-256 point"))?;
    let auth_secret = decode_b64(auth_b64)
        .filter(|bytes| bytes.len() == 16)
        .ok_or(PushError::BadKey("auth secret must be 16 bytes"))?;
    let as_secret = SecretKey::random(&mut OsRng);
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    encrypt_with(payload, &ua_public, &auth_secret, &as_secret, salt)
}

/// Deterministic core, split out so the RFC 8291 test vector can drive it.
fn encrypt_with(
    payload: &[u8],
    ua_public: &PublicKey,
    auth_secret: &[u8],
    as_secret: &SecretKey,
    salt: [u8; 16],
) -> Result<Vec<u8>, PushError> {
    if payload.len() > MAX_PLAINTEXT_BYTES {
        return Err(PushError::PayloadTooLarge(payload.len()));
    }
    let as_public = as_secret.public_key().to_sec1_bytes();
    let ua_public_bytes = ua_public.to_sec1_bytes();
    // `diffie_hellman` rejects the identity point; the public key was already
    // parsed as a valid curve point, which is the validation RFC 8291 requires.
    let shared = diffie_hellman(as_secret.to_nonzero_scalar(), ua_public.as_affine());

    // RFC 8291 3.4: combine the ECDH and authentication secrets.
    let prk_key = hmac(auth_secret, &[shared.raw_secret_bytes().as_slice()]);
    let ikm = hmac(
        &prk_key,
        &[b"WebPush: info\0", ua_public_bytes.as_ref(), as_public.as_ref(), &[1]],
    );
    // RFC 8188: derive the content-encryption key and nonce.
    let prk = hmac(&salt, &[&ikm]);
    let cek = hmac(&prk, &[b"Content-Encoding: aes128gcm\0", &[1]]);
    let nonce = hmac(&prk, &[b"Content-Encoding: nonce\0", &[1]]);

    let cipher = Aes128Gcm::new_from_slice(&cek[..16]).map_err(|_| PushError::Crypto)?;
    let mut record = Vec::with_capacity(payload.len() + 1);
    record.extend_from_slice(payload);
    record.push(0x02); // final-record padding delimiter
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce[..12]), record.as_slice())
        .map_err(|_| PushError::Crypto)?;

    let mut body = Vec::with_capacity(86 + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public.as_ref());
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

/// `Authorization` header value for one push-service origin (RFC 8292).
pub fn vapid_authorization(
    key: &SigningKey,
    public_key_b64: &str,
    audience: &str,
    subject: &str,
    now_secs: u64,
) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        serde_json::json!({
            "aud": audience,
            "exp": now_secs + VAPID_LIFETIME_SECS,
            "sub": subject,
        })
        .to_string(),
    );
    let signing_input = format!("{header}.{claims}");
    let signature: Signature = key.sign(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    format!("vapid t={signing_input}.{signature}, k={public_key_b64}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    /// Wakes a dozing device: incoming calls and direct messages.
    High,
    Normal,
}

impl Urgency {
    fn as_str(self) -> &'static str {
        match self {
            Urgency::High => "high",
            Urgency::Normal => "normal",
        }
    }
}

pub struct PushMessage<'a> {
    pub endpoint: &'a str,
    pub p256dh: &'a str,
    pub auth: &'a str,
    pub payload: &'a [u8],
    pub ttl_secs: u32,
    pub urgency: Urgency,
    /// Replaces an undelivered message with the same topic (RFC 8030 5.4).
    pub topic: Option<&'a str>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SendOutcome {
    Delivered,
    /// 404/410: the subscription no longer exists and should be forgotten.
    Gone,
    Failed(String),
}

/// A topic is at most 32 characters from the URL-safe base64 alphabet.
pub fn topic_for(label: &str) -> String {
    let digest = hmac(b"wabi-push-topic", &[label.as_bytes()]);
    URL_SAFE_NO_PAD.encode(&digest[..18]) // 24 characters
}

fn origin_of(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    })
}

pub async fn send(
    vapid_key: &SigningKey,
    vapid_public_b64: &str,
    vapid_subject: &str,
    message: &PushMessage<'_>,
) -> SendOutcome {
    let body = match encrypt(message.payload, message.p256dh, message.auth) {
        Ok(body) => body,
        Err(error) => return SendOutcome::Failed(error.to_string()),
    };
    let target = match crate::api::preview::validate_outbound_url(message.endpoint).await {
        Ok(target) => target,
        Err(_) => return SendOutcome::Failed("endpoint address not allowed".into()),
    };
    if target.url.scheme() != "https" {
        return SendOutcome::Failed("endpoint must use https".into());
    }
    let Some(audience) = origin_of(&target.url) else {
        return SendOutcome::Failed("endpoint has no origin".into());
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let authorization = vapid_authorization(vapid_key, vapid_public_b64, &audience, vapid_subject, now);
    let client = match crate::api::preview::pinned_client(&target, 10_000).and_then(|builder| {
        builder
            .build()
            .map_err(|_| crate::error::AppError::Internal("push client".into()))
    }) {
        Ok(client) => client,
        Err(_) => return SendOutcome::Failed("could not build push client".into()),
    };
    let mut request = client
        .post(target.url.clone())
        .header("Authorization", authorization)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", message.ttl_secs.to_string())
        .header("Urgency", message.urgency.as_str());
    if let Some(topic) = message.topic {
        request = request.header("Topic", topic);
    }
    match request.body(body).send().await {
        Ok(response) => match response.status().as_u16() {
            200..=299 => SendOutcome::Delivered,
            404 | 410 => SendOutcome::Gone,
            status => SendOutcome::Failed(format!("push service returned {status}")),
        },
        Err(error) => SendOutcome::Failed(format!("push request failed: {}", error.without_url())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    fn b64(value: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(value.replace(char::is_whitespace, "")).unwrap()
    }

    /// RFC 8291 section 5 / appendix A.
    #[test]
    fn matches_the_rfc_8291_example_byte_for_byte() {
        let ua_public = PublicKey::from_sec1_bytes(&b64(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        ))
        .unwrap();
        let as_secret =
            SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let plaintext = b"When I grow up, I want to be a watermelon";

        let body = encrypt_with(plaintext, &ua_public, &auth, &as_secret, salt).unwrap();

        let expected = b64(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml\
             mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT\
             pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        );
        // RFC 8291 says Content-Length: 145, but the actual base64 body is 144 bytes
        // (86 header + 41 plaintext + 1 delimiter + 16 tag). The RFC has a typo.
        assert_eq!(body.len(), 144);
        assert_eq!(body, expected);
    }

    /// The receiver side of the same example must recover the plaintext, so the
    /// test cannot pass by merely reproducing a wrong-but-stable ciphertext.
    #[test]
    fn the_receiver_can_decrypt_what_the_sender_produced() {
        let ua_secret = SecretKey::random(&mut OsRng);
        let ua_public_b64 = URL_SAFE_NO_PAD.encode(ua_secret.public_key().to_sec1_bytes());
        let auth = URL_SAFE_NO_PAD.encode([7u8; 16]);
        let body = encrypt(b"hello wabi", &ua_public_b64, &auth).unwrap();

        let salt = &body[..16];
        assert_eq!(&body[16..20], &RECORD_SIZE.to_be_bytes());
        assert_eq!(body[20], 65);
        let as_public = PublicKey::from_sec1_bytes(&body[21..86]).unwrap();
        let shared = diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let ua_public_bytes = ua_secret.public_key().to_sec1_bytes();
        let prk_key = hmac(&[7u8; 16], &[shared.raw_secret_bytes().as_slice()]);
        let ikm = hmac(&prk_key, &[b"WebPush: info\0", ua_public_bytes.as_ref(), &body[21..86], &[1]]);
        let prk = hmac(salt, &[&ikm]);
        let cek = hmac(&prk, &[b"Content-Encoding: aes128gcm\0", &[1]]);
        let nonce = hmac(&prk, &[b"Content-Encoding: nonce\0", &[1]]);
        let plain = Aes128Gcm::new_from_slice(&cek[..16])
            .unwrap()
            .decrypt(Nonce::from_slice(&nonce[..12]), &body[86..])
            .unwrap();
        assert_eq!(plain, b"hello wabi\x02");
    }

    #[test]
    fn each_message_uses_a_fresh_salt_and_key() {
        let secret = SecretKey::random(&mut OsRng);
        let public = URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes());
        let auth = URL_SAFE_NO_PAD.encode([1u8; 16]);
        let a = encrypt(b"same", &public, &auth).unwrap();
        let b = encrypt(b"same", &public, &auth).unwrap();
        assert_ne!(a[..16], b[..16], "salt reused");
        assert_ne!(a[21..86], b[21..86], "ephemeral key reused");
    }

    #[test]
    fn rejects_bad_keys_and_oversized_payloads() {
        let secret = SecretKey::random(&mut OsRng);
        let public = URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes());
        let auth = URL_SAFE_NO_PAD.encode([1u8; 16]);
        assert!(matches!(encrypt(b"x", "not-a-key", &auth), Err(PushError::BadKey(_))));
        assert!(matches!(encrypt(b"x", &public, "AAAA"), Err(PushError::BadKey(_))));
        // A well-formed length that is not a point on the curve.
        let off_curve = URL_SAFE_NO_PAD.encode([4u8; 65]);
        assert!(matches!(encrypt(b"x", &off_curve, &auth), Err(PushError::BadKey(_))));
        assert!(encrypt(&vec![0u8; MAX_PLAINTEXT_BYTES], &public, &auth).is_ok());
        assert!(matches!(
            encrypt(&vec![0u8; MAX_PLAINTEXT_BYTES + 1], &public, &auth),
            Err(PushError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn accepts_padded_and_standard_base64_from_other_clients() {
        let secret = SecretKey::random(&mut OsRng);
        let raw = secret.public_key().to_sec1_bytes();
        let standard = base64::engine::general_purpose::STANDARD.encode(&raw);
        let auth = base64::engine::general_purpose::STANDARD.encode([9u8; 16]);
        assert!(encrypt(b"x", &standard, &auth).is_ok());
    }

    #[test]
    fn vapid_header_is_a_valid_es256_jwt_for_the_origin() {
        let key = SigningKey::random(&mut OsRng);
        let public_b64 = URL_SAFE_NO_PAD.encode(key.verifying_key().to_encoded_point(false).as_bytes());
        let header = vapid_authorization(&key, &public_b64, "https://push.example", "mailto:ops@example.org", 1_000);
        let (token, k) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(k, public_b64);

        let mut parts = token.split('.');
        let (h, c, s) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
        assert_eq!(b64(h), br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims: serde_json::Value = serde_json::from_slice(&b64(c)).unwrap();
        assert_eq!(claims["aud"], "https://push.example");
        assert_eq!(claims["sub"], "mailto:ops@example.org");
        assert_eq!(claims["exp"], 1_000 + VAPID_LIFETIME_SECS);
        assert!(VAPID_LIFETIME_SECS <= 24 * 60 * 60);

        let signature = Signature::from_slice(&b64(s)).unwrap();
        VerifyingKey::from(&key)
            .verify(format!("{h}.{c}").as_bytes(), &signature)
            .expect("signature must verify against the advertised key");
    }

    #[test]
    fn topics_are_short_url_safe_and_stable() {
        let topic = topic_for("dm:channel-1");
        assert_eq!(topic, topic_for("dm:channel-1"));
        assert_ne!(topic, topic_for("dm:channel-2"));
        assert!(topic.len() <= 32);
        assert!(topic.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
