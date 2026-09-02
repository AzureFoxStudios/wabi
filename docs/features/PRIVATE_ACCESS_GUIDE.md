# Private Access Guide (Tailcat)

**Audience:** the operator who wants family and friends on their own Wabi server without port
forwarding, a domain, or a cloud tunnel. **Status:** live since 2026-09-02 (shipped in binary
`3f21da7f…`, deployed to Tim). Full design + engineering evidence:
`docs/plans/2026-09-01-tailcat-private-access.md`.

## What it is

One `tc…` code turns your server into a private club: members' desktop apps connect through an
encrypted WireGuard tunnel (built on [tailcat](https://github.com/tailscale/tailcat), v0.4.0).
No ports opened, nothing public, your home box gets *darker* not lighter. The tunnel is a door,
not a key — members still sign in with their Wabi account like always. Chat, live updates,
uploads, and relay calls all ride the tunnel automatically.

## Operator setup (one time, ~5 minutes)

1. **Install the tailcat binary on the server host** — v0.4.0 or newer on PATH, or point
   `WABI_TAILCAT_BINARY` at it. Download from the
   [releases page](https://github.com/tailscale/tailcat/releases).
2. Open **Admin → Runtime → Private access** and click **Turn on private access…**
   The confirm screen states exactly what opening the door means; there is no restart, ever.
3. Share the **connection code** (visible in the same panel) with your members over any channel
   you already trust — that's the point of "out of band".

Daily driving: turning it **off** is one click (instant kill-switch, zero ceremony), and the
audit list shows every change with who/when. Nothing here ever requires restarting wabi-server.

## Member setup (each desktop, once)

1. Open the desktop app → **Settings → Server → Private access**.
2. Click **Register this device** (optionally label it, e.g. "mom's laptop").
3. Click **Connect**. The app's server address switches to the tunnel automatically and switches
   back when you disconnect. Browsers keep using the normal address — tunnels are desktop-only.

## Good to know

- **Fallback path:** if both networks refuse a direct connection, traffic relays through
  Tailscale's free DERP fleet. Measured cross-network relay throughput: ~390 KB/s — plenty for
  chat and fine for occasional uploads. Reliability purists: self-host a relay
  (`PROJECT_DOCS/02-deployment/DERP_SELF_HOST_GUIDE.md`).
- **Keys are per-device.** An admin revokes a member's device in the same panel; only that
  device loses access.
- **Same-box extras (future):** the data model already supports exposing other services on the
  same machine (a Minecraft server on localhost:25565) through the same UI — deliberately not
  exposed yet, and reaching *into the LAN beyond the box* is a documented rejected direction.
- **Not for public communities:** big public instances keep domain + TLS. This feature is for
  the family/friends tier.
