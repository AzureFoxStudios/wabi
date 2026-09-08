# Optional TURN/STUN service

Wabi's ordinary peer-to-peer calling can use this coturn service for ICE/NAT
traversal. The built-in WabiDB media relay is a separate authenticated Socket.IO
transport and does not require coturn or LiveKit. Do not enable LiveKit merely
to make ordinary P2P or WabiDB-relay calls work.

## Enable both ends

Starting the `turn` Compose profile only starts coturn. Wabi also needs:

```dotenv
WABI_TURN_ENABLED=true
WABI_TURN_URI=turn:turn.example.com:3478
TURN_EXTERNAL_IP=YOUR_CURRENT_PUBLIC_IP
TURN_REALM=turn.example.com
TURN_HMAC_KEY=YOUR_OPERATOR_GENERATED_SECRET
```

Generate a strong secret with `openssl rand -base64 32`; never publish it in
frontend `VITE_*` settings. Wabi accepts `TURN_HMAC_KEY` as the compatibility
fallback for `WABI_TURN_SECRET`. If explicitly set, `WABI_TURN_SECRET` must match
coturn's key; an empty canonical secret is an error, not a fallback. The server
defaults to TURN disabled and rejects incomplete/invalid **enabled** startup
configuration. The secret is never included in runtime responses.

Authenticated registered and guest clients obtain expiring HMAC credentials
from `/api/media/turn-credentials`. The existing 24-hour lifetime is preserved:
established peer connections do not yet rotate their initial ICE credentials.
`/api/media/runtime` reports configuration, not an external connectivity test.

## Network requirements

The template allocates only UDP ports **49160–49200**, matching Compose and
the Dockerfile. Forward this entire range plus **3478 UDP and TCP** from the
public interface/router to the Docker host. Docker port publication does not
create router forwarding. Make `TURN_EXTERNAL_IP` track the actual public IP;
an outdated value returns unusable relay candidates even when allocation works.
The selected coturn container requires an explicit IP (or same-family
`public/private` IP pair); there is no baked-in public-IP fallback. Invalid
values or line-breaking config injection fail before overwriting its config.

Keep control-port and relayed-data tests separate. A successful authenticated
allocation proves credentials and TURN signaling; it does not prove packets
reach the allocated external relay address. Verify actual relay-only media or
data between distinct network clients before claiming public TURN is ready.
Tailnet/LAN allocation alone is insufficient for public users.

TLS is **not** configured by this template. Published port 5349 alone does not
provide TURNS. To select `turns:host:5349`, first provide a matching certificate,
private key and coturn TLS configuration, then verify TLS reachability. IPv6
endpoints use brackets, for example `turn:[2001:db8::1]:3478`. URLs with paths,
userinfo or query options are rejected; Wabi chooses UDP/TCP ICE URLs itself.
