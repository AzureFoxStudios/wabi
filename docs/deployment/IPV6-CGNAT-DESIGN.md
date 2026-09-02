# Wabi IPv6 / CGNAT Escape Hatch — Design Doc

## The Idea

Add a built-in network diagnostic to Wabi that tells the user exactly how reachable their server is, and suggests the right tier from the self-host guide automatically.

## What the Diagnostic Tells the User

```
[Run Network Check]

Your Wabi server is reachable via:

✅ LAN:          http://192.168.1.42:3000      (Same WiFi only)
✅ Tailscale:    http://100.104.166.42:3000    (Anywhere, encrypted)
⚠️  IPv6:         http://[2001:fb1:...]:3000    (May work — test me)
❌ IPv4 public:  Not available — CGNAT blocked

Recommendation: Share your Tailscale IP. Your friends install Tailscale,
enter 100.104.166.42:3000, and they're in. Zero config.
```

## How It Works (Backend)

The Wabi server probes itself from the outside:

```rust
// On server boot, fire off a few async checks:

// 1. Detect local IPs
// 2. Detect Tailscale IP (if tailscaled is running)
// 3. Detect IPv6 global address
// 4. STUN check: ask a public STUN server "what IP do you see me as?"
//    → If STUN returns a different IP than your LAN IP, you're behind NAT/CGNAT
// 5. IPv6 probe: try to connect to yourself from an external IPv6 checker
//    (or just report the address and let the user test)
// 6. Port reachability: can an external host actually reach :3000?

// Store results in server state, expose via /api/network-status
```

## How It Works (Frontend)

```typescript
// In the admin/settings panel, or even on first boot:

async function runNetworkDiagnostics() {
  const status = await fetch('/api/network-status').then(r => r.json());
  
  return {
    lan: { available: true, url: `http://${status.lanIp}:3000` },
    tailscale: { available: !!status.tailscaleIp, url: `http://${status.tailscaleIp}:3000` },
    ipv6: { available: !!status.ipv6, url: `http://[${status.ipv6}]:3000`, tested: status.ipv6Reachable },
    ipv4Public: { available: !status.behindNat, url: status.stunIp ? `http://${status.stunIp}:3000` : null },
    recommendation: status.tailscaleIp ? 'tailscale' : status.ipv6Reachable ? 'ipv6' : 'lan-only'
  };
}
```

## The IPv6 Test (Critical Detail)

We CANNOT truly test IPv6 reachability from the server itself. The server knows its own IP, but it doesn't know if the ISP firewall blocks inbound.

### Option A: External Service (Simple)

```
Server sends its IPv6 to a known test endpoint:
POST https://ipv6-test.wabi.chat/check
{ "address": "2001:fb1:169:e0be:d148:33d8:f184:719f", "port": 3000 }

The service tries to HTTP GET [that IPv6]:3000/health.
Response: { "reachable": true/false, "source": "external-probe" }
```

**Problem:** Now Wabi depends on an external service. Goes against self-host spirit.

### Option B: Friend-Assisted Test (No External Service)

```
User clicks [Test My IPv6].
Wabi generates a small JavaScript snippet:

  fetch("http://[2001:fb1:169:e0be:d148:33d8:f184:719f]:3000/health")
    .then(r => alert("IPv6 works! Your friends can reach you directly."))
    .catch(e => alert("IPv6 blocked. Use Tailscale."))

User sends this to a friend (or runs it on their phone with cell data).
Friend runs it. Result comes back.
```

**Problem:** Requires a second person. But this is actually realistic for Wabi (it's a chat app, the user HAS friends).

### Option C: Report Only, Don't Test

```
[Network Status]
LAN:       192.168.1.42:3000            ✅ Local only
Tailscale: 100.104.166.42:3000          ✅ Recommended
IPv6:      [2001:fb1:...]:3000           ⚠️ Available but not tested
           → Ask a friend to visit this URL, or open it on cell data

