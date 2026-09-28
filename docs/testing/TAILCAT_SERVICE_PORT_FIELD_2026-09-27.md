# Tailcat port and Wabi service-role field check — 2026-09-27

**Scope:** Two disposable cross-network probes with the pinned Tailcat v0.4.0 binary and main Wabi release build SHA-256 `d3e28fd3a42e7bded8c760e4560493043a39c0d6c2feb5c594096c6eb4aa4fad`. No firewall settings or existing RustDesk configuration were changed.

## Single-port Tailcat probe to RustDesk

Ronin had a running RustDesk process listening on TCP 21118. A disposable `tailcat serve` process on Ronin allowed one generated test device key and only port 21118. From iRonin, the Tailcat SOCKS client completed a TCP connection to `server.tailcat:21118` in 713 ms. A connection attempt to neighboring port 21119 returned SOCKS failure after about 5 seconds. This result tests Tailcat's device/port admission, not a Wabi account role.

A follow-up connected the stock RustDesk Linux client to `127.0.0.1:42118`, a disposable loopback TCP bridge into the same Tailcat SOCKS path and Ronin's TCP 21118 listener. RustDesk opened its Remote Desktop window and reached its password/approval prompt. The bridge observed RustDesk protocol bytes in both directions (473 client-to-host and 323 host-to-client bytes during the first 50-second attempt; 1,216 and 1,173 bytes during a second 217-second attempt). Both attempts reached RustDesk authentication. The operator did not have Ronin's RustDesk password, so a desktop image, input control and screen-data transfer remain unverified. The bridge used an isolated local RustDesk config directory and did not change either computer's saved RustDesk settings. The temporary listener, bridge, binary and test directories were removed after the check.

## Wabi role-gated TCP service through Tailcat

For the end-to-end Wabi permission check, a disposable Wabi Authority and a simple HTTP service both bound to loopback on iRonin. Its operator file exposed that one HTTP TCP endpoint as `http-probe`. A registered member's device key was allowed into Wabi's Tailcat pipe. A client process on Ronin connected through Tailcat and requested `/api/services/http-probe/connect` using that member's account token:

| Wabi service grant | Result |
|---|---|
| No grant | WebSocket handshake refused with HTTP 403 |
| `builtin:member` explicitly granted `http-probe` | WebSocket 101; 164 response bytes carried an HTTP 200 and the expected service body; 1,294 ms for this sample |
| Grant removed | New WebSocket handshake refused with HTTP 403 |

The test disabled the Tailcat listener at the end. `scripts/tailcat-service-field-smoke.mjs` reproduces this with a disposable Authority, endpoint file, member account and role changes. The HTTP service used an ephemeral `127.0.0.1` port; the service's TCP port was never opened on the LAN or Internet. The Wabi service gateway carried the TCP bytes inside an authenticated WebSocket over the existing Wabi Tailcat pipe.

These two probes answer different questions. Tailcat can restrict a direct port such as RustDesk's observed listener to an allowed device key, and the native RustDesk client can reach its authentication prompt through a disposable TCP bridge. Wabi can separately authorize a registered TCP endpoint by account role through its service gateway. The stock RustDesk client does not speak Wabi's authenticated WebSocket gateway, so combining RustDesk with Wabi roles still needs a client-side bridge or native integration. A direct RustDesk Tailcat port is not protected by a Wabi service role merely because both features exist.
