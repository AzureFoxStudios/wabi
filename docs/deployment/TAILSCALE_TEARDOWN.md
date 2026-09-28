# Tailscale Teardown — Tailcat Migration Brief

**Audience:** deploy workers (skills under `.agents/skills/wabi-deploy/`) operating on **tim** and other hosts.
**Status:** decision brief + checklist. Code change below is **not yet applied** — see §4.
**Date:** 2026-09-23

## 1. Decision

We are retiring Tailscale as our private-access layer. **Tailcat** (shipped, `core/addons/tailcat/`, upstream `tailscale/tailcat` v0.4.0) is the replacement: token-dialed WireGuard pipes, no tailnet, no coordination login, no `tailscale up`. Operator guide: `docs/features/PRIVATE_ACCESS_GUIDE.md`; design record: `docs/plans/2026-09-01-tailcat-private-access.md`.

Tearing down Tailscale must not break deploys, health checks, or private access. This document is the inventory of what actually depends on Tailscale and the order of operations.

## 2. What depends on Tailscale today

### 2.1 Product code — exactly one thing

| Location | What it does | Action |
|---|---|---|
| `core/crates/wabi-server/src/app_router.rs` — `is_safe_local_origin()` (≈L170–199) | CORS fallback when `WABI_CORS_ORIGINS` is unset: mirrors `localhost`, loopback, **and the whole `100.64.0.0/10` CGNAT range** so dev browsing via `http://100.x.x.x:3001` works without config | **Remove the CGNAT branch** (§4). This is the only Tailscale-shaped logic in `wabi-server`. |

Nothing else in the server binary, frontend, WabiDB, or Tailcat addon references Tailscale IPs, the Tailscale CLI, or a tailnet. Tailcat clients connect via hostname (e.g. `http://server.tailcat:<pipePort>`), which the CGNAT fallback never matched anyway — operators already need `WABI_CORS_ORIGINS` for Tailcat access.

### 2.2 Ops / scripts — hardcoded tailnet IPs

| Location | Hardcoded value | Action |
|---|---|---|
| `scripts/deploy-iyoku.sh` | `SERVER="100.104.166.42"` | Replace with hostname/Iyoku public address or Tailcat-reachable address |
| `scripts/deploy-iyoku-wabi.sh` | `SERVER="100.104.166.42"` | Same |
| `frontend/wabi-failover.spec.playwright.js` | `http://100.96.11.45:3000`, `ssh tim@100.96.11.45` (stop/start backend) | Parameterize host; test assumes Tailscale SSH |
| `.agents/skills/wabi-deploy/references/tim-update-runbook.md` | `ssh … tim@100.96.11.45` throughout | Rewrite reachability step (§5) |
| `.agents/skills/wabi-deploy/references/tailscale-ssh-auth.md` | Tailscale SSH checkpoint flow | Archive or rewrite post-teardown |
| `.agents/skills/wabi-deploy/references/pre-deploy-live-stack-audit.md` | greps `tim\|100.96` | Update host matching |
| `docs/TIM_IYOKU_UPDATE_RUNBOOK.md` | `scp … tim@100.96.11.45` | Same as tim runbook |

**Known addresses (for reference only — do not re-hardcode):**

| Host | Tailnet IP | Other reachability |
|---|---|---|
| tim (prod) | 100.96.11.45 | public socket observed `27.130.21.128` (plan doc §, punch-tested) |
| Iyoku (staging) | 100.104.166.42 | often unplugged; verify before relying |
| Ronin/bazzite | 100.87.255.66 | also RustDesk peer target (§6) |
| ironin (this machine) | 100.80.172.12 | — |

Hostname `tim` does **not** resolve — always use a literal address.

### 2.3 Docs that assume Tailscale is the Tier-2 answer

Update wording after teardown (point of fact, not blockers): `docs/deployment/SELF-HOST-GUIDE.md` (Tier 2 = Tailscale), `docs/deployment/DEPLOYMENT-SCALING-GUIDE.md`, `docs/NETWORKING.md`, `docs/deployment/IPV6-CGNAT-DESIGN.md` (Tailscale listed as escape hatch), `.agents/skills/wabi-deploy/SKILL.md` + `references/network-cgnat-and-cloudflare.md`. Preferred end-state wording: **Tailcat for private access; Cloudflare tunnel or public IP for open access.**

## 3. The DERP caveat (read before promising "zero Tailscale infrastructure")

Tailcat itself needs **no Tailscale account or tailnet**. But its NAT traversal uses DERP relays, and **the default derpmap points at Tailscale's free DERP fleet** (measured: Tokyo region 304, ~390 KB/s relayed; direct path after punch ~420 µs). Source: `docs/plans/2026-09-01-tailcat-private-access.md`, `docs/features/PRIVATE_ACCESS_GUIDE.md`.

Meaning:

