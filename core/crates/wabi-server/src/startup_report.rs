//! What `wabi-server` says on its own terminal.
//!
//! The log file keeps the full record. This module is for the person who just
//! typed the start command: a short block on stdout once the server is ready
//! (where to open it, where its data and log are, what to do first), and a
//! plain explanation on stderr when it cannot start.
//!
//! Nothing here may print a secret: no `jwt_secret`, no `root_key`, no token,
//! no credentials embedded in a URL.
//!
//! Std-only on purpose (plus `anyhow` and the WabiDB error type for
//! classification) so the wording is unit-testable without a running server.

use std::fmt::Write as _;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The install guide, named in every message that sends someone to read more.
pub const INSTALL_GUIDE: &str = "docs/deployment/INSTALL.md";
const RECOVERY_GUIDE: &str = "docs/deployment/BACKUP_AND_RECOVERY.md";

/// Set once the ready block has been printed, so a later failure is reported
/// as "stopped" rather than "could not start".
static READY: AtomicBool = AtomicBool::new(false);

/// Absolute form of `path` for display. Resolves symlinks when the path
/// exists; otherwise joins it to the current directory. Never fails: the
/// original text is the last resort.
pub fn display_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path)
        .or_else(|_| std::path::absolute(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

/// The file `tracing_appender::rolling::daily(dir, prefix)` writes to now.
/// It names files `<prefix>.<YYYY-MM-DD>` by the UTC date.
pub fn daily_log_file(log_dir: &Path, prefix: &str) -> PathBuf {
    display_path(log_dir).join(format!(
        "{prefix}.{}",
        chrono::Utc::now().format("%Y-%m-%d")
    ))
}

/// True inside a Docker or Podman container. There, the listener's own
/// address and port are usually not what the host's browser uses.
pub fn in_container() -> bool {
    Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists()
}

/// This machine's IPv4 address on its default route, if it has one.
///
/// Connecting a UDP socket only asks the kernel which local address it would
/// use to reach the target; no packet is sent. The target is in TEST-NET-1
/// (RFC 5737), reserved for documentation, so nothing could answer anyway.
pub fn lan_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() => {
            Some(ip)
        }
        _ => None,
    }
}

/// Where the network address facts come from, so tests can fix them.
#[derive(Clone, Debug)]
pub struct Network {
    pub bound: SocketAddr,
    pub lan: Option<Ipv4Addr>,
    pub container: bool,
}

impl Network {
    /// Look up the LAN address and container status for a real listener.
    pub fn detect(bound: SocketAddr) -> Self {
        let container = in_container();
        // A container's own address is a private bridge address that other
        // devices cannot reach; do not offer it.
        let lan = if bound.ip().is_unspecified() && !container {
            lan_ipv4()
        } else {
            None
        };
        Network {
            bound,
            lan,
            container,
        }
    }

    /// Lines for "Open in a browser", most useful first.
    fn browser_lines(&self) -> Vec<String> {
        let port = self.bound.port();
        let ip = self.bound.ip();
        if ip.is_unspecified() {
            if self.container {
                return vec![
                    format!("the host port mapped to {port} in this container"),
                    "(with the provided docker-compose.yml: http://localhost:3001)".to_string(),
                ];
            }
            let mut lines = vec![format!("http://localhost:{port}")];
            match self.lan {
                Some(lan) => lines.push(format!("http://{lan}:{port}  (from other devices)")),
                None => lines.push(format!("or this machine's address, port {port}")),
            }
            return lines;
        }
        vec![match ip {
            IpAddr::V6(v6) => format!("http://[{v6}]:{port}"),
            IpAddr::V4(v4) => format!("http://{v4}:{port}"),
        }]
    }
}

/// What kind of process is reporting.
pub enum Role<'a> {
    Authority {
        /// Absolute data directory.
        data_dir: &'a Path,
        /// No owner account exists yet.
        setup_required: bool,
        /// The setup capability is held by a desktop supervisor, so the first
        /// account is not simply "whoever registers first".
        desktop_managed: bool,
        /// The frontend was embedded in this build.
        web_app_included: bool,
    },
    Anchor {
        /// The Authority this Anchor forwards to (credentials removed).
        authority: &'a str,
    },
}

