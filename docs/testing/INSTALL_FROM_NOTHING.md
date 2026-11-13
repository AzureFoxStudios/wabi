# Install from nothing: what it takes today

**Measured:** 2026-11-13, on `main` at `af4cc3e`, in a cloud Linux sandbox (x86_64, running as root, Rust 1.93.1, Node 22.23.4, Docker client without a daemon).
**Automated check:** `core/crates/wabi-server/tests/install_from_nothing_contract.rs` (runs in the `cargo test --workspace` step of CI).
**Updated:** 2026-11-13, after browser invitations (branch `claude/browser-invites`): product friction item 1 is done and stage 3 is restated below. Only stage 3 was re-run (in a browser, by `frontend/scripts/browser-invites-smoke.mjs`); the other stages are as first measured.

This page is the measurement behind [VISION.md](../VISION.md) point 2, "Easy to set up": a person who is not a system administrator gets from a blank machine to a running server with a friend invited, without a manual. It follows the install guide literally and writes down what happened. It does not soften the result.

## How it was done

I acted as someone who is not a system administrator: I followed [INSTALL.md](../deployment/INSTALL.md) (and the pages it and the README send you to) in order, typed only what they say, and wrote down every place I had to guess. The goal had five milestones:

1. **Running** — the server answers on its address.
2. **Owner** — an owner account exists.
3. **Friend** — a second person has joined **by invitation**, and the two have exchanged a message in a channel and in a DM.
4. **Backup** — a backup exists.
5. **Restored** — the backup is restored into an empty directory, a server starts on it, and the message is there.

The guide text quoted below is the text **before** this change. Where this change fixes the guide, it says so.

### How the counts are made

- **Command:** one line typed into a terminal, including `cd` and pressing Ctrl+C. Prerequisite installs are counted separately because they depend on the operating system.
- **File:** a file the person must create or edit by hand.
- **Decision:** a value the person must invent, choose or look up. Decisions marked **(guess)** are places where the guide is silent or wrong and the person has to work it out themselves.
- Clicks in a browser are listed but not counted as commands.

## Summary

| Path | Commands | Files | Decisions (of which guesses) | Reached in this sandbox |
|---|---|---|---|---|
| Binary built from source (INSTALL.md "Preferred: Rust / cargo path") | **26** (was 28), plus at least 4 prerequisite installs | **0** on a LAN; at least 1 (a Caddyfile) for a friend on the internet | **25 (11)** (was 27 (14)) | All five milestones, with the exceptions listed under each stage |
| Docker Compose (README, FRESH_INSTALL.md, INSTALL.md "Docker") | **20** (was 22), plus installing Docker | **0** on a LAN; at least 1 for the internet | **19 (5)** (was 21 (8)) | **None** — no Docker daemon in the sandbox |
| Downloaded release binary | — | — | — | **The guide offers no such path.** INSTALL.md never mentions a download. The newest GitHub release (v0.2.2, 2026-01-12) is not referenced anywhere in the guide and was not evaluated. |
| Desktop app hosting (Tauri `/host` screen) | — | — | — | Not measured: the guide does not offer it as a server install, it is built from source (`bun run desktop:build`), and it needs a desktop session. It was the only place with an invitation button until browser invitations. |

**Required environment variables: 0. Required files before first start: 0.** Both are now a budget in the automated test.

What the numbers mean in plain terms: the server itself is close to "one command and done" — no configuration file, no secrets to generate, no database to set up. Almost all the effort is around it: building it (no prebuilt download), inviting someone (impossible from the browser when measured; **now Settings › Admin › Invite someone**), putting it on the internet with HTTPS (not described), and backup/restore (described for Docker only, restore as prose only).

## Path 1: binary built from source

### Stage 1 — running