If it loads, your IPv6 is open. If not, your ISP blocks it.
```

This is the simplest and respects self-host philosophy. Just report what's known.

## Can a Cell Network Host Wabi? (Real Answer)

### IPv6 on Mobile

Your phone probably HAS an IPv6 address. Check:
```bash
# Android: 
adb shell ip -6 addr show rmnet_data0 | grep inet6

# iOS: Settings → Wi-Fi → (i) → scroll to IPv6 Address
```

But mobile carriers deploy IPv6 with **CLAT/PLAT** (464XLAT). What this means:
- Your phone gets an IPv6 address
- But it's behind carrier-grade NAT even for IPv6
- OR the carrier uses NAT64 to translate IPv6→IPv4
- The carrier almost certainly blocks ALL inbound connections on mobile data
- Some carriers even block outbound on non-standard ports

### Your Bazzite Machine Is on Cell Data?

If your `wlp3s0` interface is a tethered phone or mobile hotspot, then:
- The IPv6 I detected (`2001:fb1:169:e0be:...`) is from the mobile carrier
- Mobile carriers almost always block inbound IPv6
- Your data cap makes hosting impractical
- The IP changes every time you reconnect

**Conclusion: Cell data is NOT viable for hosting Wabi.** LAN or home broadband only.

### The Bigger Picture

| Network Type | IPv4 | IPv6 | Inbound Allowed? | Viable for Hosting? |
|-------------|------|------|------------------|-------------------|
| Home fiber / cable | CGNAT | ✅ Prefix delegated | Maybe (IPv6) | ✅ Yes, via IPv6 or Tailscale |
| Home DSL | CGNAT or real IP | Sometimes | If real IP: yes | ⚠️ Okay |
| Starlink | CGNAT | ✅ Real prefix | Likely (IPv6) | ✅ Yes, via IPv6 |
| Cell / mobile hotspot | CGNAT | CLAT/NAT64 | No | ❌ No, don't host on cell |
| Public WiFi | CGNAT or blocked | Rare | No | ❌ No |
| University / dorm | CGNAT | Sometimes | No (firewall) | ❌ No |

## Why Minecraft Works on Cell (But Wabi Doesn't)

**Minecraft LAN:** Same WiFi, broadcast discovery, no internet needed.

**Minecraft internet:** Someone runs a server on home broadband (or pays for Realms/VPS). You connect OUT to them. You don't need inbound.

**Minecraft + Tailscale:** Your friend on cell data joins the Tailscale tailnet, connects to your Tailscale IP. Their cell carrier only sees outbound WireGuard traffic. Works fine.

**Wabi is the same as Minecraft.** The SERVER needs to be on stable broadband. Clients can be on anything.

## The Real CGNAT Solutions (Ranked)

### 1. Tailscale (The Default)
- Server runs on home broadband
- Clients on cell, CGNAT, wifi, whatever — all join the tailnet
- Works because everyone makes outbound connections to Tailscale DERP
- Then peers find each other directly (or relay through Tailscale if P2P fails)
- Cost: $0. Effort: minimal.

### 2. IPv6 (If Broadband Has It)
- Server has real IPv6 prefix
- Check if ISP CPE blocks inbound
- If not blocked: literally zero config, zero cost, no middleman
- If blocked: falls back to Tailscale
- Cost: $0. Effort: check a URL.

### 3. One Friend Has a Real IP
- Tim in the US has Verizon Fios with real IPv4
- Iyoku in Philippines is on CGNAT
- Iyoku connects to Tim's server (or Tim runs the TURN relay)
- Wabi voice/video routes through Tim when direct P2P fails
- Cost: $0. Effort: ask Tim.

### 4. $3/mo VPS (The "Real Server" Fallback)
- Hetzner CX11, BuyVM, Contabo
- Real IPv4 + IPv6, data center network
- Run Wabi there, everyone connects to it
- Not self-hosted on YOUR home machine, but self-hosted in the sense that YOU control the server, not Discord
- Cost: $3/mo. Effort: one `docker-compose up`.

### 5. Cloudflare Tunnel (The Corporate Crutch)
- Outbound tunnel from your CGNAT home to Cloudflare
- Works but adds dependency and latency
- Rescue tool, not the default
- Cost: $0. Effort: low. Spirit: compromised.

## What Wabi Should Do About It

### 1. Add /api/network-status Endpoint

```rust
#[derive(Serialize)]
struct NetworkStatus {
    lan_ip: Option<String>,           // 192.168.x.x
    tailscale_ip: Option<String>,     // 100.x.x.x (if tailscaled running)
    ipv6_global: Option<String>,     // 2001:... (if available)
    stun_ip: Option<String>,          // What the internet sees (CGNAT detected if != lan)
    behind_nat: bool,                 // true if stun_ip != lan_ip
    ports: Vec<PortStatus>,           // What ports are reachable
}

