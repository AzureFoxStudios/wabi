//! Server configuration

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerRole {
    Authority,
    Anchor,
}

#[allow(dead_code)]
impl ServerRole {
    pub fn from_env() -> Self {
        match std::env::var("WABI_SERVER_ROLE")
            .unwrap_or_else(|_| "authority".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "anchor" | "regional_anchor" => Self::Anchor,
            _ => Self::Authority,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Authority => "authority",
            Self::Anchor => "anchor",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: String,
    pub uploads_dir: String,
    pub jwt_secret: String,
    pub turn_enabled: bool,
    pub turn_uri: Option<String>,
    pub turn_secret: Option<String>,
    pub node_id: String,
    pub is_primary: bool,
    /// Runtime role. Authority owns WDB; anchor is a stateless regional proxy.
    pub server_role: ServerRole,
    /// Canonical authority URL when running as a regional anchor.
    pub authority_url: Option<String>,
    /// User IDs allowed to create/delete channels. Comma-separated in WABI_ADMIN_USER_IDS env var.
    pub admin_user_ids: Vec<i64>,
    /// Path to blacklist file (format: type|value|reason|expires_timestamp)
    pub blacklist_file: String,
    /// Maximum request body size in bytes (default: 50GB for self-hosted "adult choice")
    pub max_body_size: Option<usize>,
    /// Mesh coordination configuration
    pub mesh_enabled: bool,
    pub mesh_peers: Vec<String>,
    /// Lore addon configuration (version-controlled binary storage)
    #[serde(default)]
    pub lore: LoreAddonConfig,
}

/// An advertised ICE endpoint, shared by credential issuance and runtime status.
/// This is runtime configuration, not a persisted WabiDB record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnEndpoint {
    /// IPv6 addresses retain brackets for the browser's TURN/STUN URL builder.
    pub server: String,
    pub port: u16,
    pub use_turns: bool,
}

impl TurnEndpoint {
    pub fn parse(uri: &str) -> Result<Self, &'static str> {
        let uri = uri.trim();
        let lower = uri.to_ascii_lowercase();
        let (authority, use_turns) = if lower.starts_with("turns:") {
            (&uri[6..], true)
        } else if lower.starts_with("turn:") {
            (&uri[5..], false)
        } else {
            (uri, false)
        };
        let authority = authority.strip_prefix("//").unwrap_or(authority);
        const INVALID: &str = "WABI_TURN_URI must be a TURN host[:port] or turn[s]:host[:port], with bracketed IPv6 and no path, credentials or query";
        if authority.is_empty()
            || authority
                .chars()
                .any(|c| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '@' | '\\'))
        {
            return Err(INVALID);
        }
        let (server, port_text) = if let Some(ipv6) = authority.strip_prefix('[') {
            let (address, rest) = ipv6.split_once(']').ok_or(INVALID)?;
            let parsed: std::net::Ipv6Addr = address.parse().map_err(|_| INVALID)?;
            if parsed.is_unspecified() || parsed.is_multicast() {
                return Err(INVALID);
            }
            let port = if rest.is_empty() {
                None
            } else {
                Some(rest.strip_prefix(':').ok_or(INVALID)?)
            };
            (format!("[{parsed}]"), port)
        } else {
            let (host, port) = match authority.split_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            };
            let host = host.trim_end_matches('.');
            if host.is_empty()
                || host.len() > 253
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
            {
                return Err(INVALID);
            }
            if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
                let ip: std::net::Ipv4Addr = host.parse().map_err(|_| INVALID)?;
                if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
                    return Err(INVALID);
                }
            }
            (host.to_ascii_lowercase(), port)
        };
        let port = match port_text {
            Some(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => text
                .parse::<u16>()
                .ok()
                .filter(|port| *port != 0)
                .ok_or(INVALID)?,
            Some(_) => return Err(INVALID),
            None => {
                if use_turns {
                    5349
                } else {
                    3478
                }
            }
        };
        Ok(Self {
            server,
            port,
            use_turns,
        })
    }

    fn uri(&self) -> String {
        format!(
            "{}:{}:{}",
            if self.use_turns { "turns" } else { "turn" },
            self.server,
            self.port
        )
    }
}

/// No Debug derivation: this runtime setting contains the operator's HMAC key.
pub struct TurnStartupConfig {
    pub enabled: bool,
    pub uri: Option<String>,
    pub secret: Option<String>,
}

impl TurnStartupConfig {
    pub fn from_env() -> Result<Self, &'static str> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Result<Self, &'static str> {
        let enabled = match lookup("WABI_TURN_ENABLED")
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            None | Some("false" | "0") => false,
            Some("true" | "1") => true,
            Some(_) => return Err("WABI_TURN_ENABLED must be true or false"),
        };
        // Unselected infrastructure must not stop an otherwise valid server.
        if !enabled {
            return Ok(Self {
                enabled: false,
                uri: None,
                secret: None,
            });
        }
        let uri =
            lookup("WABI_TURN_URI").ok_or("WABI_TURN_URI is required when TURN is enabled")?;
        let endpoint = TurnEndpoint::parse(&uri)?;
        let secret = lookup("WABI_TURN_SECRET")
            .or_else(|| lookup("TURN_HMAC_KEY"))
            .filter(|secret| !secret.trim().is_empty())
            .ok_or("WABI_TURN_SECRET (or TURN_HMAC_KEY) is required when TURN is enabled")?;
        Ok(Self {
            enabled: true,
            uri: Some(endpoint.uri()),
            secret: Some(secret),
        })
    }
}

