**Wabi: a self-hosted chat + collaboration workspace for small communities (built with Claude Code)**

**What it is**
A free, open-source (MIT) app you run on your own server for a friend group, studio, class or project team. One Rust binary serves the API, realtime chat, web app and its own embedded database.

**What it does**
Channels, DMs and groups, voice/video/screen share, whiteboards, wiki, notes, files, and read-only CAD/3D model review with markup. Servers are independent: no federation or shared accounts.

**How Claude helped**
I built it with Claude Code. I'm still fairly new to a lot of this, so I set the direction, test and review, and Claude does much of the implementation and testing across the Rust server, storage engine and SvelteKit frontend. An AGENTS.md of project rules keeps sessions consistent.

**Try it**
Repo: https://github.com/AzureFoxStudios/wabi
Server: clone it, run `docker compose up -d --build`, open http://localhost:3001
Desktop/Android pre-release builds are on the Releases page.

**Security and data**
- Whoever runs a server can read its public channels, metadata and stored data. Nothing is sent back to me.
- New DMs/groups use **experimental** encryption, **not reviewed by an outside security professional**. An operator who modifies their server could still read them. Don't use it for anything sensitive.
- The server fetches link previews for posted URLs. The 3D viewers load libraries from esm.sh.
- Installers are **not code-signed**, so Windows/macOS will warn you (macOS builds are untested). The APK is a debug build. Check downloads against SHA256SUMS.
- The desktop app stores your login in the OS keychain, reads only folders you grant it, and checks GitHub for signed updates only when you click.
- Optional add-ons are off by default. Plugins are **not sandboxed**.
- Pre-release software. See `docs/PROJECT_STATUS.md`.
