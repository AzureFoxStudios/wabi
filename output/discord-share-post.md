**WIP Communications app "Wabi"**
Hey all, I've been working on a project since around February (using a mix of AI tools, mostly Claude Code, plus GPT/Hermes) I dub "Project Wabi". Your standard communications service but self-hostable. It's MIT-licensed FOSS because I want this to be seen as a tool and not a service. I still have my list of things I'm working on (i.e. desktop applications), but it's cleaned up enough that I thought I'd share it, especially if it can help people now. There's an add-on system so you can add on to the app as well (opt-in and off by default; plugins aren't sandboxed yet, so only install ones you trust). I've had people come and go to help me, but it's primarily been a tinkering project of mine. Hope this helps anybody while it's in a WIP-testable phase.

Security/data, since it's self-hosted:
- Whoever runs the server can read public channels, metadata and stored data. Nothing is sent back to me.
- New DMs/groups use experimental encryption no outside expert has reviewed. Don't rely on it for anything sensitive.
- The server fetches link previews; the 3D viewers load libraries from esm.sh.
- Pre-release installers on the Releases page are unsigned and untested on real devices.

Feel free to look at it: https://github.com/AzureFoxStudios/wabi