impl ServerConfig {
    pub fn turn_endpoint(&self) -> Result<Option<TurnEndpoint>, &'static str> {
        if !self.turn_enabled {
            return Ok(None);
        }
        if !self
            .turn_secret
            .as_ref()
            .is_some_and(|secret| !secret.trim().is_empty())
        {
            return Err("TURN secret not configured");
        }
        TurnEndpoint::parse(self.turn_uri.as_deref().ok_or("TURN URI not configured")?).map(Some)
    }
}

#[cfg(test)]
mod turn_tests {
    use super::*;

    fn settings(values: &[(&str, &str)]) -> Result<TurnStartupConfig, &'static str> {
        TurnStartupConfig::from_lookup(|key| {
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.to_string())
        })
    }

    #[test]
    fn disabled_turn_needs_no_dependencies_or_secrets() {
        for values in [
            vec![],
            vec![("WABI_TURN_ENABLED", "false"), ("WABI_TURN_URI", "broken")],
        ] {
            let config = settings(&values).unwrap();
            assert!(!config.enabled);
            assert!(config.uri.is_none() && config.secret.is_none());
        }
        assert!(settings(&[("WABI_TURN_ENABLED", "maybe")]).is_err());
    }

    #[test]
    fn enabled_turn_requires_valid_endpoint_and_explicit_nonempty_secret() {
        for values in [
            vec![("WABI_TURN_ENABLED", "true")],
            vec![
                ("WABI_TURN_ENABLED", "true"),
                ("WABI_TURN_URI", "turn.example"),
            ],
            vec![
                ("WABI_TURN_ENABLED", "true"),
                ("WABI_TURN_URI", "turn.example"),
                ("WABI_TURN_SECRET", " "),
            ],
            vec![
                ("WABI_TURN_ENABLED", "true"),
                ("WABI_TURN_URI", "https://secret-canary@host"),
                ("WABI_TURN_SECRET", "secret-canary"),
            ],
        ] {
            let error = settings(&values)
                .err()
                .expect("invalid configuration must fail startup");
            assert!(!error.contains("secret-canary"));
        }
    }

    #[test]
    fn canonical_secret_overrides_compose_compatibility_key_without_silent_fallback() {
        let base = [
            ("WABI_TURN_ENABLED", "true"),
            ("WABI_TURN_URI", "turn.example"),
            ("TURN_HMAC_KEY", "compatibility-test-secret"),
        ];
        let compat = settings(&base).unwrap();
        assert!(compat.enabled);
        assert_eq!(compat.uri.as_deref(), Some("turn:turn.example:3478"));
        assert_eq!(compat.secret.as_deref(), Some("compatibility-test-secret"));
        let mut canonical = base.to_vec();
        canonical.push(("WABI_TURN_SECRET", "canonical-test-secret"));
        assert_eq!(
            settings(&canonical).unwrap().secret.as_deref(),
            Some("canonical-test-secret")
        );
        canonical.pop();
        canonical.push(("WABI_TURN_SECRET", ""));
        assert!(
            settings(&canonical).is_err(),
            "explicit empty canonical secret is an operator error"
        );
    }

    #[test]
    fn endpoint_parser_preserves_transport_host_and_port_without_leaking_uri_fragments() {
        for (input, host, port, tls) in [
            ("turn.example", "turn.example", 3478, false),
            ("turn.example:4910", "turn.example", 4910, false),
            ("turn:TURN.example:3478", "turn.example", 3478, false),
            ("turn://192.0.2.5:3478", "192.0.2.5", 3478, false),
            ("turns:turn.example", "turn.example", 5349, true),
            ("turns://turn.example:443", "turn.example", 443, true),
            ("[2001:db8::5]:3478", "[2001:db8::5]", 3478, false),
            ("turns:[2001:db8::5]", "[2001:db8::5]", 5349, true),
        ] {
            assert_eq!(
                TurnEndpoint::parse(input).unwrap(),
                TurnEndpoint {
                    server: host.into(),
                    port,
                    use_turns: tls
                }
            );
        }
        for input in [
            "",
            "http://turn.example",
            "turn:",
            "turn:0.0.0.0",
            "turn:[::]",
            "turn:999.999.999.999",
            "turn:user:secret@host",
            "turn:host/path",
            "turn:host?transport=tcp",
            "turn:host#fragment",
            "host:",
            "host:0",
            "host:65536",
            "host:abc",
            "turn:host:123:456",
            "turn:2001:db8::5",
            "[broken]:3478",
            "[::1]extra",
            "white space",
            "-invalid.example",
        ] {
            assert!(
                TurnEndpoint::parse(input).is_err(),
                "accepted invalid endpoint {input}"
            );
        }
    }
}

/// Configuration for the optional Lore addon (version-controlled binary storage).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LoreAddonConfig {
    /// Whether the Lore addon is enabled at startup.
    pub enabled: bool,
    /// Operation mode: embedded, sidecar, or remote.
    pub mode: String,
    /// URL of the Lore server.
    pub server_url: String,
    /// Path to the Lore binary (CLI).
    pub binary_path: String,
    /// Data directory for embedded Lore server.
    pub data_dir: String,
    /// Maximum blob size in MB.
    pub default_blob_max_size_mb: u32,
    /// Auto-create a Lore repo when a channel is created with asset_storage: true.
    pub auto_create_repos: bool,
    /// Name of the Asset Storage channel that finished call recordings are
    /// uploaded to (created once by the operator). Optional; defaults to
    /// "Recordings".
    pub recordings_channel_name: Option<String>,
}

impl Default for LoreAddonConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "sidecar".into(),
            server_url: "lore://localhost:10000".into(),
            binary_path: "lore".into(),
            data_dir: "/var/wabi/lore".into(),
            default_blob_max_size_mb: 1024,
            auto_create_repos: true,
            recordings_channel_name: None,
        }
    }
}