/// The block printed on stdout once the server accepts connections.
pub fn ready_block(network: &Network, role: &Role<'_>, log_file: &Path) -> String {
    const LABEL: usize = 20;
    let mut out = String::new();
    let row = |out: &mut String, label: &str, value: &str| {
        let _ = writeln!(out, "  {label:<LABEL$}{value}");
    };
    let title = match role {
        Role::Authority { .. } => "Wabi server is ready.",
        Role::Anchor { .. } => "Wabi Anchor (experimental) is ready.",
    };
    let _ = writeln!(out, "{title}");
    let mut browser = network.browser_lines().into_iter();
    if let Some(first) = browser.next() {
        row(&mut out, "Open in a browser:", &first);
        for line in browser {
            row(&mut out, "", &line);
        }
    }
    let container_note = if network.container {
        "  (inside the container)"
    } else {
        ""
    };
    match role {
        Role::Authority {
            data_dir,
            setup_required,
            desktop_managed,
            web_app_included,
        } => {
            row(
                &mut out,
                "Data directory:",
                &format!("{}{container_note}", data_dir.display()),
            );
            row(
                &mut out,
                "Log file:",
                &format!("{}{container_note}", log_file.display()),
            );
            if !web_app_included {
                row(
                    &mut out,
                    "Web app:",
                    &format!("not included in this build; see {INSTALL_GUIDE}"),
                );
            }
            if *setup_required && !desktop_managed {
                let _ = writeln!(
                    out,
                    "  No owner yet: the first account created becomes the owner."
                );
            }
        }
        Role::Anchor { authority } => {
            row(&mut out, "Authority:", authority);
            row(
                &mut out,
                "Log file:",
                &format!("{}{container_note}", log_file.display()),
            );
            let _ = writeln!(
                out,
                "  This Anchor keeps no community data; accounts and messages live on the Authority."
            );
        }
    }
    out
}

/// Print the ready block on stdout and remember that startup finished.
pub fn print_ready(block: &str) {
    use std::io::Write;
    READY.store(true, Ordering::SeqCst);
    let mut stdout = io::stdout().lock();
    // A closed stdout (e.g. a supervisor that stopped reading) must not stop
    // the server; the log file has the same facts.
    let _ = stdout.write_all(block.as_bytes());
    let _ = stdout.flush();
}

/// An Authority URL safe to print: no user, password, query or fragment.
pub fn printable_url(raw: &str) -> String {
    match reqwest::Url::parse(raw) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string().trim_end_matches('/').to_string()
        }
        Err(_) => "(the configured WABI_AUTHORITY_URL)".to_string(),
    }
}

/// Context attached to the listener bind so a bind failure is recognised as
/// one (a permission error on a port and on a file read differently).
#[derive(Debug)]
pub struct ListenFailed;

impl std::fmt::Display for ListenFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("could not open the network port")
    }
}

/// Context attached to every step that opens or creates the data directory
/// (fence check, JWT secret, directories, WabiDB), so any failure there is
/// explained as a data problem whatever its underlying type.
#[derive(Debug)]
pub struct OpenDataFailed;

impl std::fmt::Display for OpenDataFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("could not open the data directory")
    }
}

/// What the fatal message may name.
pub struct FatalContext {
    pub host: String,
    pub port: u16,
    /// Absolute data directory; `None` for an Anchor, which owns none.
    pub data_dir: Option<PathBuf>,
    pub log_file: Option<PathBuf>,
}

fn io_kind(error: &anyhow::Error) -> Option<io::ErrorKind> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<io::Error>())
        .map(io::Error::kind)
}

fn wabidb_error(error: &anyhow::Error) -> Option<&wabidb::error::WabiError> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<wabidb::error::WabiError>())
}

