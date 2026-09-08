# Optional STUN/TURN for Wabi

Wabi's Socket.IO media relay uses the same reachable server connection as the
application. It does **not** require coturn or LiveKit. TURN is an additional
WebRTC/P2P path when direct connectivity cannot traverse NAT.

An HTTP tunnel can expose Wabi behind CGNAT, but does not make that host's TURN
listener and UDP relay ports publicly reachable. Keep `WABI_TURN_ENABLED=false`
until you have tested a reachable TURN endpoint. Do not advertise a private
address to public clients or treat the proxied app hostname as a TURN address.

## Runtime credentials, not frontend secrets

The server reads these settings at startup:

```dotenv
WABI_TURN_ENABLED=true
WABI_TURN_URI=turn:turn.example.com:3478
TURN_HMAC_KEY=<operator-generated shared secret>
TURN_EXTERNAL_IP=<reachable public IP literal>
TURN_REALM=turn.example.com
```

Generate the shared secret with `openssl rand -base64 32`. Keep it private and
shared with coturn. `WABI_TURN_SECRET` can override `TURN_HMAC_KEY` for Wabi's
issuer; it must match the actual coturn key. An explicitly empty override is an
error, not a fallback.

The URI accepts `host[:port]`, `turn:host[:port]` or `turns:host[:port]`, with
bracketed IPv6. Default ports are 3478 and 5349 respectively. Paths, embedded
credentials and query strings are rejected. Use `turns:` only with a working TLS
listener and trusted certificate.

Authenticated clients obtain expiring credentials from
`GET /api/media/turn-credentials`. Runtime endpoint changes need no frontend
rebuild. Browser cache and pending requests belong to the selected
server/account/session/relay. Non-TLS runtime TURN also supplies self-hosted
STUN. Google STUN remains opt-in.

Never put the HMAC secret in `VITE_*` values. Explicit legacy
`VITE_TURN_USERNAME`/`VITE_TURN_PASSWORD` compatibility remains, but these values
are public in compiled assets and are not the recommended deployment path.

## Optional coturn deployment

Root Compose passes `.env` to Wabi; select coturn explicitly:

```bash
docker compose --profile turn up -d coturn
```

Normal `docker compose up -d` does not select the profile. Apply server
environment changes using the normal stopped-writer/backup/recreate procedure,
including both WabiDB locks; see the
[update runbook](TIM_IYOKU_UPDATE_RUNBOOK.md). A container restart alone does not
reload Compose environment values. Preserve live data and custom mounts.

The entrypoint requires an explicit IP and nonempty scalar secret; it does not
guess a historical public IP. The generated private configuration uses
`use-auth-secret` and the HMAC key. A domain in `TURN_EXTERNAL_IP` is not an IP
literal. When that address changes, update the deployment and recreate coturn.

The template's UDP range, **49160–49200**, matches Docker's published relay
ports. TCP/UDP 3478 and the UDP relay range must be reachable through every
firewall/NAT/container layer. Allocation can succeed while media fails if those
layers disagree. This small range is not a large-public-service capacity claim.

## TLS is a separate gate

Publishing TCP/UDP 5349 does not create a TLS listener. To opt in, supply
certificates through the existing read-only `turn-server/certs` mount and set
coturn's `cert`, `pkey` and `tls-listening-port` directives. Give the container
UID read access without making the private key world-readable. Arrange renewal
through existing certificate management; no unrelated host package installation
is needed to validate Wabi.

Only after successful TLS negotiation and allocation, select
`WABI_TURN_URI=turns:turn.example.com:5349`. Wabi generates TCP TLS TURN URLs,
not unsupported `turns:?transport=udp` or plaintext STUN on a TLS port.
Application HTTPS and TURN TLS are independent listeners.

Review coturn resource limits and peer address policy before broad public
exposure. Issued credentials are bearer credentials: Wabi account revocation
prevents new issuance but does not invalidate an already-issued coturn
credential. The existing 24-hour lifetime remains because active peers do not
yet rotate their ICE credentials in place.

## Prove traffic, not merely startup

1. Verify Wabi readiness and authenticated credential issuance. Invalid
   authentication must be denied; disabled TURN must not issue credentials.
   Runtime media status describes configuration, not measured reachability.
2. From outside the server network, test STUN and authenticated allocation over
   the intended transport. Verify the returned IP and published relay range.
3. Force WebRTC to `iceTransportPolicy: 'relay'`, exchange media/data, and check
   the selected candidate pair and byte counters. A listed relay candidate alone
   is insufficient. An ordinary Wabi call may use its independent WebSocket
   relay, so it does not prove TURN.
4. Repeat with two real devices/networks where available. Test TLS separately.
   Never paste the HMAC secret into diagnostic pages or publish credentials.

The [Trickle ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
helps inspect candidate gathering, not bidirectional media.
The [upstream coturn configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
documents address mapping, authentication and relay ranges.

## CGNAT decision

If the listener times out and the operator confirms CGNAT without forwarding,
use the existing application relay. Do not advertise dead TURN, repeatedly
restart Wabi, weaken authentication or switch to host networking. A separately
reachable self-hosted TURN machine is an optional operator choice, not an
implicit paid/third-party dependency.

Tim's direct page, owner login and authenticated Socket.IO initialization were
verified on 2026-09-08 over SSH/Tailscale with external HTTP requests blocked in
the browser. The public tunnel stayed online. Wabi itself can bypass Cloudflare;
public visitors still need a reachable entry point. See the
[delivery record](../plans/2026-09-08-turn-runtime-delivery.md) for evidence and
limits, including what was not tested.
