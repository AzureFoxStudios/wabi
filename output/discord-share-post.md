Hello all, here's an early look at my project "Wabi", a self-hostable collaboration workspace. I started around February with all the chaos on Discord. Standard FOSS (MIT). One Rust binary serves the API, realtime chat and an embedded database.

Channels/DMs/Groups. Voice/video/screen share, with optional LiveKit for bigger calls. There's also an opt-in add-on system, kind of like Blender's, still being hardened.
You can keep a list of servers you connect to, but each server is owned by whoever hosts it. My hope is anybody wanting a full alternative to Discord can use this as a tool to build their own service.

I'm not a pro dev, so I've leaned on AI tools throughout: mostly Claude Code, plus ChatGPT, Hermes and a few others over the months. I plan, test and review; the AI does a lot of the code. A rules file (AGENTS.md) keeps every tool on the same page.

Security and data
* Whoever runs a server can read its public channels, metadata and stored data. Nothing is sent back to me.
* New DMs/groups use experimental encryption, not reviewed by an outside security professional. An operator who modifies their server could still read them. Don't use it for anything sensitive.
* The server fetches link previews for posted URLs. The 3D viewers load libraries from esm.sh.
* Installers are not code-signed, so Windows/macOS will warn you (macOS builds are untested). The APK is a debug build. Check downloads against SHA256SUMS.
* The desktop app stores your login in the OS keychain, reads only folders you grant it, and checks GitHub for signed updates only when you click.
* Optional add-ons are off by default. Plugins are not sandboxed.

If you want to try it: https://github.com/AzureFoxStudios/wabi -> docker compose up -d --build. Untested pre-release installers are on the Releases page; proper no-CLI builds are coming.

It's mostly been a solo project with a few people dropping in. If you genuinely know Rust or realtime web comms and want to help, I'd be happy to talk.