/// One plain paragraph: what happened and what to do.
fn plain_reason(error: &anyhow::Error, context: &FatalContext) -> String {
    let FatalContext { host, port, .. } = context;
    let data_dir = context
        .data_dir
        .as_ref()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|| "the data directory".to_string());

    if error.downcast_ref::<ListenFailed>().is_some() {
        return match io_kind(error) {
            Some(io::ErrorKind::AddrInUse) => format!(
                "Port {port} is already in use on {host}. Another program, possibly another \
                 Wabi server, is listening there. Stop that program, or start this server on a \
                 free port, for example with --port {}.",
                port.saturating_add(1)
            ),
            Some(io::ErrorKind::PermissionDenied) => format!(
                "This user is not allowed to listen on port {port}. Ports below 1024 need \
                 administrator rights. Use a port such as 3000 instead, and put a reverse \
                 proxy in front if people must reach it on port 80 or 443."
            ),
            _ => format!(
                "Wabi could not listen on {host}:{port}. Check that the address belongs to this \
                 machine: use --host 0.0.0.0 to accept connections on all of its addresses, or \
                 --host 127.0.0.1 for this machine only."
            ),
        };
    }

    if matches!(
        wabidb_error(error),
        Some(wabidb::error::WabiError::AlreadyRunning)
    ) {
        return format!(
            "Another Wabi server is already using the data directory {data_dir}. Its database \
             lock (wabidb/.lock inside that directory) is held by a running process, and only \
             one server may use a data directory at a time. Stop the other server first (Ctrl+C \
             in its terminal, or `docker compose stop` for a container), then start this one \
             again, or give this one a different --data-dir. Do not delete the .lock file: it is \
             how Wabi keeps two servers from writing the same data."
        );
    }

    if io_kind(error) == Some(io::ErrorKind::PermissionDenied) {
        return format!(
            "Wabi is not allowed to read or write files in its data directory {data_dir}. Start \
             the server as the user that owns that directory, or give this user access to it. \
             Do not delete files inside it to get past this."
        );
    }

    if error.downcast_ref::<OpenDataFailed>().is_some() || wabidb_error(error).is_some() {
        return format!(
            "Wabi could not open its data directory {data_dir}. The details below say what it \
             found. Do not delete files inside that directory to get past this: copy the whole \
             directory somewhere safe first, then follow {RECOVERY_GUIDE}."
        );
    }

    "The details below say what went wrong; the log file has more.".to_string()
}

