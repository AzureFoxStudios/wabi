# wabi.chat 502 diagnosis (origin-alive + edge-routing patterns)

Updated 2026-07-17 after a live dual-path failure (Tim public 200 while Ronin public 502).

Cloudflare browser page text often says **Bad gateway / Error code 502 / Host Error**. That is CF edge language — not proof the origin process is down.

## Hard rules

1. **Origin healthy ≠ public healthy.** Always separate Tim local health from public CF.
2. **Agent curl from one machine is not enough.** Prove from the *user’s* path (Ronin, Zen/Firefox) and from Tim. Paths can disagree.
3. **If `:3001` and `:8088` are 200 on Tim, do NOT scp a binary or restart `wabi-server` to “fix CF 502”.** Fix tunnel/edge first.
4. **Compose service names ≠ container names:**
   - services: `caddy-tunnel`, `cloudflared-named`, `cloudflared-named-2`
   - containers: `wabi-tunnel-caddy`, `wabi-cloudflared-named`, `wabi-cloudflared-named-2`
   - host config bind: `./Caddyfile.tunnel` → `/etc/caddy/Caddyfile`
5. Profiles: tunnel services need `--profile tunnel` and/or `--profile tunnel-named`.

## Decision table

| Public (user path) | Tim :3001 | Tim :8088 | Request appears in cloudflared logs? | Meaning | Fix priority |
|--------------------|-----------|-----------|--------------------------------------|---------|--------------|
| 502 Host Error | 200 | 200 | **No** (~4s, `server-timing: cfOrigin;dur≈4000`) | CF edge never reached a live connector for that client/colo path | Dual connectors / re-register tunnel; not origin |
| 502 | 200 | 200 | **Yes**, then origin error | Tunnel up; cloudflared→Caddy/server hop broken | Docker network, `caddy-tunnel:8088`, Caddyfile |
| 502 | fail | * | * | Origin down | Fix wabi-server / env / locks |
| 200 agent, 502 user browser | 200 | 200 | only agent IP | **Client-IP / path split** (this session’s main bug) | Dual connector + verify user path; optional SOCKS test |
| 200 | 200 | 200 | yes | Healthy | Stop |

## Diagnostic sequence

SSH: `tim@100.96.11.45`. Tailscale may need browser auth (`references/tailscale-ssh-auth.md`).

### A. Origin + Caddy on Tim

```bash
curl -sS -m 5 -o /dev/null -w "3001/health:%{http_code}\n" http://127.0.0.1:3001/health
curl -sS -m 5 -o /dev/null -w "8088/health:%{http_code}\n" http://127.0.0.1:8088/health
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker exec wabi-tunnel-caddy cat /etc/caddy/Caddyfile | head -80
```

Healthy Caddy: listen `:8088`, single `reverse_proxy wabi-server:3000`, no SPA try_files at Caddy (SPA fallback is **wabi-server** — unknown paths return index.html ~8317 bytes; ignore probe noise).

Docker-network probe (cloudflared image is distroless — no shell):

```bash
docker run --rm --network wabi_default curlimages/curl:8.5.0 -sS -m 5 -w "caddy:%{http_code}\n" http://caddy-tunnel:8088/health
docker run --rm --network wabi_default curlimages/curl:8.5.0 -sS -m 5 -w "server:%{http_code}\n" http://wabi-server:3000/health
```

### B. Public from multiple egresses (required)

```bash
# From Ronin (agent / user machine)
curl -sS -4 -o /dev/null -w "ronin:%{http_code} t=%{time_total}\n" --max-time 15 https://wabi.chat/
curl -sS -4 -D- -o /dev/null --max-time 15 https://wabi.chat/ | grep -iE 'HTTP/|cf-ray|server-timing'

# From Tim
ssh tim@100.96.11.45 'curl -sS -4 -o /dev/null -w "tim:%{http_code} t=%{time_total}\n" --max-time 15 https://wabi.chat/'
```

**Client-IP split test** (Ronin traffic via Tim egress):

```bash
ssh -f -N -D 127.0.0.1:18080 -o ExitOnForwardFailure=yes tim@100.96.11.45
curl -sS -4 --socks5-hostname 127.0.0.1:18080 -o /dev/null -w "via_tim:%{http_code}\n" --max-time 15 https://wabi.chat/
curl -sS -4 -o /dev/null -w "direct:%{http_code}\n" --max-time 15 https://wabi.chat/
# cleanup: pkill -f 'ssh -f -N -D 127.0.0.1:18080'
```

If `via_tim=200` and `direct=502` → tunnel/origin fine; CF routing broken for the direct client IP/colo path.

### C. Did the request hit the tunnel?

