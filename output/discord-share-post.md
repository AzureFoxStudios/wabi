**Wabi: a self-hosted chat + collaboration workspace for small communities (built with Claude Code)**

**What it is**
A free, open-source (MIT) app you run on your own server for a friend group, studio, class or project team. One Rust binary serves the API, realtime chat, web app and its own embedded database, so there's no separate database to set up.

**What it does**
Channels, DMs and groups, voice/video/screen share, whiteboards, wiki and notes, files, and read-only CAD/3D model review (DXF, STEP, 3MF) with markup. Servers are independent: they don't federate or share accounts.

**How Claude helped**
I built it with Claude Code. I'm still fairly new to a lot of this, so I set the direction, test and review, and Claude does much of the implementation and testing across the Rust server, storage engine and SvelteKit frontend. An AGENTS.md of project rules keeps sessions consistent.

**Try it**
```
git clone https://github.com/AzureFoxStudios/wabi.git
cd wabi && docker compose up -d --build
```
Then open http://localhost:3001 and create the owner account.

**Security and data**
- Whoever runs a server can read its public channels, metadata and stored data. No central account, and nothing is sent back to me.
- New DMs/groups use **experimental** encryption: tested in the project, **not reviewed by an outside security professional**, and an operator who modifies their server could still read them. Don't use it for anything sensitive.
- The server fetches link previews for posted URLs. The 3D/CAD viewers load three.js/OpenCascade from esm.sh.
- Optional add-ons (TURN, LiveKit, Tailcat, translation, plugins) are off by default. Plugins are **not sandboxed**.
- Under active development. See `docs/PROJECT_STATUS.md` for what's stable.

Feedback welcome, especially on self-hosting setup.