/// The full stderr message for a fatal error: plain paragraph, then the
/// technical cause chain on one line (supervisors and tests match on it),
/// then where the log is.
pub fn fatal_message(error: &anyhow::Error, context: &FatalContext) -> String {
    let headline = if READY.load(Ordering::SeqCst) {
        "wabi-server stopped because of an error."
    } else {
        "wabi-server could not start."
    };
    let mut out = format!(
        "{headline}\n\n{}\n\nDetails: {error:#}\n",
        plain_reason(error, context)
    );
    if let Some(log) = &context.log_file {
        let _ = writeln!(out, "Log file: {}", log.display());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn network(bound: &str, lan: Option<&str>, container: bool) -> Network {
        Network {
            bound: bound.parse().unwrap(),
            lan: lan.map(|ip| ip.parse().unwrap()),
            container,
        }
    }

    fn authority(setup_required: bool, web_app_included: bool) -> Role<'static> {
        Role::Authority {
            data_dir: Path::new("/srv/wabi/data/wabi-server"),
            setup_required,
            desktop_managed: false,
            web_app_included,
        }
    }

    #[test]
    fn wildcard_bind_offers_localhost_and_the_lan_address() {
        let block = ready_block(
            &network("0.0.0.0:3000", Some("192.168.1.20"), false),
            &authority(true, true),
            Path::new("/srv/wabi/logs/wabi-server.log.2026-11-13"),
        );
        assert_eq!(
            block,
            "Wabi server is ready.\n\
             \x20 Open in a browser:  http://localhost:3000\n\
             \x20                     http://192.168.1.20:3000  (from other devices)\n\
             \x20 Data directory:     /srv/wabi/data/wabi-server\n\
             \x20 Log file:           /srv/wabi/logs/wabi-server.log.2026-11-13\n\
             \x20 No owner yet: the first account created becomes the owner.\n"
        );
    }

    #[test]
    fn wildcard_without_lan_says_this_machines_address() {
        let block = ready_block(
            &network("[::]:3000", None, false),
            &authority(false, true),
            Path::new("/l"),
        );
        assert!(block.contains("http://localhost:3000\n"));
        assert!(block.contains("or this machine's address, port 3000\n"));
        assert!(!block.contains("No owner yet"));
    }

    #[test]
    fn specific_bind_shows_exactly_that_address() {
        let v4 = ready_block(
            &network("127.0.0.1:4100", Some("10.0.0.2"), false),
            &authority(false, true),
            Path::new("/l"),
        );
        assert!(v4.contains("Open in a browser:  http://127.0.0.1:4100\n"));
        assert!(!v4.contains("10.0.0.2"));
        let v6 = ready_block(
            &network("[::1]:4100", None, false),
            &authority(false, true),
            Path::new("/l"),
        );
        assert!(v6.contains("http://[::1]:4100\n"));
    }

    #[test]
    fn container_does_not_claim_its_internal_port_or_address() {
        let block = ready_block(
            &network("0.0.0.0:3000", None, true),
            &authority(false, true),
            Path::new("/app/logs/x"),
        );
        assert!(block.contains("the host port mapped to 3000"));
        assert!(!block.contains("http://localhost:3000"));
        assert!(block.contains("/srv/wabi/data/wabi-server  (inside the container)"));
    }

    #[test]
    fn missing_web_app_is_said() {
        let block = ready_block(
            &network("127.0.0.1:1", None, false),
            &authority(false, false),
            Path::new("/l"),
        );
        assert!(block.contains(
            "Web app:            not included in this build; see docs/deployment/INSTALL.md\n"
        ));
    }

    #[test]
    fn desktop_managed_setup_does_not_promise_first_registrant_ownership() {
        let block = ready_block(
            &network("127.0.0.1:1", None, false),
            &Role::Authority {
                data_dir: Path::new("/d"),
                setup_required: true,
                desktop_managed: true,
                web_app_included: true,
            },
            Path::new("/l"),
        );
        assert!(!block.contains("No owner yet"));
    }

    #[test]
    fn anchor_names_its_authority_and_claims_no_data_directory() {
        let block = ready_block(
            &network("0.0.0.0:3000", None, false),
            &Role::Anchor {
                authority: "https://authority.example",
            },
            Path::new("/l"),
        );
        assert!(block.starts_with("Wabi Anchor (experimental) is ready.\n"));
        assert!(block.contains("Authority:          https://authority.example\n"));
        assert!(!block.contains("Data directory"));
        assert!(!block.contains("No owner yet"));
    }

    #[test]
    fn printable_url_drops_credentials_and_query() {
        assert_eq!(
            printable_url("https://user:hunter2@authority.example:8443/base/?token=abc#x"),
            "https://authority.example:8443/base"
        );
        assert_eq!(
            printable_url("not a url hunter2"),
            "(the configured WABI_AUTHORITY_URL)"
        );
    }

    fn context() -> FatalContext {
        FatalContext {
            host: "0.0.0.0".into(),
            port: 3000,
            data_dir: Some(PathBuf::from("/srv/wabi/data")),
            log_file: Some(PathBuf::from("/srv/wabi/logs/wabi-server.log.2026-11-13")),
        }
    }

    #[test]
    fn port_in_use_explains_itself() {
        let error = anyhow::Error::new(io::Error::new(io::ErrorKind::AddrInUse, "in use"))
            .context(ListenFailed);
        let message = fatal_message(&error, &context());
        assert!(message.starts_with("wabi-server could not start.\n\n"));
        assert!(message.contains("Port 3000 is already in use on 0.0.0.0"));
        assert!(message.contains("--port 3001"));
        assert!(message.contains("Details: could not open the network port: in use\n"));
        assert!(message.ends_with("Log file: /srv/wabi/logs/wabi-server.log.2026-11-13\n"));
    }

    #[test]
    fn lock_held_names_the_lock_and_never_suggests_removing_it() {
        let error = anyhow::Error::new(wabidb::error::WabiError::AlreadyRunning);
        let message = fatal_message(&error, &context());
        assert!(message.contains("already using the data directory /srv/wabi/data"));
        assert!(message.contains("wabidb/.lock"));
        assert!(message.contains("Do not delete the .lock file"));
        for advice in ["rm ", "remove the", "delete the lock", "unlink"] {
            assert!(!message.to_lowercase().contains(advice), "{advice}: {message}");
        }
    }

    #[test]
    fn data_permission_error_is_not_mistaken_for_a_port() {
        let error = anyhow::Error::new(io::Error::new(io::ErrorKind::PermissionDenied, "denied"));
        let message = fatal_message(&error, &context());
        assert!(message.contains("not allowed to read or write files in its data directory"));
        let error = anyhow::Error::new(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            .context(ListenFailed);
        assert!(fatal_message(&error, &context()).contains("not allowed to listen on port 3000"));
    }

    #[test]
    fn data_stage_failures_send_people_to_the_recovery_guide() {
        let error = anyhow::anyhow!("corrupt wabidb root key resolution").context(OpenDataFailed);
        let message = fatal_message(&error, &context());
        assert!(message.contains("could not open its data directory /srv/wabi/data"));
        assert!(message.contains("docs/deployment/BACKUP_AND_RECOVERY.md"));
        assert!(message.contains("Do not delete files"));
        assert!(message.contains(
            "Details: could not open the data directory: corrupt wabidb root key resolution\n"
        ));
    }

    #[test]
    fn unknown_errors_keep_their_detail() {
        let error = anyhow::anyhow!("Authority data directory is writer-fenced");
        let message = fatal_message(&error, &context());
        assert!(message.contains("Details: Authority data directory is writer-fenced\n"));
    }
}
