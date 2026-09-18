//! Shared bind policy for the Authority and Anchor.
//!
//! Keep this std-only so the actual socket contract can be tested on clean
//! Windows/Linux runners without building the complete application.
use std::io;
use std::net::TcpListener;

/// Bind exactly the configured host. Failure never widens the bind to a
/// wildcard, chooses another port or terminates the owner of an occupied port.
/// A zero port is allocated by the OS and stays reserved by this listener.
pub fn bind_configured(host: &str, port: u16) -> io::Result<TcpListener> {
    if host.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "host cannot be empty"));
    }
    let listener = TcpListener::bind((host, port)).map_err(|error| {
        io::Error::new(error.kind(), format!("cannot bind Wabi to {host}:{port}: {error}"))
    })?;
    // Required before conversion through tokio::net::TcpListener::from_std.
    listener.set_nonblocking(true)?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn loopback_is_not_silently_widened() {
        let listener = bind_configured("127.0.0.1", 0).unwrap();
        let address = listener.local_addr().unwrap();
        assert_eq!(address.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(address.port(), 0);
    }

    #[test]
    fn explicit_ipv6_loopback_is_preserved() {
        let listener = bind_configured("::1", 0).unwrap();
        assert_eq!(listener.local_addr().unwrap().ip(), IpAddr::V6(Ipv6Addr::LOCALHOST));
    }

    #[test]
    fn explicit_wildcard_remains_available_to_cli_operators() {
        let listener = bind_configured("0.0.0.0", 0).unwrap();
        assert_eq!(listener.local_addr().unwrap().ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }

    #[test]
    fn occupied_port_is_an_error_and_original_listener_survives() {
        let original = bind_configured("127.0.0.1", 0).unwrap();
        let address = original.local_addr().unwrap();
        let error = bind_configured("127.0.0.1", address.port()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        let connection = std::net::TcpStream::connect(address).unwrap();
        assert_eq!(connection.peer_addr().unwrap(), address);
        assert_eq!(original.local_addr().unwrap(), address);
    }

    #[test]
    fn empty_host_never_becomes_a_wildcard() {
        assert_eq!(bind_configured("", 0).unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn listener_is_nonblocking_for_tokio() {
        let listener = bind_configured("127.0.0.1", 0).unwrap();
        assert_eq!(listener.accept().unwrap_err().kind(), io::ErrorKind::WouldBlock);
    }
}
