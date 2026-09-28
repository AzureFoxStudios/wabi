//! Discover candidate LAN addresses using local interface metadata only.
//! An address is not a promise that another device can reach this computer.
use std::{collections::BTreeSet, net::IpAddr};

use if_addrs::Interface;

pub fn addresses(port: u16) -> Result<Vec<String>, String> {
    let interfaces = if_addrs::get_if_addrs().map_err(|error| {
        format!("Wabi could not read this computer's network addresses. Connect to Wi-Fi or Ethernet and try again. {error}")
    })?;
    format_addresses(interfaces, port)
}

fn format_addresses(interfaces: Vec<Interface>, port: u16) -> Result<Vec<String>, String> {
    if port == 0 {
        return Err("Start the community before finding its network address.".into());
    }
    let addresses: BTreeSet<_> = interfaces
        .into_iter()
        .filter(|interface| interface.is_oper_up() && !interface.is_p2p())
        .filter_map(|interface| match interface.ip() {
            // is_private is exactly RFC1918 for IPv4. Do not advertise public,
            // wildcard, loopback, link-local, CGNAT or IPv6 addresses as LAN.
            IpAddr::V4(address) if address.is_private() => Some(address),
            _ => None,
        })
        .collect();
    Ok(addresses
        .into_iter()
        .map(|address| format!("http://{address}:{port}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use if_addrs::{IfAddr, IfOperStatus, Ifv4Addr, Ifv6Addr};
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn interface(address: &str) -> Interface {
        let addr = match address.parse::<IpAddr>().unwrap() {
            IpAddr::V4(ip) => IfAddr::V4(Ifv4Addr {
                ip,
                netmask: Ipv4Addr::new(255, 255, 255, 0),
                prefixlen: 24,
                broadcast: None,
            }),
            IpAddr::V6(ip) => IfAddr::V6(Ifv6Addr {
                ip,
                netmask: Ipv6Addr::UNSPECIFIED,
                prefixlen: 64,
                broadcast: None,
            }),
        };
        Interface {
            name: "test-interface".into(),
            addr,
            index: Some(1),
            oper_status: IfOperStatus::Up,
            is_p2p: false,
            #[cfg(windows)]
            adapter_name: "test-adapter".into(),
        }
    }

    #[test]
    fn only_actual_private_ipv4_candidates_are_formatted_with_the_owned_port() {
        let input = [
            "127.0.0.1",
            "0.0.0.0",
            "8.8.8.8",
            "169.254.1.2",
            "100.64.1.2",
            "172.15.1.2",
            "172.32.1.2",
            "192.167.1.2",
            "192.169.1.2",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "fd00::1",
            "fe80::1",
            "10.1.2.3",
            "172.16.1.2",
            "172.31.1.2",
            "192.168.1.42",
        ];
        assert_eq!(
            format_addresses(input.into_iter().map(interface).collect(), 43127).unwrap(),
            [
                "http://10.1.2.3:43127",
                "http://172.16.1.2:43127",
                "http://172.31.1.2:43127",
                "http://192.168.1.42:43127",
            ]
        );
    }

    #[test]
    fn addresses_are_deduplicated_and_sorted_numerically() {
        assert_eq!(
            format_addresses(
                ["192.168.1.10", "192.168.1.2", "10.2.3.4", "192.168.1.2"]
                    .into_iter()
                    .map(interface)
                    .collect(),
                65535,
            )
            .unwrap(),
            [
                "http://10.2.3.4:65535",
                "http://192.168.1.2:65535",
                "http://192.168.1.10:65535"
            ]
        );
    }

    #[test]
    fn inactive_and_point_to_point_interfaces_are_not_lan_suggestions() {
        let mut inactive = interface("192.168.1.4");
        inactive.oper_status = IfOperStatus::Down;
        let mut point_to_point = interface("10.8.0.2");
        point_to_point.is_p2p = true;
        assert!(format_addresses(vec![inactive, point_to_point], 31337)
            .unwrap()
            .is_empty());
        assert!(format_addresses(vec![], 31337).unwrap().is_empty());
    }

    #[test]
    fn unbound_port_is_rejected() {
        assert!(format_addresses(vec![interface("192.168.1.4")], 0).is_err());
    }
}