#[derive(Serialize)]
struct PortStatus {
    port: u16,
    protocol: String,
    reachable: Option<bool>,          // Some we can test, some we can't
}
```

### 2. Add Frontend Network Panel

```svelte
<!-- In Settings or Server Admin -->
<NetworkStatusPanel />

Shows:
- "Your server is online at these addresses:"
- QR code for each URL (scan from phone)
- "Test my IPv6" button (generates test URL to send to friend)
- "Install Tailscale" button if behind CGNAT and no Tailscale detected
- "Copy Tailscale IP" button
- "Copy LAN IP" button
- Warning banner: "You appear to be behind CGNAT. Tailscale recommended."
```

### 3. Auto-Suggest on First Boot

```
[Welcome to Wabi]

We detected your network setup:
- LAN IP: 192.168.1.42
- Behind CGNAT: YES
- Tailscale: NOT DETECTED

To invite friends:
→ Install Tailscale on this machine and your friends' devices
→ Or host on a VPS with a real IP
→ Or ask a friend with a real IP to run the server

[Install Tailscale]  [I'll use a VPS]  [Skip for now]
```

### 4. Wabi Relay Network (Future)

If enough Wabi users have real IPs, build a volunteer relay network:

```
Alice (CGNAT) wants to call Bob (CGNAT)
No direct path exists.

Both Alice and Bob are connected to their respective Wabi nodes.
Iyoku (real IP) has opted in as a "relay volunteer" in Settings.

Alice's Wabi node asks the mesh: "who can relay?"
Iyoku's node responds: "I have a real IP, I can relay UDP"
Media flows: Alice → Iyoku → Bob

Iyoku's bandwidth is used, but they volunteered.
Reward: reputation, priority in the network.
```

This is how BitTorrent DHT works, how Tor works, how I2P works. The community IS the infrastructure.

## The Bottom Line

- **CGNAT is a business decision by ISPs to save IPv4 addresses.**
- **IPv6 fixes it completely but ISPs drag their feet.**
- **Tailscale works around it by making outbound connections instead of waiting for inbound.**
- **Cell networks are NOT for hosting. Period.** They are for clients.
- **The Wabi server should run on home broadband + Tailscale as the default.**
- **IPv6 is a bonus — check if it works, use it if it does, ignore it if blocked.**
- **Cloudflare is a last resort, not a default.**

**For the self-host guide, the hierarchy is correct:**
1. LAN (Tier 1)
2. Tailscale (Tier 2 — the real internet answer)
3. IPv6 (tier 2b, test it)
4. Cloudflare Tunnel (Tier 3 — rescue)
5. Port forward (Tier 4 — US/open NAT luxury)
6. VPS (Tier 5 — always works, costs money)

## Action Items

- [ ] Implement `/api/network-status` in wabi-server
- [ ] Add IPv6 detection to startup
- [ ] Detect Tailscale presence (check for `tailscaled` socket or `100.x.x.x` interface)
- [ ] Run STUN check to detect CGNAT
- [ ] Build NetworkStatusPanel.svelte
- [ ] Add auto-suggest on first boot
- [ ] Document the "no, you can't host on cell data" reality