- **Direct path wins when punch succeeds** (Tim's public socket punched within the 10s budget in spot-checks) — no third-party infra on the hot path.
- **When punch fails, traffic relays through Tailscale-operated DERP servers** unless we self-host.
- **Self-hosted derper is done and documented:** set `WABI_TAILCAT_DERPMAP_URL` → listener runs `--derpmap-url`. Guide: `docs/deployment/DERP_SELF_HOST_GUIDE.md`.

Honest claim for outsiders: *"no Tailscale account/tailnet; DERP relay used only as punch fallback — self-hostable via `WABI_TAILCAT_DERPMAP_URL`."* Do not claim full independence from Tailscale-operated infrastructure until a self-hosted derper is deployed and the derpmap verified.

## 4. Required code change (CORS tightening)

In `core/crates/wabi-server/src/app_router.rs`:

1. Delete the CGNAT branch inside `is_safe_local_origin` (the `a == 100 && b >= 64 && b <= 127` block and its comment).
2. Keep localhost / `127.0.0.1` / `::1` / `0.0.0.0` fallback only.
3. Update `cors_tests`:
   - remove/flip `accept_tailscale_cgnat` → assert rejection of `http://100.64.0.1`, `http://100.100.100.100:8080`;
   - keep `reject_external_origins`, `reject_1x_public_tailscale`, `reject_localhost_subdomain_attack`.
4. Update the `build_cors_layer` doc comment (≈L110–117): fallback is localhost-only; **any non-localhost origin (Tailcat hostnames, public domains, other LAN machines) requires `WABI_CORS_ORIGINS`.**
5. Run `cargo test -p wabi-server cors` (and workspace tests before merge).

This is a **tightening**, not a weakening — consistent with AGENTS.md (“do not weaken auth/permission checks”). No auth path, WebSocket admission, or rate-limit logic changes.

**Post-change operator requirement:** any client not served from localhost must have its origin listed in `WABI_CORS_ORIGINS` (comma-separated exact origins, e.g. `http://server.tailcat:8346,https://wabi.example.com`). Add this to the Tailcat enable steps in `PRIVATE_ACCESS_GUIDE.md` when the change lands.

## 5. Order of operations (for workers on tim)

Do these in order. Do not tear down Tailscale until step 4 passes.

1. **Land §4** on `main` (or the release branch): CORS tightening + tests green. Rebuild `wabi-server` (`STATIC_BUILD=1 bun run build` in `frontend/` first if the embed changed, then `cargo build --release -p wabi-server`).
2. **Prove Tailcat reachability while Tailscale still exists** (baseline):
   - on tim: `curl -fsS http://127.0.0.1:3001/health` (also `/livez`, `/readyz`);
   - enable Tailcat (admin API `/api/addons/tailcat/enable` or admin panel), from a second machine: `tailcat ping --until-direct <code>` → record whether path is `via DERP(...)` or direct;
   - browse the server **via the tailcat address** with `WABI_CORS_ORIGINS` set to that exact origin; confirm login + socket connect (no CORS console errors).
3. **Replace hardcoded `100.x` addresses** in §2.2 scripts/tests/runbooks with the chosen post-teardown address scheme. Decide now: SSH via tim's public IP, SSH via tailcat, or something else — and write it into the tim runbook **before** losing the tailnet path.
4. **Pre-teardown gate** (all must pass, record results):
   - [ ] `curl -fsS http://127.0.0.1:3001/health` on tim — 200;
   - [ ] Tailcat connect + `ping` from an external machine — works;
   - [ ] UI load through the Tailcat origin with `WABI_CORS_ORIGINS` — login OK, no CORS errors;
   - [ ] `scripts/local-dev-smoke.sh` (or the srt/relay/state-plane checks relevant to the deploy) — green;
   - [ ] New SSH/reachability path tested **while Tailscale is still up** (log in through it once);
   - [ ] RustDesk path decided (§6).
5. **Tear down Tailscale** on each host (`sudo tailscale down` first as a soft stop, verify gates still pass, then `sudo tailscale logout` / uninstall). Do **one host at a time** — tim last.
6. **Post-teardown verification:**
   - [ ] All step-4 gates re-run **without** any `100.x` route;
   - [ ] Deploy script dry-run over the new path (e.g. `scp`-level touch or the runbook's first command);
   - [ ] `grep -rn '100\.96\|100\.104\|100\.87\|100\.80\|100\.64' scripts/ frontend/*.spec.playwright.js .agents/skills/ docs/deployment/` → only intentional references (none functional);
   - [ ] Failover Playwright spec runs against the new host variable.

**Rollback:** `tailscale up` restores the old path at any time before logout; nothing in Wabi data/config is harmed by teardown or rollback.

## 6. Out of band — RustDesk / RDP

RustDesk on ironin has peer config pinned to the tailnet address `100.87.255.66` (`~/.config/rustdesk/peers/100.87.255.66.toml`). Teardown breaks that peer entry. Either repoint it at the post-teardown address or switch the peer to an ID-based rendezvous. This is outside `wabi` but is part of the same connectivity test the workers will run.

## 7. Explicit non-goals

- No change to Tailcat's auth model (Wabi auth still gates membership; transport only).
- No change to `WABI_TRUSTED_PROXIES` / rate-limit client-IP logic (`rate_limit.rs`) — unrelated to Tailscale.
- No claim of HA/replication changes — untouched.
- Do not hardcode any new literal IPs into scripts; use host variables or documented addresses in one place only.