| # | What the person types | Source | Notes |
|---|---|---|---|
| — | install Git, Node.js 22, Rust (rustup), a C compiler/linker | README "Bare Cargo" | **INSTALL.md is silent.** The README says "install the system build dependencies for your platform" without naming them **(guess)**. Node 22 is not in most distributions' default packages, so the person must choose an install method **(guess)**. At least 4 commands; not run here (the sandbox had them). |
| 1 | `git clone https://github.com/AzureFoxStudios/wabi.git` | README | **Not in INSTALL.md.** Not run (already checked out). |
| 2 | `cd wabi` | README | |
| 3 | `cd frontend` | INSTALL.md | |
| 4 | `npm ci --no-audit --no-fund` | INSTALL.md | **Failed here:** `403 Forbidden - GET https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. One dependency is downloaded from that CDN rather than the npm registry; the sandbox proxy refuses it. A person behind a strict proxy hits the same wall. |
| 5 | `STATIC_BUILD=1 npm run build` | INSTALL.md | **Not run** (step 4 failed). |
| 6 | `cd ../` | INSTALL.md | |
| 7 | `cargo build --locked --release -p wabi-server` | INSTALL.md | **Not run as written.** I built the debug profile (`cargo build -p wabi-server`, 4 min 19 s) to save disk; same source, different optimisation. A first release build takes longer. |
| 8 | `mkdir -p data/wabi-server uploads plugins` | INSTALL.md | **Unnecessary.** The server creates its data directory; `uploads/` and `plugins/` are unused by default. The automated test starts from a completely empty directory. **Removed from the guide in this change.** |
| 9 | `./target/release/wabi-server --data-dir ./data/wabi-server --host 0.0.0.0 --port 3000` | INSTALL.md | Ran (debug binary). The terminal then shows **nothing at all**: no address, no "ready". Logs go to `./logs/wabi-server.log.<date>`, which the guide did not mention. The terminal is now occupied; the person needs a second one for the checks **(guess)**. Nothing says how to keep it running after logging out **(guess)**. |
| 10 | `curl -s http://127.0.0.1:3000/health` | INSTALL.md | Ran: `{"status":"ok",...}`. |
| 11 | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/` | INSTALL.md | Ran: `200` — **with no frontend built**. The guide says "expect 200 + HTML", but this command only prints the code, and the server answers `200` with an empty body when the frontend is missing (`app_router.rs`, `composed_index_html`). Pitfall 1 said the page would be 404; it is not. **The documented check passes on a broken install (guess: is it working?).** Fixed in the guide: the check now greps for `<!doctype html`. |

Stage 1: **11 commands** (+ ≥4 prerequisites), **0 files**, **4 decisions, all guesses** (build dependencies, Node install method, second terminal, whether the `/` check really passed).

### Stage 2 — owner

| # | Action | Notes |
|---|---|---|
| browser | open the server address | **INSTALL.md never says to open a browser or which address (guess).** The README says `http://localhost:3000`. From another computer it is `http://<machine address>:3000`, which the person must look up. |
| browser | setup screen 1: username, password, starter rooms | Not run in a browser (no frontend build here). The same HTTP call the screen makes, `POST /api/auth/register`, was run: the first account became owner (`isOwner: true`). |
| browser | setup screen 2: **Open** or **Closed**, allow guests | Not run in a browser. |

Stage 2: **0 commands**, **0 files**, **6 decisions (1 guess)**: address (guess), username, password, starter rooms (default is fine), Open/Closed, guests.

### Stage 3 — a friend joins by invitation; messages

What I found, in order:

- **The browser app has no way to create an invitation.** The only caller of the invitation API in the frontend is the desktop app's hosting screen (`frontend/src/routes/host/+page.svelte`, through a Tauri command). INSTALL.md did not mention invitations at all.
- **The setup screen offers no "invite only".** It offers Open (anyone who can reach the server registers, invitation or not) or Closed (nobody registers, invitations included).
- **The default was open registration.** With no admission policy saved, a third account (`stranger`) registered here with no invitation at all. (Since changed: such a server is now invite only; see item 2.)
- **An invitation link is refused in the browser over plain HTTP unless the address is `localhost` or a private LAN address** (`frontend/src/lib/hostInvites.ts`). A friend on the internet therefore needs HTTPS: INSTALL.md says only "point Caddy (or cloudflared) at 127.0.0.1:3000. Edit Caddyfile + .env" — no Caddyfile, no domain or DNS steps, no firewall/port step.

