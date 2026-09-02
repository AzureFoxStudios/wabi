# Self-hosting a DERP relay for Tailcat private access

**Why:** by default the private-access addon bootstraps (and falls back to) Tailscale's free
public DERP fleet — rate-limited, a handful of regions, no SLA, revocable. Direct UDP punching
usually succeeds home-to-home (the spike showed bootstrap→direct upgrade within one pong), but
when both NATs refuse, relayed traffic rides that free fleet. An operator who wants reliability
runs their own relay.

**What you need:** one reachable host (a tiny VPS is fine — relay traffic is only the fallback
path), TLS via your reverse proxy or derper's built-in certs, and a static JSON file.

## 1. Run derper

`derper` ships in the tailscale repo:

```bash
go install tailscale.com/cmd/derper@latest
# Behind your own TLS reverse proxy (recommended; Caddy example):
derper -a :8080 -http-port -1 -stun  # TLS terminated by the proxy at :443
# Or with built-in ACME (needs :443 and a DNS name):
derper -a :443 -hostname derp.example.com -certmode=letsencrypt
```

Keep STUN enabled (`-stun`, UDP 3478) — it's what makes direct punching work, which is the whole
point: DERP should stay the fallback, not the carrier.

## 2. Publish a DERP map JSON

Host this anywhere static (same VPS, object storage, anywhere HTTPS-reachable):

```json
{
  "Regions": {
    "900": {
      "RegionID": 900,
      "RegionCode": "home",
      "Nodes": [
        {
          "Name": "1",
          "RegionID": 900,
          "HostName": "derp.example.com",
          "IPv4": "203.0.113.10",
          "DERPPort": 443
        }
      ]
    }
  }
}
```

Region IDs below 900 are reserved for Tailscale's own regions; pick 900+ for custom ones.
Include both `HostName` and a literal `IPv4`/`IPv6` so clients don't depend on external DNS.

## 3. Point the addon at it

```bash
# wabi-server environment (bootstrap-level config, applies on listener start):
export WABI_TAILCAT_DERPMAP_URL="https://example.com/derpmap.json"
```

The manager passes it to the listener as `--derpmap-url=...` (flags-before-args order is a
tailcat CLI contract — see `.agents/skills/wabi-tailcat-access/`). Bounce with the admin
kill-switch + enable, or restart, to apply.

## Caveats

- Custom DERP maps replace the default map: your relay becomes the ONLY bootstrap. Run at least
  one node you trust, and consider listing a second region for redundancy.
- The member side (desktop client) uses the default map unless the address blob was minted with
  `--full-address` (self-contained DERP info). The addon's short-form addresses rely on the
  server-side map — that's another reason the operator's derper must stay up.
- Bandwidth on your derper is proportional to failed-punch traffic only; healthy setups stay
  direct after bootstrap.