```bash
# Note your public IP first
curl -4 -sS --max-time 8 ifconfig.me; echo

# On Tim, after a failing public hit from that IP:
docker logs --since 2m wabi-cloudflared-named 2>&1 | grep -c 'YOUR.PUBLIC.IP'
docker logs --since 2m wabi-cloudflared-named-2 2>&1 | grep -c 'YOUR.PUBLIC.IP' || true
```

- **0 hits + public 502 + ~4s** → CF never handed traffic to a connector (edge routing / single-connector flakiness).
- **Hits + origin errors** → fix Caddy/server hop.

### D. Connector registration

```bash
docker logs --since 2m wabi-cloudflared-named 2>&1 | grep -iE 'Registered|Unregistered|protocol|Updated to|ERR '
ps -ef | grep '[c]loudflared'
```

Compare process start vs `docker ps` “Up N hours”. Mid-life process restart = re-registration event (can explain transient 502).

Remote ingress (token tunnel) looks like:

`service: http://caddy-tunnel:8088` for hostnames `wabi.chat` + `www.wabi.chat`.

### E. Real browser (Zen/Firefox path)

Curl ≠ browser. After network looks green:

- Prefer browser-harness / real load: login shell, `/_app/immutable/*` 200, socket.io handshake.
- User on Zen: hard refresh / private window / clear site data if SW cached a bad page.
- Bypass CF while debugging: `http://100.96.11.45:3001` (Tailscale).

## Fix priority (CF-layer, origin already 200)

### 1. Preferred durable fix (verified 2026-07-17)

**Two cloudflared connectors + QUIC** fixed Ronin-only 502 after single HTTP/2 connector left user path dead while Tim hairpin worked.

Compose (`tunnel` / `tunnel-named` profiles) should keep:

- `cloudflared-named` — `tunnel --no-autoupdate --protocol quic --loglevel info run --token ${CLOUDFLARE_TUNNEL_TOKEN:-}`
- `cloudflared-named-2` — same command, distinct `container_name`

```bash
cd ~/Desktop/Wabi
docker compose --profile tunnel --profile tunnel-named up -d caddy-tunnel cloudflared-named cloudflared-named-2
# verify BOTH registered
docker logs --since 1m wabi-cloudflared-named 2>&1 | grep Registered
docker logs --since 1m wabi-cloudflared-named-2 2>&1 | grep Registered
# prove USER path, not only Tim
```

Do not leave only one connector if you just saw client-IP split 502s.

### 2. Quick try (often incomplete alone)

```bash
docker restart wabi-cloudflared-named
# or both:
docker restart wabi-cloudflared-named wabi-cloudflared-named-2
```

Brief public blip. Re-check **user** path, not only Tim `curl`.

### 3. CF dashboard (agent cannot click)

- Zero Trust → Tunnels: hostnames → active tunnel UUID
- SSL/TLS: origin behind tunnel is plain HTTP → Flexible is normal; Full (Strict) can 502 if someone pointed CF at a non-TLS origin incorrectly (tunnel path usually edge-TLS only)
- Security / WAF events for the client IP if routing still IP-specific after dual connectors

### 4. Never first

- Redeploy wabi-server binary
- Rewrite Caddy for “SPA 8317” probe paths
- Treat STDB cutover as the default story when compose already shows WabiDB + healthy wabi-server

## SPA / probe noise (not the 502)

Unknown paths return SPA index (~8317 bytes, 200). Gambling/WordPress probes and rogue CF Workers (`Cf-Worker: …`) are background noise. Optional WAF block `/wp-admin` in dashboard only.

## Signals that fooled earlier sessions

| Signal | Wrong conclusion | Right reading |
|--------|------------------|---------------|
| Agent curl https://wabi.chat → 200 | “Site works for user” | Only *this* egress works; retest user IP / Zen |
| Tim curl public → 502 while logs clean | “Origin down” | Can be hairpin/path split; check local :3001 |
| All junk paths 200 len=8317 | “Caddy misconfig” | SPA fallback on wabi-server |
| cloudflared DBG 200 for some IPs | “Tunnel fine for everyone” | Grep for the failing client IP |
| Single `docker restart cloudflared` | “Always enough” | May need 2nd connector + quic |

## Bypass while CF is broken

- Local on Tim: `http://127.0.0.1:3001`
- Mesh: `http://100.96.11.45:3001`
- Do not claim product down if origin is up and only public CF is sick.

## Related

- `references/pre-deploy-live-stack-audit.md` — stack era before deploy
- `references/network-cgnat-and-cloudflare.md` — CF optional, calling, secure context
- `references/tailscale-ssh-auth.md` — SSH auth URL