So "joined by invitation" is reachable only by reading the source:

| # | What the person types | Notes |
|---|---|---|
| 12 | `curl ... /api/auth/login ...` (owner's name and password in JSON) | **Guess:** found by reading `core/crates/wabi-server/src/api/invites.rs` and `auth.rs`. The password lands in shell history. Ran here. |
| 13 | `curl ... /api/invites -H "authorization: Bearer ..." -d '{"expiresInHours":24}'` | **Guess.** Ran: one-use token returned. |
| — | build the link `http://<address>:3000/join#invite=<token>` by hand | **Guess:** link format found in `hostInvites.ts`. The friend's `/join` page was not run (no frontend). |
| friend, browser | open the link, choose username and password | The same call the page makes (`POST /api/auth/register` with `inviteToken`) was run: accepted; a second use of the token was refused. |
| both, browser | open `general`, send a message | Run over HTTP: both messages read back by both people. |
| both, browser | open a DM and send a message | New DMs start **encryption pending**. The server refused plain text until each sender separately chose the server-readable fallback (`POST /api/e2ee/channels/<id>/allow-server-readable`). Each person faces that choice. Run over Socket.IO (`create-dm`) and HTTP; no browser. |

This change adds the curl recipe and the plain facts above to INSTALL.md ("Inviting someone"), so the commands are no longer guesses, but they are still commands a non-administrator should not need.

Stage 3 as first measured (friend on the same LAN): **2 commands**, **0 files**, **9 decisions (4 guesses)**: discovering the invite API (guess), the link format (guess), the address the friend can reach (guess), opening the port in a firewall (guess), invitation lifetime, the friend's username and password, and the two DM fallback choices. For a friend on the internet add a domain, DNS, a TLS reverse proxy and a Caddyfile: **at least 1 more file and an unknown number of commands; not described by the guide and not run here.**

#### Stage 3 after browser invitations

What changed: the setup screen offers **Invite only** between Open and Closed and preselects it; a server with an owner and no saved policy now admits only by invitation (item 2), and **Settings › Admin › Invite someone** creates a one-use link with a lifetime, a copy button and a QR code, lists waiting invitations and cancels them. The link is built from the address the owner is using, and the page says when that address only works on the owner's network, refuses to make a link from `localhost`, and asks for HTTPS on a plain-HTTP public address. The friend's `/join` page explains used, cancelled, expired and closed-server refusals in plain words.

| # | Action | Notes |
|---|---|---|
| browser (owner) | Settings › Admin › Invite someone › Create invitation › Copy link | Replaces commands 12 and 13 and building the link by hand. |
| browser (friend) | open the link, choose username and password | Lands signed in. |
| both, browser | channel message; DM with the server-readable choice | Unchanged. |

Stage 3 now (friend on the same LAN): **0 commands**, **0 files**, **7 decisions (1 guess)**: invitation lifetime (default is fine), the address to open Wabi at so the friend can reach it (no longer a guess: the page says who the link works for), opening the port in a firewall (**guess**, unchanged), the friend's username and password, and the two DM fallback choices. For a friend on the internet HTTPS is still required and still not described (item 7).

### Stage 4 — backup

BACKUP_AND_RECOVERY.md gave only a Docker example (`docker compose stop wabi-server` ...). A binary-path person has to translate it **(guess)**. Run here, translated:

| # | Command |
|---|---|
| 14 | Ctrl+C in the server's terminal (translation of `docker compose stop`) **(guess)** |
| 15 | `mkdir -p ../wabi-backups/2026-11-13` |
| 16 | `cp -a data/wabi-server ../wabi-backups/2026-11-13/` |
| 17 | `cp -a uploads ../wabi-backups/2026-11-13/` (empty by default; uploads live inside the data directory) |
| 18 | `cp -a .env wabi.config plugins ../wabi-backups/2026-11-13/ 2>/dev/null \|\| true` |
| 19 | start command again (translation of `docker compose start`) **(guess)** |
| 20 | `curl -f http://localhost:3000/livez` |
| 21 | `curl -f http://localhost:3000/readyz` |

The backup held `jwt_secret`, `wabidb/root_key` and the sidecars (`channel_retention.json`, `join-invites-v1.json`, `server_center.json`, ...). Stage 4: **8 commands**, **0 files**, **4 decisions (2 guesses)**: where, what to call it, how to stop (guess), how to start again (guess). This change adds a binary example to BACKUP_AND_RECOVERY.md.

### Stage 5 — restore into an empty directory

"Restore onto a clean Authority" is ten prose steps with no commands. Run here, derived from the prose:

| # | Command |
|---|---|
| 22 | `mkdir -p restored/data` |
| 23 | `cp -a ../wabi-backups/2026-11-13/wabi-server restored/data/` |
| 24 | `cp -a ../wabi-backups/2026-11-13/uploads restored/` |
| 25 | `cd restored` |
| 26 | start command with `--data-dir ./data/wabi-server` |
| 27 | `curl -f http://127.0.0.1:3000/livez` → `{"service":"wabi-server","status":"ok"}` |
| 28 | `curl -f http://127.0.0.1:3000/readyz` → `{"engine":"ready","status":"ok"}` |
| browser | sign in as owner, open the channel | Run over HTTP: password login worked and the message `walkthrough message` was there. |

Stage 5: **7 commands**, **0 files**, **4 decisions (3 guesses)**: target directory, which pieces make "complete units" (guess), whether step 5 "restore ownership/permissions" needs anything (guess; it did not, same user), and that the original must be stopped or the port changed (guess). This change adds a binary restore example.

## Path 2: Docker Compose — not run

**Nothing on this path was run.** The sandbox has the Docker client but no daemon (`failed to connect to the docker API at unix:///var/run/docker.sock`). The counts below are read from the guide, not measured. CI's `container-install` job does build the image and runs `scripts/authority-compose-smoke.mjs` (fresh Compose start, owner registration, a message surviving a container restart); it does not cover invitation, backup or restore.

| Stage | Commands from the guide | Decisions |
|---|---|---|
| 1 Running | install Docker + Compose (**guide silent on how**); `git clone ...`; `cd wabi`; `docker compose up -d --build` (the guide warns ~10+ min); `curl /livez`; `curl /readyz` → **5** | 1 guess (Docker install method) |
| 2 Owner | browser at `http://localhost:3001` (README and FRESH_INSTALL say this; INSTALL.md does not) | 5 (same setup screens) |
| 3 Friend | same as Path 1 on port 3001 → **2** | 9 (4 guesses) |
| 4 Backup | the documented example: `docker compose stop wabi-server`, `mkdir`, three `cp -a`, `docker compose start wabi-server`, two `curl` → **8** | 2 |
| 5 Restore | prose only: `git clone` again (the Compose file must exist in the new directory) **(guess)**, `cd`, `mkdir -p data`, `cp -a <backup> data/wabi-server`, `docker compose up -d --build` (rebuilds the image), two `curl` → **7** | 4 (3 guesses) |

Totals: **22 commands** (+ installing Docker), **0 files**, **21 decisions (8 guesses)**.

A risk read from the code, **not run**: the container runs as UID 1000 and the generated keys are mode `0600`. A host user who is not UID 1000 (rootless Podman, a second user on the machine) cannot read `data/wabi-server/wabidb/root_key`, so the documented `cp -a data/wabi-server ...` would fail with "permission denied" and need `sudo`. On a typical single-user Linux machine the first user is UID 1000 and it would work.

## Guide errors found, and what this change does

| Found | Fixed here? |
|---|---|
| INSTALL.md cargo path had no prerequisites and no `git clone`. | Yes: prerequisites paragraph and step 0. |
| `mkdir -p data/wabi-server uploads plugins` is unnecessary. | Yes: removed; the test proves the server starts in an empty directory. |
| The `/` check prints only a status code; an install without a frontend answers `200`. Pitfall 1 said 404. | Yes: the check greps for HTML; pitfall 1 corrected. |
| The server prints nothing to its terminal and logs to `./logs`; the guide did not say so. | Yes: documented. (Printing a startup line is listed below as a product change.) |
| INSTALL.md never told the person to open a browser and create the owner. | Yes: "Create the owner" paragraph. |
| No invitation instructions anywhere in the install guides; no browser UI for them. | Guide: yes, "Inviting someone" with the facts and a tested curl recipe. Product: listed below. |
| **INSTALL.md pitfall 3 told people to remove `data/wabi-server/wabidb/.lock`.** That contradicts AGENTS.md rule 9 and BACKUP_AND_RECOVERY.md: the engine holds an OS lock on that inode, and deleting it can admit a second writer. | Yes: pitfall 3 now says never delete it, and only a legacy root `.lock` may go after every old process is stopped. |
| BACKUP_AND_RECOVERY.md had only a Docker backup example and no restore commands. | Yes: binary backup and restore examples added. |
| The README calls FRESH_INSTALL.md "canonical"; INSTALL.md did not point to it. | Yes: cross-link at the top of INSTALL.md. |
| "Prod front: point Caddy ... Edit Caddyfile + .env" gives no Caddyfile and no steps. | **No.** Writing a correct public-HTTPS recipe needs a decision about the supported edge (Caddy profile, tunnel, or both); listed below. |

## Product friction: proposed, not changed

None of these were changed in this PR. Items marked *owner* touch security or data-location defaults and need the owner's decision.

1. **Done (browser invitations).** ~~No invitation button in the browser app, and no "invite only" on the setup screen.~~ Was: add "Create invitation" to the owner's settings (the API, `POST /api/invites`, already exists and is owner-only) and an "Invite only" choice to the setup screen (the `invite` mode already exists in `auth_policy`).
2. **Done (owner decided 2026-11-13: invite only).** The setup screen preselects Invite only, and a server with an owner and no saved policy now refuses registration without an invitation ("This server is invite only. Ask the server owner for an invitation link."), with guests refused too; a saved Open/Closed/Invite policy is always respected and the first (owner) account is created as before (`first_boot_onboarding.rs`, `unsaved_admission_policy_is_invite_only_once_an_owner_exists`). Was: **Registration is open by default** (*owner*). With no policy saved, anyone who can reach the server registers. Once (1) exists, consider making the setup screen's default "Invite only". Not changed: it is an admission/security default.
3. **No prebuilt server.** Every path compiles Rust and the frontend (≥10 minutes, a toolchain, and an npm dependency fetched from `cdn.sheetjs.com`). Publish the container image to a registry so Compose pulls instead of builds, and/or attach `wabi-server` binaries to releases, and say so in the guide.
4. **Silent terminal, misleading empty page.** Print one line at startup with the address to open, the data directory, the log file and "the first account becomes the owner". Answer `503` with a plain message instead of an empty `200` when the frontend was not built.
5. **Backup and restore are 8 and 7 hand-typed commands.** A `wabi-server backup <dir>` / `wabi-server restore <backup> <new-dir>` pair that takes the engine lock, refuses a running server and copies the whole data directory would make each one command. (`wabi-instance-snapshot export/restore` exists but needs an age key pair and the uploads path; it is not a beginner's path.)
6. **Logs land in `./logs` relative to wherever the server was started** (*owner*, data location), outside the data directory. Defaulting to `<data-dir>/logs` would keep one directory per server.
7. **Public HTTPS has no recipe.** A Compose profile that runs Caddy with automatic certificates from one `WABI_DOMAIN` value would turn an undocumented stage into one command (at the cost of one optional variable).
8. **Docker file ownership** (*owner*, data location): keys owned by UID 1000 at mode 0600 can make the documented `cp -a` fail for other host users. At least document `sudo cp -a`; a backup command (5) would remove the problem.
9. **No service unit for the binary path.** Ship an example systemd unit.

## The five changes that would remove the most steps

Ranked by steps removed from the journey above (commands + decisions, guesses weighted as decisions):

1. **Done:** **Invitation button in the browser app plus "Invite only" on the setup screen** — removes the 2 source-reading curl commands and 4 guesses, and makes the "friend by invitation" milestone possible at all on a Docker or binary install. (Item 1.) Restated after the change: 2 commands, 2 decisions and 3 guesses removed (the firewall guess remains).
2. **A prebuilt server: registry image and release binaries** — removes the prerequisite installs (≥4), `git clone`, the frontend build (4 commands and the CDN dependency) and the Rust build: about 8 commands and 4 guesses on the binary path; on Compose it removes the 10-minute `--build` and the re-clone on restore. (Item 3.)
3. **`wabi-server backup` / `restore` commands** — 15 commands become about 2, and removes 5 guesses (how to stop, which pieces, ownership, ports). (Item 5.)
4. **One-command public HTTPS** (Compose Caddy profile with `WABI_DOMAIN`) — replaces an undocumented stage (a Caddyfile, DNS, certificates, firewall) with one command and one value; without it a friend on the internet cannot use an invitation link at all. (Item 7.)
5. **A startup line and an honest missing-frontend page** — removes 3 guesses (is it running, where is it, did the check pass) and the second terminal. (Item 4.)

## The automated test

`core/crates/wabi-server/tests/install_from_nothing_contract.rs`, chosen over extending the `container-install` job because it needs no Docker daemon, runs in the existing `cargo test --workspace` step, and uses the real binary Cargo just built (`CARGO_BIN_EXE_wabi-server`), as `first_boot_onboarding.rs` and `recovery_node_contract.rs` already do. It uses only the command line, the HTTP API and Socket.IO polling, on loopback, with no browser or GPU.

It starts the binary with `env_clear()` in an empty directory, then: owner registration; `POST /api/invites`; registration with the invitation (and refusal of a second use); both people post and read in `general`; a DM opened over Socket.IO, reported by the server as `pendingDefault: true`, plain text refused until each sender chooses server-readable, then exchanged; Ctrl+C (SIGINT), `cp -a` of the data directory, restart of the original, `cp -a` of the backup into a new empty directory, start, password sign-in, and both the channel and DM messages read back.

**Budget:** `REQUIRED_ENV` (0 entries, budget 0) and `REQUIRED_FILES` (0 entries, budget 0). The server is launched with exactly `REQUIRED_ENV` and an install directory holding exactly `REQUIRED_FILES`, so a new requirement fails the test until someone adds it to the list, which then fails the budget until someone raises it in a commented edit. Checked: adding one variable fails with `required environment variables (["WABI_EXAMPLE"]) exceed the install budget of 0`.

Differences from a person, all for running safely in CI: `--host 127.0.0.1 --port 0 --print-bound-address` instead of `0.0.0.0:3000`; the embedded frontend is not checked (the Compose smoke does that).

Run: `cargo test -p wabi-server --test install_from_nothing_contract` (passed here in 4.4 s).

## Not run here

- Anything with Docker or Compose (no daemon).
- The frontend build (`npm ci` refused by the sandbox proxy), so **no browser step was run** in the first measurement: the setup screens, the `/join` page, sending messages from the UI. Each was replaced by the HTTP call the page makes. Since then the setup screen's join choice, creating an invitation and the `/join` page have run in headful Chromium (`frontend/scripts/browser-invites-smoke.mjs`, in the Core Browser Smokes workflow); sending messages from the UI is covered by other smokes, not by this measurement.
- A release build (a debug build was used).
- Prerequisite installation and `git clone` (already present).
- Any second machine, LAN address, firewall, public DNS, TLS or reverse proxy.
- The desktop app's hosting and invitation screen.
- A person who is not a system administrator. This is one careful reading by an agent; a real first-time user will find things this page missed.
